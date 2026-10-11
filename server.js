const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false } });

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'local-development-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing. In Railway, add a reference to your PostgreSQL service: ${{Postgres.DATABASE_URL}} (replace Postgres with your database service name).');
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS pages (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES members(id), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS contributions (id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES members(id), page_id INTEGER REFERENCES pages(id), action TEXT NOT NULL, summary TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS reports (id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES members(id), contribution_id INTEGER REFERENCES contributions(id), reason TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_slug TEXT REFERENCES pages(slug) ON DELETE SET NULL');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM pages');
  if (!rows[0].n) {
    await pool.query("INSERT INTO pages (slug,title,body) VALUES ('welcome','Welcome to the Commons','A shared little corner of the internet, built together. Start by asking for a new page, a story, a club, a list, or anything else you would love to find here.')");
  }
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slugify = value => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'new-page';
const layout = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · The Commons</title><link rel="stylesheet" href="/style.css"></head><body><header class="topbar"><a class="brand" href="/">✳ <span>the commons</span></a><a class="explore-link" href="/explore">Explore ↗</a></header>${content}<script src="/style.js" defer></script></body></html>`;
const page = (res, status, title, content) => res.status(status).send(layout(title, content));
const flash = (req, key, value) => { req.session[key] = value; };
function note(req) { const msg=req.session.notice; delete req.session.notice; return msg ? `<div class="notice">${esc(msg)}</div>` : ''; }

app.get('/health', (_req,res) => res.send('ok'));
app.get('/style.css', (_req,res) => { res.type('text/css').send(CSS + CSS_OVERRIDE); });
app.get(['/login','/signup'], (_req,res) => res.redirect('/'));
app.post(['/login','/signup','/logout'], (_req,res) => res.redirect('/'));

app.get('/',async(req,res)=>{
  const {rows}=await pool.query('SELECT count(*)::int AS n FROM pages');
  page(res,200,'Build something',`<main class="blank-home">${note(req)}<section class="home-center"><div class="home-mark">✳ THE COMMONS</div><h1>A website<br>made <em>together.</em></h1><p>Say what should exist. The Commons will make a page for it.</p><span class="quiet-count">${rows[0].n} things made so far · open to everyone</span></section><form class="prompt floating-prompt" method="post" action="/contribute"><span class="prompt-spark">✳</span><input name="idea" maxlength="500" required placeholder="Make something for everyone…" aria-label="Describe what to make"><button aria-label="Make it">Make <span>↗</span></button></form><div class="prompt-hint">Press Enter to add to the Commons</div></main>`);
});

app.get('/explore',async(_req,res)=>{
  const {rows}=await pool.query("SELECT p.*,m.display_name FROM pages p LEFT JOIN members m ON p.created_by=m.id WHERE p.parent_slug IS NULL ORDER BY p.updated_at DESC");
  const cards=rows.map(p=>`<a class="page-card" href="/p/${encodeURIComponent(p.slug)}"><span class="card-icon">${icon(p.title)}</span><span class="card-copy"><b>${esc(p.title)}</b><small>by the community</small></span><span class="arrow">↗</span></a>`).join('')||'<p class="muted">Nothing here yet. Make the first thing.</p>';
  page(res,200,'Explore',`<main class="shell explore-shell"><a class="back" href="/">← Back</a><div class="section-heading"><div><div class="eyebrow">MADE BY EVERYONE</div><h2>Explore the Commons</h2></div><span class="count">${rows.length} ${rows.length===1?'thing':'things'}</span></div><div class="page-grid">${cards}</div></main><form class="prompt floating-prompt" method="post" action="/contribute"><span class="prompt-spark">✳</span><input name="idea" maxlength="500" required placeholder="Make something for everyone…"><button>Make <span>↗</span></button></form>`);
});

app.get('/p/:slug',async(req,res)=>{
  const {rows}=await pool.query('SELECT p.*,m.display_name FROM pages p LEFT JOIN members m ON p.created_by=m.id WHERE p.slug=$1',[req.params.slug]);
  if(!rows[0]) return page(res,404,'Page not found',`<main class="shell"><a class="back" href="/">← Commons</a><h1>Page not found</h1></main>`);
  const p=rows[0], {rows:history}=await pool.query("SELECT c.*,COALESCE(m.display_name,'A visitor') AS display_name FROM contributions c LEFT JOIN members m ON c.member_id=m.id WHERE c.page_id=$1 ORDER BY c.created_at DESC LIMIT 8",[p.id]);
  const data=parsePageData(p.body);
  const {rows:children}=await pool.query('SELECT slug,title FROM pages WHERE parent_slug=$1 ORDER BY created_at DESC',[p.slug]);
  const h=history.map(c=>`<div class="activity-item"><span class="activity-dot"></span><div><b>${esc(c.display_name)}</b> ${esc(c.summary)}<small>${timeAgo(c.created_at)}</small><form method="post" action="/report/${c.id}" class="report"><button>Report</button></form></div></div>`).join('')||'<p class="muted">A fresh page, ready for ideas.</p>';
  const childNav=children.length?`<section class="child-pages"><div class="eyebrow">MADE INSIDE THIS PAGE</div>${children.map(c=>`<a class="child-link" href="/p/${encodeURIComponent(c.slug)}">${esc(c.title)} <span>↗</span></a>`).join('')}</section>`:'';
  page(res,200,p.title,`<main class="shell article-shell"><a class="back" href="${p.parent_slug?`/p/${encodeURIComponent(p.parent_slug)}`:'/explore'}">← ${p.parent_slug?'Parent page':'Explore'}</a><div class="article-head"><div class="eyebrow">A COMMUNITY PAGE · BUILT BY EVERYONE</div><h1>${esc(p.title)}</h1><p>${esc(data.description||'')}</p></div><article class="generated-app">${renderFragments(data.fragments)}</article>${childNav}<section class="page-history"><div class="eyebrow">RECENT BUILDS</div><div class="feed">${h}</div></section></main><form class="prompt floating-prompt" method="post" action="/contribute"><input type="hidden" name="page" value="${esc(p.slug)}"><span class="prompt-spark">✳</span><input name="idea" maxlength="500" required placeholder="Add something to ${esc(p.title)}…"><button>Build <span>↗</span></button></form>`);
});

const promptHits = new Map();
app.post('/contribute',async(req,res)=>{
  const idea=String(req.body.idea||'').trim().slice(0,500), requestedSlug=String(req.body.page||'').trim();
  if(!idea){flash(req,'notice','Tell the Commons what to make.');return res.redirect(requestedSlug?`/p/${encodeURIComponent(requestedSlug)}`:'/');}
  const ip=String(req.ip||req.socket.remoteAddress||'unknown'), now=Date.now(), hit=(promptHits.get(ip)||[]).filter(t=>now-t<60*60*1000);
  if(hit.length>=12){flash(req,'notice','This connection has reached its building limit for now. Try again in an hour.');return res.redirect(requestedSlug?`/p/${encodeURIComponent(requestedSlug)}`:'/');}
  hit.push(now);promptHits.set(ip,hit);
  try{
    if(!process.env.OPENAI_API_KEY) throw new Error('The AI builder is not connected yet. Add OPENAI_API_KEY to the Railway service variables.');
    let current=null;
    if(requestedSlug){const {rows}=await pool.query('SELECT * FROM pages WHERE slug=$1',[requestedSlug]);current=rows[0];if(!current){flash(req,'notice','That page is no longer here.');return res.redirect('/explore');}}
    const build=await generatePage(idea,current);
    if(build.action==='update_current_page'&&current){
      const existing=parsePageData(current.body), merged={description:existing.description||build.description,fragments:[...existing.fragments,build.html].slice(-8)};
      await pool.query('UPDATE pages SET body=$1,updated_at=now() WHERE id=$2',[JSON.stringify(merged),current.id]);
      await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4)',[null,current.id,'edit',build.summary.slice(0,180)||`added to ${current.title}`]);
      return res.redirect(`/p/${encodeURIComponent(current.slug)}`);
    }
    const title=build.title.trim().slice(0,100)||'A new idea';let slug=slugify(title),suffix=1;
    while((await pool.query('SELECT 1 FROM pages WHERE slug=$1',[slug])).rows.length)slug=`${slugify(title)}-${++suffix}`;
    const parentSlug=build.action==='create_subpage'&&current?current.slug:null;
    const body=JSON.stringify({description:build.description,fragments:[build.html]});
    const {rows}=await pool.query('INSERT INTO pages(slug,title,body,created_by,parent_slug) VALUES($1,$2,$3,$4,$5) RETURNING id',[slug,title,body,null,parentSlug]);
    await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4)',[null,rows[0].id,parentSlug?'subpage':'create',build.summary.slice(0,180)||`made ${title}`]);
    res.redirect(`/p/${encodeURIComponent(slug)}`);
  }catch(e){console.error('AI build failed:',e);flash(req,'notice',e.publicMessage||'The builder hit a snag. Try again in a moment.');res.redirect(requestedSlug?`/p/${encodeURIComponent(requestedSlug)}`:'/');}
});
app.post('/report/:id',async(req,res)=>{
  const id=Number(req.params.id); if(Number.isInteger(id)) await pool.query('INSERT INTO reports(member_id,contribution_id,reason) VALUES($1,$2,$3)',[null,id,'community report']);
  flash(req,'notice','Thanks. Your report has been sent to the community moderators.');res.redirect('back');
});

async function generatePage(idea,current){
  const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['create_page','create_subpage','update_current_page']},title:{type:'string'},description:{type:'string'},summary:{type:'string'},html:{type:'string'}},required:['action','title','description','summary','html']};
  const context=current?`Current page: ${current.title} (/${current.slug}). Choose update_current_page to add to it, create_subpage if the request asks for a distinct child page, or create_page for a separate top-level page.`:'The request starts from the home page, so choose create_page.';
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-6-astra',store:false,max_output_tokens:6000,input:[{role:'system',content:'You are the code builder for The Commons, a public website where every visitor can add a little web app for everyone. Convert the request into a polished, useful, self-contained HTML document. Choose create_page for a new standalone page, create_subpage for a clearly requested page nested under the current page, and update_current_page when adding to the current page. Return a complete HTML document with inline CSS and JavaScript. No external scripts, fonts, images, network calls, tracking, or links; everything runs locally in its isolated preview. Build functional interactions in the page: buttons, filters, simple calculators, quizzes, checklists, and playful UI are welcome. Never request passwords, payment details, or sensitive personal information. Make the design responsive, clear, and accessible. For updates, produce a new standalone app fragment that will be added below existing creations rather than overwriting them. The result will run in a sandboxed iframe.'},{role:'user',content:`${context}\n\nBuild this for the Commons:\n${idea}`}],text:{format:{type:'json_schema',name:'commons_page',strict:true,schema}}})});
  if(!response.ok){const detail=await response.text();console.error('OpenAI response:',response.status,detail.slice(0,1000));const e=new Error('The AI builder could not complete that request. Try again shortly.');e.publicMessage=response.status===401?'The AI connection is not configured correctly. Check OPENAI_API_KEY in the service variables.':response.status===429?'The AI builder is busy or out of credits. Try again in a bit.':e.message;throw e;}
  const payload=await response.json();
  if(!payload.output_text)throw new Error('The AI did not return a page. Try a more specific request.');
  const result=JSON.parse(payload.output_text);
  result.title=String(result.title||'A new idea').trim().slice(0,100)||'A new idea';
  result.description=String(result.description||'').slice(0,320);
  result.summary=String(result.summary||'').slice(0,180);
  result.html=String(result.html||'').slice(0,30000);
  if(!/<html[\s>]/i.test(result.html)||!/<\/html>/i.test(result.html))throw new Error('The AI returned an incomplete page. Try again.');
  if(!current&&result.action==='update_current_page')result.action='create_page';
  return result;
}
function parsePageData(body){try{const value=JSON.parse(body);if(value&&Array.isArray(value.fragments))return value;}catch{}const legacy=String(body||'').split(/\n\n+/).filter(Boolean).map(t=>`<p>${esc(t)}</p>`).join('');return{description:'A page in the Commons.',fragments:[`<!doctype html><html><head><meta charset="utf-8"></head><body>${legacy}</body></html>`]};}
function renderFragments(fragments){return fragments.map((html,i)=>`<iframe class="generated-frame" title="Community built web app ${i+1}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${esc(lockHtml(html))}"></iframe>`).join('');}
function lockHtml(html){const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";const clean=String(html).replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy[^>]*>/gi,'');return /<head[^>]*>/i.test(clean)?clean.replace(/<head[^>]*>/i,match=>`${match}<meta http-equiv="Content-Security-Policy" content="${policy}">`):`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body>${clean}</body></html>`;}
function icon(title){const chars=['✳','✿','☼','✷','⌂','♡','✦','☻'];return chars[[...title].reduce((n,c)=>n+c.charCodeAt(0),0)%chars.length];}
function timeAgo(date){const m=Math.max(0,Math.floor((Date.now()-new Date(date).getTime())/60000));return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`;}

const CSS=`@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
:root{--ink:#252a25;--muted:#777c73;--paper:#fafaf8;--line:#e8e9df;--green:#526d53}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px 'DM Sans',sans-serif}.topbar{height:64px;padding:0 34px;display:flex;align-items:center;justify-content:space-between;background:transparent}.brand{text-decoration:none;color:var(--ink);font-weight:700;letter-spacing:.2px;font-size:14px;display:flex;gap:9px;align-items:center}.explore-link{font-size:12px;text-decoration:none;color:#888b85}.explore-link:hover,.back:hover{color:#344c3b}.shell{max-width:1120px;margin:auto;padding:0 28px}.blank-home{min-height:calc(100vh - 64px);position:relative;display:grid;place-items:center;padding:0 22px 130px}.home-center{text-align:center;max-width:520px;margin-top:-4vh}.home-mark,.eyebrow{font:10px 'DM Mono',monospace;letter-spacing:2px;color:#858a7d;text-transform:uppercase}.home-center h1{font:600 clamp(46px,8vw,76px)/.98 'Playfair Display',serif;letter-spacing:-3px;margin:24px 0 15px;color:#252a25}.home-center h1 em{color:#658065}.home-center p{color:#777c73;font-size:15px;line-height:1.65;margin:0 0 12px}.quiet-count,.count{font:10px 'DM Mono',monospace;color:#a2a49d}.prompt{height:64px;display:flex;align-items:center;position:fixed;z-index:20;left:50%;bottom:42px;transform:translateX(-50%);width:min(670px,calc(100vw - 36px));background:#fff;border:1px solid #e5e6df;border-radius:15px;padding:7px 8px;box-shadow:0 12px 40px #29302118,0 2px 8px #2930210a;gap:12px}.prompt:focus-within{border-color:#83977b;box-shadow:0 0 0 3px #84957520,0 12px 40px #29302118}.prompt-spark{font-size:21px;color:#7a8c68;padding-left:10px}.prompt input{border:0;outline:0;background:transparent;flex:1;min-width:0;font:15px 'DM Sans',sans-serif;color:var(--ink)}.prompt input::placeholder{color:#9a9d94}.prompt button{height:48px;background:#303b31;color:#fff;border:0;border-radius:10px;padding:0 19px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;white-space:nowrap}.prompt button:disabled{opacity:.7}.prompt-hint{position:fixed;bottom:17px;left:0;right:0;text-align:center;font:10px 'DM Mono',monospace;color:#a6a89f;pointer-events:none}.notice{position:fixed;z-index:30;top:76px;left:50%;transform:translateX(-50%);width:min(540px,calc(100vw - 32px));margin:0;padding:12px 15px;border-radius:7px;background:#eef1e5;color:#536447;font-size:13px;box-shadow:0 5px 22px #29302112}.explore-shell{padding-top:45px;padding-bottom:180px;max-width:800px}.back{color:#798172;text-decoration:none;font-size:12px}.explore-shell .section-heading{display:flex;align-items:end;justify-content:space-between;margin:55px 0 17px}.explore-shell .section-heading h2{font:600 30px 'Playfair Display',serif;margin:8px 0 0}.page-grid{display:grid;grid-template-columns:1fr;gap:9px}.page-card{min-height:72px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:13px;display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink);transition:.15s}.page-card:hover{transform:translateY(-2px);box-shadow:0 6px 17px #252a2510;border-color:#ccd3c5}.card-icon{height:39px;width:39px;border-radius:7px;background:#f0f2e8;display:grid;place-items:center;color:var(--green);font-size:19px}.card-copy{display:flex;flex-direction:column;gap:6px;min-width:0}.card-copy b{font-size:13px}.card-copy small{font-size:10px;color:#989a92}.arrow{margin-left:auto;color:#a5a89e}.muted{color:#858980;font-size:13px;line-height:1.7}.article-shell{padding-top:24px;padding-bottom:210px;max-width:920px}.article-head{padding:45px 0 28px;border-bottom:1px solid var(--line)}.article-head h1{font:700 clamp(40px,7vw,62px)/1.05 'Playfair Display',serif;letter-spacing:-2px;margin:13px 0}.article-head p{color:#7b7e77;font-size:14px;line-height:1.65;margin:0}.generated-app{padding:27px 0}.generated-frame{display:block;width:100%;height:min(74vh,760px);min-height:480px;border:1px solid #e6e6e1;border-radius:14px;background:white;box-shadow:0 12px 42px #2930210b;margin:0 0 22px}.child-pages{margin:16px 0 34px;padding:22px 0;border-top:1px solid #e8e9df}.child-link{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e8e9df;text-decoration:none;color:#38463a}.child-link span{color:#969990}.page-history{border-top:1px solid var(--line);padding:26px 0 30px}.feed{display:flex;flex-direction:column;max-width:600px}.activity-item{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:11px;line-height:1.6;color:#6c7168}.activity-item b{color:#33392f;font-weight:600}.activity-item small{display:block;color:#a1a399;font:10px 'DM Mono',monospace;margin-top:4px}.activity-dot{flex:0 0 7px;width:7px;height:7px;background:#c5d288;border-radius:50%;margin-top:6px}.page-history .feed{max-width:600px}@media(max-width:650px){.topbar{padding:0 20px;height:58px}.blank-home{min-height:calc(100dvh - 58px);padding-bottom:150px}.home-center{margin-top:-7vh}.home-center h1{letter-spacing:-2px}.prompt{bottom:36px;width:calc(100vw - 24px);height:60px;border-radius:13px}.prompt-spark{padding-left:6px}.prompt button{padding:0 14px}.prompt-hint{bottom:13px}.explore-shell{padding:24px 20px 180px}.article-shell{padding:16px 16px 210px}.generated-frame{min-height:420px;height:70vh;border-radius:10px}.notice{top:65px}}`;
const CSS_OVERRIDE='';
app.get('/style.js',(_req,res)=>res.type('application/javascript').send("document.querySelectorAll('.prompt').forEach(f=>f.addEventListener('submit',()=>{const b=f.querySelector('button'),i=f.querySelector('input[name=idea]');if(b){b.disabled=true;b.textContent='Building…'}if(i)i.readOnly=true;const h=document.querySelector('.prompt-hint');if(h)h.textContent='The Commons is making your page…'}));"));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).send('Something went wrong. Please try again.');});
initDb().then(()=>app.listen(port,()=>console.log(`Commons listening on ${port}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
