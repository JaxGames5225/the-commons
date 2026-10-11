const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false } });

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Add a reference to your PostgreSQL service in Railway.');
  await pool.query(`CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS pages (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES members(id), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS contributions (id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES members(id), page_id INTEGER REFERENCES pages(id), action TEXT NOT NULL, summary TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS reports (id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES members(id), contribution_id INTEGER REFERENCES contributions(id), reason TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_slug TEXT REFERENCES pages(slug) ON DELETE SET NULL');
  await pool.query("INSERT INTO pages(slug,title,body) VALUES('canvas','Canvas','') ON CONFLICT(slug) DO NOTHING");
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slugify = value => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'new-page';
const css = `*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff;font-family:Arial,sans-serif}#canvas{position:fixed;inset:0;background:#fff}#canvas-frame{display:block;width:100%;height:100%;border:0;background:transparent}.prompt{position:fixed;z-index:10;left:50%;bottom:28px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(680px,calc(100vw - 28px));height:62px;padding:7px 8px 7px 18px;background:rgba(255,255,255,.96);border:1px solid #e5e5e5;border-radius:16px;box-shadow:0 10px 38px #00000017,0 2px 8px #0000000a;backdrop-filter:blur(14px)}.prompt:focus-within{border-color:#bcbcbc;box-shadow:0 0 0 3px #00000008,0 12px 40px #00000018}.prompt input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:#151515;font:15px Arial,sans-serif}.prompt input::placeholder{color:#9b9b9b}.prompt button{height:46px;border:0;border-radius:11px;padding:0 19px;background:#191919;color:#fff;font:600 13px Arial,sans-serif;cursor:pointer}.prompt button:disabled{opacity:.65}@media(max-width:600px){.prompt{bottom:16px;height:58px;width:calc(100vw - 20px);border-radius:14px}.prompt button{height:44px;padding:0 15px}}`;
const shell = content => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Commons</title><style>${css}</style></head><body>${content}<script src="/app.js" defer></script></body></html>`;
function errorText(code) {
  return ({key:'AI key needed — add OPENAI_API_KEY in Railway Variables',auth:'AI key is invalid — check OPENAI_API_KEY in Railway Variables',limit:'Please wait a little before building again',busy:'The builder is busy — try again shortly',failed:'Could not build that. Try again'})[code] || '';
}
function renderCanvas(html, pageSlug, error='') {
  const frame = html ? `<iframe id="canvas-frame" title="Shared canvas" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${esc(lockHtml(html))}"></iframe>` : '';
  const hidden = pageSlug ? `<input type="hidden" name="page" value="${esc(pageSlug)}">` : '';
  return shell(`<main id="canvas">${frame}</main><form class="prompt" method="post" action="/contribute">${hidden}<input name="idea" maxlength="500" required placeholder="${esc(error || 'Add anything to the canvas…')}" aria-label="Describe what to build"><button aria-label="Build">↗</button></form>`);
}

app.get('/health', (_req,res) => res.send('ok'));
app.get('/style.css', (_req,res) => res.type('text/css').send(css));
app.get('/app.js', (_req,res) => res.type('application/javascript').send(`document.querySelector('.prompt')?.addEventListener('submit',()=>{const b=document.querySelector('.prompt button'),i=document.querySelector('.prompt input[name=idea]');if(b){b.disabled=true;b.textContent='…'}if(i)i.readOnly=true});window.addEventListener('message',e=>{const frame=document.querySelector('#canvas-frame');if(!frame||e.source!==frame.contentWindow||e.data?.type!=='commons:navigate')return;const path=String(e.data.path||'');if(/^\/p\/[a-z0-9-]+$/.test(path))location.assign(path)});`));
app.get('/',async(req,res)=>{
  try { const {rows}=await pool.query("SELECT body FROM pages WHERE slug='canvas'");res.type('html').send(renderCanvas(rows[0]?.body||'','canvas',errorText(req.query.error))); }
  catch(e){console.error(e);res.status(500).type('html').send(renderCanvas('','canvas','The canvas is loading — try again'));}
});
app.get('/p/:slug',async(req,res)=>{
  try { const {rows}=await pool.query('SELECT slug,body FROM pages WHERE slug=$1',[req.params.slug]);if(!rows[0])return res.status(404).type('html').send(renderCanvas('','', 'This page is not here'));res.type('html').send(renderCanvas(rows[0].body,rows[0].slug,errorText(req.query.error))); }
  catch(e){console.error(e);res.status(500).type('html').send(renderCanvas('','', 'The canvas is loading — try again'));}
});

const promptHits = new Map();
app.post('/contribute',async(req,res)=>{
  const idea=String(req.body.idea||'').trim().slice(0,500), requestedSlug=String(req.body.page||'canvas').trim()||'canvas';
  const returnTo=requestedSlug==='canvas'?'/':`/p/${encodeURIComponent(requestedSlug)}`;
  if(!idea)return res.redirect(returnTo);
  const ip=String(req.ip||req.socket.remoteAddress||'unknown'), now=Date.now(), hit=(promptHits.get(ip)||[]).filter(t=>now-t<60*60*1000);
  if(hit.length>=12)return res.redirect(`${returnTo}?error=limit`);
  hit.push(now);promptHits.set(ip,hit);
  try{
    if(!process.env.OPENAI_API_KEY)return res.redirect(`${returnTo}?error=key`);
    const {rows}=await pool.query('SELECT * FROM pages WHERE slug=$1',[requestedSlug]);const current=rows[0];
    if(!current)return res.redirect('/?error=failed');
    const build=await generatePage(idea,current);
    const html=build.html;
    if(build.action==='create_subpage'){
      const title=build.title.trim().slice(0,100)||'A new page';let slug=slugify(title),suffix=1;
      while((await pool.query('SELECT 1 FROM pages WHERE slug=$1',[slug])).rows.length)slug=`${slugify(title)}-${++suffix}`;
      const created=await pool.query('INSERT INTO pages(slug,title,body,created_by,parent_slug) VALUES($1,$2,$3,$4,$5) RETURNING id',[slug,title,html,null,current.slug]);
      await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4)',[null,created.rows[0].id,'subpage',build.summary.slice(0,180)||`made ${title}`]);
      const link=`<p><a href="/p/${esc(slug)}">${esc(title)}</a></p>`;
      await pool.query('UPDATE pages SET body=body || $1,updated_at=now() WHERE id=$2',[link,current.id]);
      return res.redirect(`/p/${encodeURIComponent(slug)}`);
    }
    if(current.body.length+html.length>250000)return res.redirect(`${returnTo}?error=busy`);
    await pool.query('UPDATE pages SET body=body || $1,updated_at=now() WHERE id=$2',[html,current.id]);
    await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4)',[null,current.id,'build',build.summary.slice(0,180)||'added to the canvas']);
    res.redirect(returnTo);
  }catch(e){console.error('AI build failed:',e);res.redirect(`${returnTo}?error=${e.publicCode||'failed'}`);}
});

async function generatePage(idea,current){
  const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['append_html','create_subpage']},title:{type:'string'},summary:{type:'string'},html:{type:'string'}},required:['action','title','summary','html']};
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-6-astra',store:false,max_output_tokens:6000,input:[{role:'system',content:'You write HTML that becomes part of The Commons, a shared website with a blank canvas. The user request is the spec. Normally return action append_html and a useful, functional HTML fragment to append directly to the current page. Use action create_subpage only when they explicitly ask for a separate subpage; return a complete page body fragment for that child. Use only HTML, inline CSS in style tags, and inline JavaScript in script tags. Do not include html, head, or body wrapper tags. No external scripts, fonts, images, network requests, tracking, or links except internal links to Commons subpages using href="/p/slug". Keep JavaScript self-contained in an IIFE. Make it responsive and accessible. Never request passwords, payment details, or sensitive personal information. Existing page HTML is preserved and your new fragment is appended.'},{role:'user',content:`Current page: ${current.title} (slug ${current.slug}).

Build this: ${idea}`}],text:{format:{type:'json_schema',name:'commons_build',strict:true,schema}}})});
  if(!response.ok){const detail=await response.text();console.error('OpenAI response:',response.status,detail.slice(0,1000));const e=new Error('OpenAI request failed');e.publicCode=response.status===401?'auth':response.status===429?'busy':'failed';throw e;}
  const payload=await response.json();
  // `output_text` is an SDK convenience property; the raw Responses API returns
  // the text in output[].content[].text instead.
  const outputText=payload.output_text||payload.output?.flatMap(item=>item.content||[])
    .filter(part=>part.type==='output_text'&&typeof part.text==='string')
    .map(part=>part.text).join('');
  if(!outputText){
    const reason=payload.incomplete_details?.reason||payload.error?.message||payload.status||'no text output';
    console.error('OpenAI returned no output text:',reason,JSON.stringify(payload.output||[]).slice(0,1200));
    throw new Error(`No generated HTML returned (${reason})`);
  }
  const result=JSON.parse(outputText);result.title=String(result.title||'A new page').trim().slice(0,100)||'A new page';result.summary=String(result.summary||'').slice(0,180);result.html=String(result.html||'').trim().replace(/^```(?:html)?\s*/i,'').replace(/\s*```$/,'');
  if(!result.html||result.html.length>30000||/<\/?(?:html|head|body)\b/i.test(result.html))throw new Error('Invalid HTML fragment returned');
  return result;
}
function lockHtml(fragment){
  const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";
  const bridge=`<script>document.addEventListener('click',e=>{const a=e.target.closest('a[href^="/p/"]');if(a){e.preventDefault();parent.postMessage({type:'commons:navigate',path:a.getAttribute('href')},'*')}})</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;min-height:100%;font-family:Arial,sans-serif}</style></head><body>${fragment}${bridge}</body></html>`;
}

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).send('Something went wrong.');});
initDb().then(()=>app.listen(port,()=>console.log(`Commons listening on ${port}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
