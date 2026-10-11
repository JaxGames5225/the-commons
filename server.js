const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false } });
const { randomUUID } = require('node:crypto');
const MAX_SITE_CODE = 150000;
const MAX_ACTIVE_BUILDS = 2;
const MAX_QUEUED_BUILDS = 30;
const JOB_TTL_MS = 30 * 60 * 1000;
const buildQueue = [];
const buildJobs = new Map();
let activeBuilds = 0;

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '160kb' }));

const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const css = `*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff;font-family:Arial,sans-serif}#canvas{position:fixed;inset:0;background:#fff}#canvas-frame{display:block;width:100%;height:100%;border:0;background:transparent}.prompt{position:fixed;z-index:10;left:50%;bottom:28px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(680px,calc(100vw - 28px));height:62px;padding:7px 8px 7px 18px;background:rgba(255,255,255,.96);border:1px solid #e5e5e5;border-radius:16px;box-shadow:0 10px 38px #00000017,0 2px 8px #0000000a;backdrop-filter:blur(14px);overflow:hidden}.prompt:focus-within{border-color:#bcbcbc;box-shadow:0 0 0 3px #00000008,0 12px 40px #00000018}.prompt input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:#151515;font:15px Arial,sans-serif}.prompt input::placeholder{color:#9b9b9b}.prompt button{position:relative;display:grid;place-items:center;flex:none;width:46px;height:46px;border:0;border-radius:11px;padding:0;background:#191919;color:#fff;font:600 19px Arial,sans-serif;cursor:pointer}.prompt button:disabled{opacity:.75}.prompt[data-state]:after{content:'';position:absolute;left:0;bottom:0;width:32%;height:2px;background:linear-gradient(90deg,transparent,#777,#111,transparent);animation:build-progress 1.25s ease-in-out infinite}.prompt[data-state] button{font-size:0}.prompt[data-state] button:after{content:'';width:16px;height:16px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:build-spin .8s linear infinite}.prompt[data-state='queued'] button:after{border-top-color:#bcbcbc}.prompt[data-state='queued']{border-color:#d8d8d8}.prompt-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes build-spin{to{transform:rotate(360deg)}}@keyframes build-progress{0%{transform:translateX(-110%)}100%{transform:translateX(340%)}}@media(prefers-reduced-motion:reduce){.prompt[data-state]:after,.prompt[data-state] button:after{animation-duration:3s}}@media(max-width:600px){.prompt{bottom:16px;height:58px;width:calc(100vw - 20px);border-radius:14px}.prompt button{height:44px;width:44px}}`;
const shell = content => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Commons</title><style>${css}</style></head><body>${content}<script src="/app.js" defer></script></body></html>`;

function errorText(code) {
  return ({key:'AI key needed — add OPENAI_API_KEY in Railway Variables',auth:'AI key is invalid — check OPENAI_API_KEY in Railway Variables',busy:'The builder is busy or the shared site is too large — try again shortly',failed:'Could not build that. Try again'})[code] || '';
}

function initialSiteCode(legacyPages) {
  const canvas = legacyPages.find(page => page.slug === 'canvas');
  let body = canvas?.body || '';
  const subpages = legacyPages.filter(page => page.slug !== 'canvas');
  for (const page of subpages) {
    const slug = String(page.slug).replace(/[^a-z0-9-]/gi, '');
    body += `<section id="page-${slug}"><h1>${escapeAttr(page.title)}</h1>${page.body || ''}</section>`;
  }
  for (const page of subpages) {
    const slug = String(page.slug).replace(/[^a-z0-9-]/gi, '');
    body = body.replaceAll(`/p/${page.slug}`, `#page-${slug}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Commons</title></head><body>${body}</body></html>`;
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Add a reference to your PostgreSQL service in Railway.');
  await pool.query(`CREATE TABLE IF NOT EXISTS commons_site (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    code TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows: existing } = await pool.query('SELECT 1 FROM commons_site WHERE id=1');
  if (existing.length) return;

  // One-time migration: fold the old canvas and any subpages into one HTML document.
  const { rows: tables } = await pool.query("SELECT to_regclass('public.pages') AS pages_table");
  let code = initialSiteCode([]);
  if (tables[0]?.pages_table) {
    const { rows: legacyPages } = await pool.query('SELECT slug,title,body FROM pages ORDER BY created_at, id');
    if (legacyPages.length) code = initialSiteCode(legacyPages);
  }
  await pool.query('INSERT INTO commons_site(id,code) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [code]);
}

function renderCanvas(code, error='') {
  const frame = `<iframe id="canvas-frame" title="Shared website" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttr(lockHtml(code))}"></iframe>`;
  return shell(`<main id="canvas">${frame}</main><form class="prompt" method="post" action="/contribute"><input name="idea" maxlength="2000" required placeholder="${escapeAttr(error || 'Add or change anything on the shared site…')}" aria-label="Describe what to build"><span class="prompt-status" role="status" aria-live="polite" aria-atomic="true"></span><button aria-label="Build">↗</button></form>`);
}

app.get('/health', (_req,res) => res.send('ok'));
app.get('/style.css', (_req,res) => res.type('text/css').send(css));
app.get('/app.js', (_req,res) => res.type('application/javascript').send(`(()=>{const form=document.querySelector('.prompt'),input=form?.querySelector('input[name=idea]'),button=form?.querySelector('button'),statusText=form?.querySelector('.prompt-status');if(!form||!input||!button)return;const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));function setStatus(state,message){form.dataset.state=state;form.setAttribute('aria-busy','true');if(statusText)statusText.textContent=message;input.placeholder=message;button.setAttribute('aria-label',message)}function restore(idea,message){delete form.dataset.state;form.removeAttribute('aria-busy');input.readOnly=false;input.value=idea;input.placeholder=message;button.disabled=false;button.textContent='↗';button.setAttribute('aria-label','Build');input.focus()}form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;const idea=input.value.trim();if(!idea)return;button.disabled=true;input.readOnly=true;input.value='';setStatus('sending','Sending your idea…');try{const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({idea})});const data=await response.json();if(!response.ok)throw new Error(data.message||'Could not queue that request. Try again.');setStatus('queued','In the queue — getting your change ready…');for(;;){await sleep(1800);const statusResponse=await fetch(data.statusUrl,{headers:{'Accept':'application/json'},cache:'no-store'});if(!statusResponse.ok)throw new Error('Could not check the build status. Your prompt is still here.');const status=await statusResponse.json();if(status.state==='queued')setStatus('queued',status.position>1?'In the queue — '+status.position+' builds ahead':'In the queue — you’re next');else if(status.state==='building')setStatus('building','Building your change…');else if(status.state==='done'){setStatus('building','Publishing your change…');window.location.replace('/');return}else if(status.state==='failed')throw new Error(status.message||'Could not build that. Try again.')}}catch(error){restore(idea,error.message||'Could not build that. Try again.')}})})();`));
app.get('/contribute', (_req,res) => res.redirect(303,'/'));
app.get('/builds/:id', (req,res) => {
  const job=buildJobs.get(req.params.id);
  if(!job)return res.status(404).json({state:'failed',message:'That build expired. Please send the request again.'});
  if(job.state==='queued')return res.json({state:job.state,position:buildQueue.indexOf(job)+1});
  res.json({state:job.state,message:job.message});
});
app.get('/',async(req,res)=>{
  try { const {rows}=await pool.query('SELECT code FROM commons_site WHERE id=1');res.type('html').send(renderCanvas(rows[0]?.code||initialSiteCode([]),errorText(req.query.error))); }
  catch(e){console.error(e);res.status(500).type('html').send(renderCanvas(initialSiteCode([]),'The canvas is loading — try again'));}
});

app.post('/contribute',async(req,res)=>{
  const idea=String(req.body.idea||'').trim().slice(0,2000);
  if(!idea)return res.status(400).json({message:'Type something to add or change first.'});
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({message:errorText('key')});
  buildJobs.forEach((job,id)=>{if(Date.now()-job.createdAt>JOB_TTL_MS&&job.state!=='queued'&&job.state!=='building')buildJobs.delete(id);});
  if(buildQueue.length>=MAX_QUEUED_BUILDS)return res.status(503).json({message:'The Commons is busy right now. Your request is still in the box — try sending it again in a moment.'});
  const job={id:randomUUID(),idea,createdAt:Date.now(),state:'queued',message:''};
  buildJobs.set(job.id,job);buildQueue.push(job);drainBuildQueue();
  res.status(202).json({statusUrl:`/builds/${job.id}`});
});

function drainBuildQueue(){
  while(activeBuilds<MAX_ACTIVE_BUILDS&&buildQueue.length){
    const job=buildQueue.shift();activeBuilds++;job.state='building';
    processBuild(job).finally(()=>{activeBuilds--;drainBuildQueue();});
  }
}

async function processBuild(job){
  try{
    // Rebuild against the newest revision after a concurrent edit wins the save race.
    for(let attempt=0;attempt<5;attempt++){
      const {rows}=await pool.query('SELECT code,revision FROM commons_site WHERE id=1');
      const current=rows[0];
      if(!current)throw new Error('The shared website is not ready. Please try again.');
      if(current.code.length>MAX_SITE_CODE)throw Object.assign(new Error(errorText('busy')),{publicCode:'busy'});
      const code=await generateSite(job.idea,current.code);
      if(code.length>MAX_SITE_CODE)throw Object.assign(new Error(errorText('busy')),{publicCode:'busy'});
      const saved=await pool.query('UPDATE commons_site SET code=$1,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$2 RETURNING revision',[code,current.revision]);
      if(saved.rowCount){job.state='done';job.message='';return;}
    }
    throw Object.assign(new Error('Lots of people are editing right now. Please try your request again.'),{publicCode:'busy'});
  }catch(e){
    console.error('AI build failed:',e);
    job.state='failed';job.message=e.publicCode==='auth'?'The AI connection needs attention. Please try again later.':e.publicCode==='busy'?e.message:'Could not build that. Your prompt is still here — try again.';
  }
}

async function generateSite(idea,currentCode){
  const schema={type:'object',additionalProperties:false,properties:{html:{type:'string'}},required:['html']};
  const systemPrompt=`You are editing The Commons, one shared website collaboratively changed by all visitors. The current website source is the complete shared state. The visitor's request is an edit instruction: you may add, move, rewrite, or remove any part of the existing site so it best satisfies that request. Anyone may change anyone else's work; don't preserve sections just because somebody else made them.

Return the COMPLETE website as one valid HTML document, including <!doctype html>, <html>, <head>, and <body>. Do not return a patch or explanation. Keep styling nearly absent by default: use plain browser-default HTML, no colors, cards, decorative spacing, animations, or visual polish unless the visitor explicitly requests styling/design. Prioritize the requested content and behavior.

Editing rules:
- If the visitor asks to change something that already exists, find and edit that part instead of making a duplicate.
- If they ask for another page, create a distinct in-document page section with a stable, unique id and add a clear link to it from a relevant existing page.
- Treat those sections as subpages: use hash links such as href="#page-about" and make navigation work without a server route. If the site already has a page/navigation pattern, extend that pattern.
- Keep unrelated existing pages and working features intact. Anyone may edit or remove any part of the shared website when their request calls for it.

The whole website is stored as this single document. Use only inline HTML, CSS, and JavaScript; no external assets, fonts, scripts, network requests, forms that submit, or tracking. Keep scripts self-contained. The output runs in a sandboxed iframe without access to the host page, cookies, storage, or network. Do not add credential collection or payment flows.`;
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-6-luna',reasoning:{effort:'none'},store:false,max_output_tokens:12000,input:[{role:'system',content:systemPrompt},{role:'user',content:`CURRENT COMPLETE WEBSITE SOURCE:\n${currentCode}\n\nREQUESTED EDIT:\n${idea}`}],text:{format:{type:'json_schema',name:'commons_site_edit',strict:true,schema}}})});
  if(!response.ok){const detail=await response.text();console.error('OpenAI response:',response.status,detail.slice(0,1000));const e=new Error('OpenAI request failed');e.publicCode=response.status===401?'auth':response.status===429?'busy':'failed';throw e;}
  const payload=await response.json();
  const outputText=payload.output_text||payload.output?.flatMap(item=>item.content||[]).filter(part=>part.type==='output_text'&&typeof part.text==='string').map(part=>part.text).join('');
  if(!outputText){const reason=payload.incomplete_details?.reason||payload.error?.message||payload.status||'no text output';console.error('OpenAI returned no output text:',reason,JSON.stringify(payload.output||[]).slice(0,1200));throw new Error(`No generated website returned (${reason})`);}
  const result=JSON.parse(outputText), code=String(result.html||'').trim();
  if(!code||code.length>MAX_SITE_CODE||!/<html\b/i.test(code)||!/<head\b/i.test(code)||!/<body\b/i.test(code))throw new Error('Invalid complete website returned');
  return code;
}

function lockHtml(code){
  const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";
  const lock=`<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if(/<head\b[^>]*>/i.test(code))return code.replace(/<head\b[^>]*>/i,match=>match+lock);
  return code.replace(/<html\b[^>]*>/i,match=>match+`<head>${lock}</head>`);
}

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).send('Something went wrong.');});
initDb().then(()=>app.listen(port,()=>console.log(`Commons listening on ${port}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
