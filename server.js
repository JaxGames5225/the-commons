const express = require('express');
const { Pool } = require('pg');
const path = require('node:path');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false } });
const { randomUUID } = require('node:crypto');
const MAX_SITE_CODE = 150000;
const MAX_PENDING_BUILDS = 50;
const WORKER_LOCK_NAMESPACE = 824611;
const EMPTY_SITE_CODE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Commons</title></head><body></body></html>';

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '160kb' }));

const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const css = `
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717}
#canvas{position:fixed;inset:0;background:#fff}
#canvas-frame{display:block;width:100%;height:100%;border:0;background:transparent}
.queue-ui{position:relative;z-index:12}
.queue-bubble{position:fixed;right:24px;bottom:26px;display:flex;align-items:center;gap:10px;height:48px;padding:0 11px 0 16px;border:1px solid #e4e4e7;border-radius:999px;background:#fff;color:#18181b;box-shadow:0 8px 30px #00000012,0 2px 6px #00000008;font:600 13px/1.2 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;transition:box-shadow .18s ease,transform .18s ease}
.queue-bubble:hover{transform:translateY(-1px);box-shadow:0 10px 34px #00000018,0 3px 8px #0000000a}
.queue-count{display:grid;place-items:center;min-width:24px;height:24px;padding:0 6px;border-radius:999px;background:#f1f1f2;color:#45454a;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.queue-popup{position:fixed;right:24px;bottom:86px;width:min(390px,calc(100vw - 32px));height:min(570px,72vh);display:none;flex-direction:column;overflow:hidden;border:1px solid #e4e4e7;border-radius:18px;background:#fff;box-shadow:0 22px 70px #0000001c,0 4px 12px #0000000a}
.queue-popup:not([hidden]){display:flex}
.queue-header{display:flex;align-items:center;justify-content:space-between;flex:none;padding:15px 17px;border-bottom:1px solid #eeeeef}
.queue-header h2{margin:0;font-size:14px;font-weight:650;letter-spacing:-.01em}
.queue-close{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:9px;background:transparent;color:#71717a;font:24px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.queue-close:hover{background:#f4f4f5;color:#18181b}
.queue-scroll{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:3px 16px 12px;scrollbar-width:thin;scrollbar-color:#d4d4d8 transparent}
.queue-group h3{margin:13px 0 5px;color:#71717a;font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.active-list,.history-list{list-style:none;margin:0;padding:0}
.queue-item{padding:11px 2px;border-bottom:1px solid #f0f0f1}
.queue-item:last-child{border-bottom:0}
.queue-item-mine{margin:0 -8px;padding:11px 10px;border-radius:10px;background:#f8f8f9}
.queue-idea{margin:0 0 8px;color:#27272a;font-size:13px;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}
.queue-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#71717a;font-size:11px}
.queue-person{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.queue-time{flex:none;color:#a1a1aa;font-variant-numeric:tabular-nums}
.queue-state{display:inline-flex;align-items:center;flex:none;gap:5px;color:#52525b;font-size:10px;font-weight:650}
.queue-state:before{content:"";width:6px;height:6px;border-radius:50%;background:#a1a1aa}
.queue-state-building{color:#2459a6}
.queue-state-building:before{background:#3b82f6;box-shadow:0 0 0 3px #dbeafe}
.queue-state-queued:before{background:#d97706}
.queue-state-done:before{background:#16a34a}
.queue-state-failed{color:#b91c1c}
.queue-state-failed:before{background:#ef4444}
.queue-empty,.history-loading,.history-end{padding:12px 2px;color:#8a8a91;font-size:12px}
.history-loading,.history-end{text-align:center}
.history-sentinel{height:2px}
.prompt{position:fixed;z-index:10;left:50%;bottom:26px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;width:min(760px,calc(100vw - 48px));height:68px;padding:8px 10px 8px 23px;border:1px solid #e2e2e5;border-radius:20px;background:rgba(255,255,255,.97);box-shadow:0 14px 46px #00000016,0 3px 10px #00000008;backdrop-filter:blur(16px);overflow:hidden;transition:border-color .2s ease,box-shadow .2s ease}
.prompt:focus-within{border-color:#b8b8bf;box-shadow:0 0 0 4px #18181b0a,0 16px 48px #0000001a}
.prompt input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:#18181b;font:15px/1.4 Inter,ui-sans-serif,system-ui,sans-serif}
.prompt input::placeholder{color:#92929a}
.prompt button{position:relative;display:grid;place-items:center;flex:none;width:48px;height:48px;border:0;border-radius:14px;padding:0;background:#18181b;color:#fff;font:600 19px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;transition:background .16s ease,transform .16s ease}
.prompt button:hover:not(:disabled){transform:translateY(-1px);background:#333338}
.prompt button:disabled{cursor:wait;opacity:.82}
.prompt[data-state]:after{content:"";position:absolute;left:0;bottom:0;width:30%;height:2px;background:linear-gradient(90deg,transparent,#71717a,#18181b,transparent);animation:build-progress 1.3s ease-in-out infinite}
.prompt[data-state] button{font-size:0}
.prompt[data-state] button:after{content:"";width:17px;height:17px;border:2px solid #ffffff60;border-top-color:#fff;border-radius:50%;animation:build-spin .8s linear infinite}
.prompt[data-state="queued"] button:after{border-top-color:#fcd34d}
.prompt[data-state="queued"]{border-color:#d4d4d8}
.prompt-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes build-spin{to{transform:rotate(360deg)}}
@keyframes build-progress{0%{transform:translateX(-115%)}100%{transform:translateX(440%)}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:3s!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
@media(max-width:1000px){.queue-bubble{top:18px;right:18px;bottom:auto}.queue-popup{top:76px;right:18px;bottom:auto;max-height:calc(100vh - 94px)}}
@media(max-width:600px){.queue-bubble{top:12px;right:12px;height:44px}.queue-popup{top:66px;right:10px;width:calc(100vw - 20px);height:min(520px,62vh);max-height:calc(100vh - 82px);border-radius:16px}.prompt{bottom:12px;width:calc(100vw - 24px);height:60px;padding:6px 8px 6px 18px;border-radius:18px}.prompt input{font-size:14px}.prompt button{width:46px;height:46px;border-radius:13px}}
`;
const shell = content => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Commons</title><style>${css}</style></head><body>${content}<script src="/app.js" defer></script></body></html>`;

function errorText(code) {
  return ({key:'AI key needed — add OPENAI_API_KEY in Railway Variables',auth:'AI key is invalid — check OPENAI_API_KEY in Railway Variables',busy:'The builder is busy or the shared site is too large — try again shortly',failed:'Could not build that. Try again'})[code] || '';
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Add a reference to your PostgreSQL service in Railway.');
  await pool.query(`CREATE TABLE IF NOT EXISTS commons_site (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    code TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commons_requests (
    id UUID PRIMARY KEY,
    idea TEXT NOT NULL,
    requester_id UUID NOT NULL,
    requester_label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','building','done','failed')) DEFAULT 'queued',
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS commons_requests_queue_idx ON commons_requests(status, created_at, id)');
  const { rows: existing } = await pool.query('SELECT 1 FROM commons_site WHERE id=1');
  if (existing.length) return;

  await pool.query('INSERT INTO commons_site(id,code) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [EMPTY_SITE_CODE]);
}

function renderCanvas(code, error='') {
  const frame = `<iframe id="canvas-frame" title="Shared website" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttr(lockHtml(code))}"></iframe>`;
  return shell(`<main id="canvas">${frame}</main><aside class="queue-ui"><section class="queue-popup" id="queue-popup" aria-label="Community requests" hidden><header class="queue-header"><h2>Community requests</h2><button class="queue-close" type="button" aria-label="Close requests">×</button></header><div class="queue-scroll"><section class="queue-group"><h3>In the queue</h3><ol class="active-list"><li class="queue-empty">Loading…</li></ol></section><section class="queue-group"><h3>Recent requests</h3><ol class="history-list"></ol></section><p class="history-loading" hidden>Loading more…</p><p class="history-end" hidden>You’re all caught up.</p><div class="history-sentinel"></div></div></section><button class="queue-bubble" type="button" aria-expanded="false" aria-controls="queue-popup"><span>Queue</span><span class="queue-count" aria-label="Active requests">0</span></button></aside><form class="prompt" method="post" action="/contribute"><input name="idea" maxlength="2000" required placeholder="${escapeAttr(error || 'Add or change anything on the shared site…')}" aria-label="Describe what to build"><span class="prompt-status" role="status" aria-live="polite" aria-atomic="true"></span><button aria-label="Build">↗</button></form>`);
}

app.get('/health', (_req,res) => res.send('ok'));
app.get('/style.css', (_req,res) => res.type('text/css').send(css));
app.get('/app.js', (_req,res) => res.sendFile(path.join(__dirname,'public','app.js')));
app.get('/contribute', (_req,res) => res.redirect(303,'/'));
app.get('/api/requests/status', async (_req,res) => {
  try {
    const {rows}=await pool.query(`SELECT r.id,r.idea,r.requester_id,r.requester_label,r.status,r.error,r.created_at,r.started_at,r.completed_at,
      CASE WHEN r.status='queued' THEN (SELECT COUNT(*)::int+1 FROM commons_requests q WHERE q.status='queued' AND (q.created_at,q.id)<(r.created_at,r.id)) ELSE NULL END AS position
      FROM commons_requests r WHERE r.status IN ('queued','building')
      ORDER BY CASE r.status WHEN 'building' THEN 0 ELSE 1 END,r.created_at,r.id`);
    const {rows:[count]}=await pool.query("SELECT COUNT(*)::int AS count FROM commons_requests WHERE status IN ('queued','building')");
    res.set('Cache-Control','no-store').json({requests:rows,pendingCount:count.count});
  } catch(e) { console.error('Could not load request list:',e);res.status(500).json({message:'Could not load the request list.'}); }
});
app.get('/api/requests', async (req,res) => {
  try {
    const limit=20;
    let cursor=null;
    if(req.query.cursor){
      try { cursor=JSON.parse(Buffer.from(String(req.query.cursor),'base64url').toString()); }
      catch { return res.status(400).json({message:'Invalid request history cursor.'}); }
      if(!cursor || typeof cursor.createdAt!=='string' || !/^[0-9a-f-]{36}$/i.test(cursor.id||''))return res.status(400).json({message:'Invalid request history cursor.'});
    }
    const params=cursor?[cursor.createdAt,cursor.id,limit+1]:[limit+1];
    const where=cursor?"status IN ('done','failed') AND (created_at,id)<($1::timestamptz,$2::uuid)":"status IN ('done','failed')";
    const takeIndex=cursor?'$3':'$1';
    const {rows}=await pool.query(`SELECT id,idea,requester_id,requester_label,status,error,created_at,started_at,completed_at FROM commons_requests WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ${takeIndex}`,params);
    const hasMore=rows.length>limit;
    const requests=rows.slice(0,limit);
    const last=requests.at(-1);
    const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,id:last.id})).toString('base64url'):null;
    res.set('Cache-Control','no-store').json({requests,nextCursor});
  } catch(e) { console.error('Could not load request history:',e);res.status(500).json({message:'Could not load request history.'}); }
});
app.get('/builds/:id', async (req,res) => {
  if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(404).json({state:'failed',message:'That request was not found.'});
  try {
    const {rows}=await pool.query(`SELECT r.status,r.error,
      CASE WHEN r.status='queued' THEN (SELECT COUNT(*)::int+1 FROM commons_requests q WHERE q.status='queued' AND (q.created_at,q.id)<(r.created_at,r.id)) ELSE NULL END AS position
      FROM commons_requests r WHERE r.id=$1`,[req.params.id]);
    if(!rows.length)return res.status(404).json({state:'failed',message:'That request was not found.'});
    res.set('Cache-Control','no-store').json({state:rows[0].status,message:rows[0].error,position:rows[0].position});
  } catch(e) { console.error('Could not read request status:',e);res.status(500).json({state:'failed',message:'Could not check request status.'}); }
});
app.get('/',async(req,res)=>{
  try { const {rows}=await pool.query('SELECT code FROM commons_site WHERE id=1');res.type('html').send(renderCanvas(rows[0]?.code||EMPTY_SITE_CODE,errorText(req.query.error))); }
  catch(e){console.error(e);res.status(500).type('html').send(renderCanvas(EMPTY_SITE_CODE,'The canvas is loading — try again'));}
});

app.post('/contribute',async(req,res,next)=>{
 try {
  const idea=String(req.body.idea||'').trim().slice(0,2000);
  if(!idea)return res.status(400).json({message:'Type something to add or change first.'});
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({message:errorText('key')});
  const requesterId=String(req.body.requesterId||'').toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requesterId))return res.status(400).json({message:'Could not identify this browser. Reload the page and try again.'});
  const client=await pool.connect();
  let full=false,id=randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[WORKER_LOCK_NAMESPACE,2]);
    const {rows}=await client.query("SELECT COUNT(*)::int AS count FROM commons_requests WHERE status IN ('queued','building')");
    if(rows[0].count>=MAX_PENDING_BUILDS)full=true;
    else {
      const requesterLabel=`Guest ${requesterId.replaceAll('-','').slice(0,4).toUpperCase()}`;
      await client.query('INSERT INTO commons_requests(id,idea,requester_id,requester_label) VALUES($1,$2,$3,$4)',[id,idea,requesterId,requesterLabel]);
    }
    await client.query(full?'ROLLBACK':'COMMIT');
  } catch(e) { await client.query('ROLLBACK');throw e; }
  finally { client.release(); }
  if(full)return res.status(503).json({message:'The Commons queue is full right now. Your prompt is still here — try again in a moment.'});
  res.status(202).json({statusUrl:`/builds/${id}`});
 } catch(e) { next(e); }
});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function claimNextBuild(){
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query("SELECT id,idea FROM commons_requests WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(!rows.length){await client.query('COMMIT');return null;}
    await client.query("UPDATE commons_requests SET status='building',started_at=now() WHERE id=$1",[rows[0].id]);
    await client.query('COMMIT');
    return rows[0];
  } catch(e) { await client.query('ROLLBACK');throw e; }
  finally { client.release(); }
}

async function runBuildWorker(){
  while(true){
    let lockClient=null,locked=false;
    try {
      lockClient=await pool.connect();
      const {rows}=await lockClient.query('SELECT pg_try_advisory_lock($1,$2) AS acquired',[WORKER_LOCK_NAMESPACE,1]);
      locked=rows[0].acquired;
      if(!locked){lockClient.release();lockClient=null;await delay(2500);continue;}
      console.log('Commons build worker acquired its database lock');
      await pool.query("UPDATE commons_requests SET status='queued',started_at=NULL WHERE status='building'");
      while(true){
        const job=await claimNextBuild();
        if(!job){await delay(1200);continue;}
        await processBuild(job);
      }
    } catch(e) {
      console.error('Commons build worker failed:',e);
      await delay(2500);
    } finally {
      if(lockClient){
        if(locked){try{await lockClient.query('SELECT pg_advisory_unlock($1,$2)',[WORKER_LOCK_NAMESPACE,1]);}catch(e){console.error('Could not release build worker lock:',e);}}
        lockClient.release();
      }
    }
  }
}

async function processBuild(job){
  try{
    const {rows}=await pool.query('SELECT code,revision FROM commons_site WHERE id=1');
    const current=rows[0];
    if(!current)throw new Error('The shared website is not ready. Please try again.');
    if(current.code.length>MAX_SITE_CODE)throw Object.assign(new Error(errorText('busy')),{publicCode:'busy'});
    const code=await generateSite(job.idea,current.code);
    if(code.length>MAX_SITE_CODE)throw Object.assign(new Error(errorText('busy')),{publicCode:'busy'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const saved=await client.query('UPDATE commons_site SET code=$1,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$2 RETURNING revision',[code,current.revision]);
      if(saved.rowCount)await client.query("UPDATE commons_requests SET status='done',error=NULL,completed_at=now() WHERE id=$1",[job.id]);
      await client.query('COMMIT');
      if(saved.rowCount)return;
    } catch(e) { await client.query('ROLLBACK');throw e; }
    finally { client.release(); }
    throw Object.assign(new Error('The website changed while this request was running. Please try again.'),{publicCode:'busy'});
  }catch(e){
    console.error('AI build failed:',e);
    const message=e.publicCode==='auth'?'The AI connection needs attention. Please try again later.':e.publicCode==='busy'?e.message:'Could not build that. Your prompt is still here — try again.';
    try { await pool.query("UPDATE commons_requests SET status='failed',error=$2,completed_at=now() WHERE id=$1",[job.id,message]); }
    catch(updateError) { console.error('Could not mark request as failed:',updateError); }
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
initDb().then(()=>{
  app.listen(port,()=>console.log(`Commons listening on ${port}`));
  runBuildWorker();
}).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
