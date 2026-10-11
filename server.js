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
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM pages');
  if (!rows[0].n) {
    await pool.query("INSERT INTO pages (slug,title,body) VALUES ('welcome','Welcome to the Commons','A shared little corner of the internet, built together. Start by asking for a new page, a story, a club, a list, or anything else you would love to find here.')");
  }
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slugify = value => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'new-page';
const layout = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · The Commons</title><link rel="stylesheet" href="/style.css"></head><body><header class="topbar"><a class="brand" href="/">✳ <span>the commons</span></a></header>${content}<footer>Made by all of us <span>✳</span></footer><script src="/style.js" defer></script></body></html>`;
const page = (res, status, title, content) => res.status(status).send(layout(title, content));
const flash = (req, key, value) => { req.session[key] = value; };
function note(req) { const msg=req.session.notice; delete req.session.notice; return msg ? `<div class="notice">${esc(msg)}</div>` : ''; }

app.get('/health', (_req,res) => res.send('ok'));
app.get('/style.css', (_req,res) => { res.type('text/css').send(CSS); });
app.get(['/login','/signup'], (_req,res) => res.redirect('/'));
app.post(['/login','/signup','/logout'], (_req,res) => res.redirect('/'));

app.get('/',async(req,res)=>{
  const [pages,activity]=await Promise.all([pool.query('SELECT p.*,m.display_name FROM pages p LEFT JOIN members m ON p.created_by=m.id ORDER BY p.updated_at DESC'),pool.query("SELECT c.*,COALESCE(m.display_name,'A visitor') AS display_name,p.title FROM contributions c LEFT JOIN members m ON c.member_id=m.id LEFT JOIN pages p ON c.page_id=p.id ORDER BY c.created_at DESC LIMIT 8")]);
  const cards=pages.rows.map(p=>`<a class="page-card" href="/p/${encodeURIComponent(p.slug)}"><span class="card-icon">${icon(p.title)}</span><span class="card-copy"><b>${esc(p.title)}</b><small>by ${esc(p.display_name||'the community')}</small></span><span class="arrow">↗</span></a>`).join('');
  const feed=activity.rows.map(a=>`<div class="activity-item"><span class="activity-dot"></span><div><b>${esc(a.display_name)}</b> ${esc(a.summary)}<small>${timeAgo(a.created_at)}</small></div></div>`).join('') || '<p class="muted">The first contribution could be yours.</p>';
  const content=`<main class="shell">${note(req)}<section class="hero"><div class="eyebrow"><span class="live-dot"></span> ONE SHARED PLACE · ${pages.rows.length} PAGES</div><h1>A corner of the<br>internet <em>we make.</em></h1><p>Dream up a page, a club, a tiny useful thing. Tell the Commons and help it grow.</p><form class="prompt" method="post" action="/contribute"><span class="prompt-spark">✳</span><input name="idea" maxlength="500" required placeholder="What should we add to the Commons?"><button aria-label="Add to the Commons">Send <span>↗</span></button></form><div class="suggestions"><span>Try:</span><button type="button" data-fill="Make a page for sharing neighborhood recipes">a recipe page</button><button type="button" data-fill="Make a page for posting little wins">a tiny wins wall</button><button type="button" data-fill="Make a page for recommending books">a book club</button></div></section><section class="content-grid"><div><div class="section-heading"><div><div class="eyebrow">GROWING TOGETHER</div><h2>Explore the Commons</h2></div><span class="count">${pages.rows.length} ${pages.rows.length===1?'page':'pages'}</span></div><div class="page-grid">${cards}</div></div><aside class="activity"><div class="eyebrow">HAPPENING HERE</div><h2>Latest additions</h2><div class="feed">${feed}</div><div class="community-note"><span>✳</span><p>Everyone belongs here.<br><b>Leave things better than you found them.</b></p></div></aside></section></main>`;
  page(res,200,'Home',content);
});

app.get('/p/:slug',async(req,res)=>{
  const {rows}=await pool.query('SELECT p.*,m.display_name FROM pages p LEFT JOIN members m ON p.created_by=m.id WHERE p.slug=$1',[req.params.slug]);
  if(!rows[0]) return page(res,404,'Page not found',`<main class="shell"><a class="back" href="/">← Commons</a><h1>Page not found</h1></main>`);
  const p=rows[0], {rows:history}=await pool.query("SELECT c.*,COALESCE(m.display_name,'A visitor') AS display_name FROM contributions c LEFT JOIN members m ON c.member_id=m.id WHERE c.page_id=$1 ORDER BY c.created_at DESC LIMIT 8",[p.id]);
  const h=history.map(c=>`<div class="activity-item"><span class="activity-dot"></span><div><b>${esc(c.display_name)}</b> ${esc(c.summary)}<small>${timeAgo(c.created_at)}</small><form method="post" action="/report/${c.id}" class="report"><button>Report</button></form></div></div>`).join('')||'<p class="muted">A fresh page, ready for ideas.</p>';
  page(res,200,p.title,`<main class="shell article-shell"><a class="back" href="/">← Back to the Commons</a><div class="article-head"><div class="eyebrow">A COMMUNITY PAGE · STARTED BY ${esc(p.display_name||'THE COMMUNITY').toUpperCase()}</div><h1>${esc(p.title)}</h1></div><article class="article-body">${renderText(p.body)}</article><section class="add-to-page"><div class="eyebrow">ADD TO THIS PAGE</div><h2>Make it a little more ours.</h2><form class="prompt" method="post" action="/contribute"><input type="hidden" name="page" value="${esc(p.slug)}"><span class="prompt-spark">✳</span><input name="idea" maxlength="500" required placeholder="What would you like to add here?"><button>Send <span>↗</span></button></form></section><section class="page-history"><div class="eyebrow">PAGE HISTORY</div><div class="feed">${h}</div></section></main>`);
});

app.post('/contribute',async(req,res)=>{
  const idea=String(req.body.idea||'').trim().slice(0,500); if(!idea){flash(req,'notice','Add an idea first.');return res.redirect('/');}
  const requestedSlug=String(req.body.page||'').trim();
  if(requestedSlug){
    const {rows}=await pool.query('SELECT * FROM pages WHERE slug=$1',[requestedSlug]);
    if(!rows[0]){flash(req,'notice','That page is no longer available.');return res.redirect('/');}
    const body=rows[0].body + (rows[0].body?'\n\n':'') + idea;
    await pool.query('UPDATE pages SET body=$1,updated_at=now() WHERE id=$2',[body,rows[0].id]);
    const {rows:cr}=await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4) RETURNING id',[null,rows[0].id,'edit',`added to ${rows[0].title}`]);
    flash(req,'notice','Your addition is live for everyone.');return res.redirect(`/p/${encodeURIComponent(requestedSlug)}#contribution-${cr[0].id}`);
  }
  const title=makeTitle(idea); let slug=slugify(title), suffix=1;
  while((await pool.query('SELECT 1 FROM pages WHERE slug=$1',[slug])).rows.length) slug=`${slugify(title)}-${++suffix}`;
  const {rows}=await pool.query('INSERT INTO pages(slug,title,body,created_by) VALUES($1,$2,$3,$4) RETURNING id',[slug,title,idea,null]);
  const {rows:cr}=await pool.query('INSERT INTO contributions(member_id,page_id,action,summary) VALUES($1,$2,$3,$4) RETURNING id',[null,rows[0].id,'create',`started ${title}`]);
  flash(req,'notice','Your new page is live for everyone.');res.redirect(`/p/${encodeURIComponent(slug)}#contribution-${cr[0].id}`);
});
app.post('/report/:id',async(req,res)=>{
  const id=Number(req.params.id); if(Number.isInteger(id)) await pool.query('INSERT INTO reports(member_id,contribution_id,reason) VALUES($1,$2,$3)',[null,id,'community report']);
  flash(req,'notice','Thanks. Your report has been sent to the community moderators.');res.redirect('back');
});

function makeTitle(idea){
  let s=idea.replace(/^(please\s+)?(can you\s+)?(make|create|add|start|build|let's make|i want)\s+(me\s+)?(a|an|the)?\s*/i,'').replace(/[.!?]+$/,'').trim();
  if(!s) s='A new idea'; return s.charAt(0).toUpperCase()+s.slice(1,80);
}
function renderText(text){return String(text||'').split(/\n\n+/).map(p=>`<p>${esc(p).replace(/\n/g,'<br>')}</p>`).join('');}
function icon(title){const chars=['✳','✿','☼','✷','⌂','♡','✦','☻'];return chars[[...title].reduce((n,c)=>n+c.charCodeAt(0),0)%chars.length];}
function timeAgo(date){const m=Math.max(0,Math.floor((Date.now()-new Date(date).getTime())/60000));return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`;}

const CSS=`@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
:root{--ink:#252a25;--muted:#777c73;--paper:#f8f8f3;--line:#e8e9df;--green:#526d53;--lime:#e5eead;--orange:#f5a56d}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px 'DM Sans',sans-serif}.topbar{height:70px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 max(calc((100vw - 1120px)/2),28px);background:#fbfbf7}.brand{text-decoration:none;color:var(--ink);font-weight:700;letter-spacing:-.5px;font-size:17px;display:flex;gap:9px;align-items:center}.brand:first-letter{color:var(--green)}.userbar{display:flex;align-items:center;gap:18px;font-size:13px}.userbar form{margin:0}.quiet{background:none;border:0;color:var(--muted);font:inherit;cursor:pointer}.shell{max-width:1120px;margin:auto;padding:0 28px}.hero{padding:76px 0 49px;max-width:730px}.eyebrow{font:10px 'DM Mono',monospace;letter-spacing:1.35px;color:var(--muted);text-transform:uppercase}.live-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#82a873;margin-right:8px;box-shadow:0 0 0 3px #e7eedc}.hero h1,.auth-card h1{font:700 clamp(43px,7vw,70px)/1.03 'Playfair Display',serif;letter-spacing:-2.7px;margin:24px 0 14px}.hero h1 em{color:var(--green)}.hero>p{color:#73776f;max-width:445px;line-height:1.75;font-size:16px;margin:0 0 25px}.prompt{height:59px;display:flex;align-items:center;background:#fff;border:1px solid #dedfd5;border-radius:9px;padding:6px;box-shadow:0 5px 20px #343d2010;gap:10px}.prompt:focus-within{border-color:#83977b;box-shadow:0 0 0 3px #84957520}.prompt-spark{font-size:19px;color:var(--green);padding-left:10px}.prompt input{border:0;outline:0;background:transparent;flex:1;min-width:0;font:14px 'DM Sans',sans-serif;color:var(--ink)}.prompt input::placeholder{color:#9a9d94}.prompt button,.primary{background:var(--green);color:#fff;border:0;border-radius:6px;padding:12px 18px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;white-space:nowrap}.prompt button span,.primary span{padding-left:12px;color:#ddeb9e}.suggestions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:14px;font-size:11px;color:#898d82}.suggestions button{border:1px solid var(--line);background:transparent;border-radius:20px;padding:6px 10px;color:#676d62;font:11px 'DM Sans',sans-serif;cursor:pointer}.suggestions button:hover{background:#eff1e8}.content-grid{border-top:1px solid var(--line);padding:37px 0 85px;display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:65px}.section-heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:17px}.section-heading h2,.activity h2{font:600 20px 'Playfair Display',serif;margin:8px 0 0;letter-spacing:-.3px}.count{font:11px 'DM Mono',monospace;color:#979a90}.page-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.page-card{min-height:80px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:13px;display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink);transition:.15s}.page-card:hover{transform:translateY(-2px);box-shadow:0 6px 17px #252a2510;border-color:#ccd3c5}.card-icon{height:39px;width:39px;border-radius:7px;background:#f0f2e8;display:grid;place-items:center;color:var(--green);font-size:19px}.page-card:nth-child(3n+2) .card-icon{background:#fff0e4;color:#c67a45}.page-card:nth-child(3n) .card-icon{background:#f8eaf0;color:#bb7891}.card-copy{display:flex;flex-direction:column;gap:6px;min-width:0}.card-copy b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-copy small{font-size:10px;color:#989a92}.arrow{margin-left:auto;color:#a5a89e;font-size:14px}.activity{border-left:1px solid var(--line);padding-left:28px}.activity h2{margin-bottom:19px}.feed{display:flex;flex-direction:column}.activity-item{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:11px;line-height:1.6;color:#6c7168}.activity-item b{color:#33392f;font-weight:600}.activity-item small{display:block;color:#a1a399;font:10px 'DM Mono',monospace;margin-top:4px}.activity-dot{flex:0 0 7px;width:7px;height:7px;background:#c5d288;border-radius:50%;margin-top:6px}.community-note{margin-top:22px;padding:12px;background:#eff1e7;border-radius:6px;display:flex;gap:10px;align-items:start;color:var(--green)}.community-note>span{font-size:16px}.community-note p{font-size:10px;line-height:1.65;margin:0;color:#687563}.community-note b{font-weight:600}footer{border-top:1px solid var(--line);text-align:center;color:#9a9d94;padding:19px;font-size:11px}footer span{color:#8a9e62;margin-left:5px}.auth-wrap{min-height:calc(100vh - 125px);display:grid;grid-template-columns:1fr 1fr;max-width:920px;margin:35px auto 55px;padding:0 25px}.auth-card{padding:55px 60px 40px;background:#fff;border:1px solid var(--line);border-radius:10px 0 0 10px}.auth-card h1{font-size:43px;letter-spacing:-1.6px;margin:20px 0 10px}.muted{color:#858980;font-size:13px;line-height:1.7}.stack{display:flex;flex-direction:column;gap:16px;margin-top:27px}.stack label{font-size:11px;color:#656b60;display:flex;flex-direction:column;gap:7px}.stack input{width:100%;border:1px solid #e1e2d9;border-radius:6px;padding:12px 11px;font:13px 'DM Sans',sans-serif;outline:none}.stack input:focus{border-color:#87977e}.stack button{margin-top:4px}.switch{font-size:11px;color:#858980;margin-top:23px}.switch a{color:var(--green);font-weight:600}.auth-art{border-radius:0 10px 10px 0;position:relative;overflow:hidden;background:#e5ebd9;display:flex;align-items:end;padding:35px}.sun{position:absolute;width:260px;height:260px;background:#f1c99e;border-radius:50%;right:-45px;top:54px}.sun:before,.sun:after{content:'';position:absolute;border:1px solid #f8f2e6;border-radius:50%;inset:20px}.sun:after{inset:40px}.art-copy{position:relative;font:600 37px/1.16 'Playfair Display',serif;color:#49624c}.star{position:absolute;color:#718a5d}.s1{top:38px;left:40px;font-size:28px}.s2{top:112px;right:70px;font-size:20px}.s3{top:48%;left:25%;font-size:22px}.notice{max-width:1120px;margin:20px auto 0;padding:12px 15px;border-radius:6px;background:#eef1e5;color:#536447;font-size:13px}.auth-wrap+.notice{max-width:initial}.article-shell{padding-top:30px;padding-bottom:70px;max-width:820px}.back{color:#798172;text-decoration:none;font-size:12px}.back:hover{color:var(--green)}.article-head{padding:55px 0 30px;border-bottom:1px solid var(--line)}.article-head h1{font:700 clamp(42px,7vw,66px)/1.05 'Playfair Display',serif;letter-spacing:-2px;margin:16px 0}.article-body{font:16px/1.85 'DM Sans',sans-serif;color:#50564c;padding:22px 0 32px;min-height:100px}.article-body p{margin:0 0 17px}.add-to-page{border-top:1px solid var(--line);padding:28px 0}.add-to-page h2{font:600 21px 'Playfair Display',serif;margin:9px 0 16px}.page-history{border-top:1px solid var(--line);padding:26px 0}.page-history .feed{max-width:500px}.report button{border:0;background:transparent;color:#a0a296;padding:3px 0;text-decoration:underline;font:10px 'DM Sans',sans-serif;cursor:pointer}.report{margin:0}.notice~.hero{padding-top:45px}@media(max-width:760px){.topbar{padding:0 20px}.shell{padding:0 20px}.hero{padding-top:51px}.content-grid{grid-template-columns:1fr;gap:38px}.activity{border-left:0;border-top:1px solid var(--line);padding:25px 0 0}.page-grid{grid-template-columns:1fr}.auth-wrap{grid-template-columns:1fr;margin:18px auto;max-width:500px;padding:0 16px}.auth-card{padding:38px 27px;border-radius:10px}.auth-art{display:none}.auth-card h1{font-size:38px}.article-shell{padding-top:24px}.userbar{gap:9px;font-size:11px}}`;
app.get('/style.js',(_req,res)=>res.type('application/javascript').send("document.querySelectorAll('[data-fill]').forEach(b=>b.addEventListener('click',()=>{const i=document.querySelector('.prompt input[name=idea]');if(i){i.value=b.dataset.fill;i.focus()}}));"));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).send('Something went wrong. Please try again.');});
initDb().then(()=>app.listen(port,()=>console.log(`Commons listening on ${port}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
