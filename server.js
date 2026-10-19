const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

// Load .env when present (hosting platforms set real environment variables instead).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { DataForSEO } = require('./lib/dataforseo');
const { DemoClient, demoAudit } = require('./lib/demo');
const { runScan, locate, estimateCost } = require('./lib/scan');

const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const DFS_LOGIN = (process.env.DATAFORSEO_LOGIN || '').trim();
const DFS_PASSWORD = (process.env.DATAFORSEO_PASSWORD || '').trim();
// Without DataForSEO credentials the app runs on sample data instead of refusing to start.
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '') || !DFS_LOGIN || !DFS_PASSWORD;
const PAGESPEED_KEY = process.env.PAGESPEED_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SCAN_DIR = path.join(DATA_DIR, 'scans');
const MAX_CONCURRENT_SCANS = 2;

const DEFAULT_KEYWORDS = ['ac repair', 'hvac company', 'ac repair near me', 'air conditioning installation', 'emergency ac repair'];

if (DEMO) console.warn('No DataForSEO credentials (or DEMO_MODE=true): running in DEMO MODE with sample data.');
fs.mkdirSync(SCAN_DIR, { recursive: true });

// Without a password, never expose the app: show setup instructions instead.
if (!APP_PASSWORD) {
  console.error('APP_PASSWORD is not set. Showing setup page until it is.');
  const setup = express();
  setup.get('/healthz', (req, res) => res.json({ ok: true, setup: true }));
  setup.use((req, res) =>
    res.status(503).type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Grid Scanner setup</title><body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.5">
      <h1>Almost there</h1><p>Set a password before using Grid Scanner.</p>
      <ol><li>In Render, open the <b>grid-scanner</b> service and click <b>Environment</b>.</li>
      <li>Add <code>APP_PASSWORD</code> with any password you choose.</li>
      <li>Click <b>Save, rebuild, and deploy</b>. This page will turn into the sign-in screen.</li></ol></body>`)
  );
  setup.listen(PORT, () => console.log(`Setup page on port ${PORT}`));
  return;
}

const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('grid-scanner:' + APP_PASSWORD).digest('hex');
const SESSION_TOKEN = crypto.createHmac('sha256', SECRET).update('session-v1').digest('hex');

function newClient() {
  return DEMO ? new DemoClient() : new DataForSEO(DFS_LOGIN, DFS_PASSWORD, { concurrency: 12 });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));

// ---- auth -------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginAttempts = new Map();
app.post('/login', (req, res) => {
  const ip = req.ip;
  const rec = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > Date.now()) return res.redirect('/login?e=locked');
  if (safeEqual(req.body.password || '', APP_PASSWORD)) {
    loginAttempts.delete(ip);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `gs_session=${SESSION_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`);
    return res.redirect('/');
  }
  rec.n++;
  if (rec.n >= 8) {
    rec.until = Date.now() + 15 * 60 * 1000;
    rec.n = 0;
  }
  loginAttempts.set(ip, rec);
  res.redirect('/login?e=1');
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'gs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/login');
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/login.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));

app.use((req, res, next) => {
  if (safeEqual(parseCookies(req).gs_session || '', SESSION_TOKEN)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out. Reload the page and sign in.' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// ---- scans ------------------------------------------------------------
const jobs = new Map();

function scanFile(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  return path.join(SCAN_DIR, id + '.json');
}

function summary(s) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    demo: !!s.demo,
    business: { title: s.business.title, address: s.business.address },
    keywords: s.keywords.map((k) => k.keyword),
    spacing: s.grid.spacing,
    avgRank: s.keywords.length ? Math.round((s.keywords.reduce((a, k) => a + (k.stats.avgRank || 21), 0) / s.keywords.length) * 10) / 10 : null,
    spending: s.spending.level,
    waste: s.waste.score,
    websiteScore: s.website && s.website.score,
    cost: s.cost,
  };
}

app.get('/api/config', (req, res) => {
  res.json({
    demo: DEMO,
    defaultKeywords: DEFAULT_KEYWORDS,
    pagespeedKey: !!PAGESPEED_KEY,
    costPerKeyword: estimateCost(1, { searchAds: true, spend: false }),
    costFixed: Math.round((estimateCost(1) - estimateCost(1, { spend: false })) * 100) / 100,
  });
});

app.post('/api/locate', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const address = String(req.body.address || '').trim().slice(0, 200);
  if (!name || !address) return res.status(400).json({ error: 'Enter both the company name and its address.' });
  try {
    const client = newClient();
    const candidates = await locate(client, name, address);
    if (!candidates.length) return res.status(404).json({ error: 'No Google Business Profile found. Check the spelling, or try the street address exactly as it appears on Google Maps.' });
    res.json({ candidates, cost: client.totalCost });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/scan', (req, res) => {
  const b = req.body.business || {};
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !b.title) return res.status(400).json({ error: 'Pick a business before scanning.' });
  const keywords = [...new Set((req.body.keywords || []).map((k) => String(k).trim().toLowerCase().slice(0, 80)).filter(Boolean))].slice(0, 10);
  if (!keywords.length) return res.status(400).json({ error: 'Add at least one keyword.' });
  const spacing = [0.5, 1, 2].includes(Number(req.body.spacing)) ? Number(req.body.spacing) : 1;
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  if (running >= MAX_CONCURRENT_SCANS) return res.status(429).json({ error: 'Two scans are already running. Wait for one to finish.' });

  const id = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
  const job = { id, status: 'running', progress: { stage: 'starting', done: 0, total: 1 }, startedAt: Date.now() };
  jobs.set(id, job);

  const business = {
    title: String(b.title).slice(0, 200),
    address: String(b.address || '').slice(0, 300),
    cid: b.cid ? String(b.cid) : null,
    place_id: b.place_id ? String(b.place_id) : null,
    lat,
    lng,
    domain: b.domain ? String(b.domain) : '',
    url: b.url ? String(b.url) : null,
    phone: b.phone || null,
    category: b.category || null,
    rating: b.rating || null,
    is_claimed: b.is_claimed ?? null,
  };
  const website = String(req.body.website || '').trim().slice(0, 300) || null;
  const client = newClient();
  runScan(
    client,
    {
      business,
      keywords,
      spacing,
      website,
      searchAds: req.body.searchAds !== false,
      spend: req.body.spend !== false,
      pagespeedKey: PAGESPEED_KEY,
      auditFn: DEMO ? demoAudit : undefined,
    },
    (p) => (job.progress = p)
  )
    .then((scan) => {
      const full = { id, createdAt: new Date().toISOString(), demo: DEMO, input: { keywords, spacing, website }, ...scan };
      fs.writeFileSync(scanFile(id), JSON.stringify(full));
      job.status = 'done';
      job.result = full;
    })
    .catch((e) => {
      console.error('scan failed', id, e);
      job.status = 'error';
      job.error = e.message;
    })
    .finally(() => setTimeout(() => jobs.delete(id), 30 * 60 * 1000));

  res.json({ id });
});

app.get('/api/scan/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) {
    if (job.status === 'done') return res.json({ status: 'done', result: job.result });
    return res.json({ status: job.status, progress: job.progress, error: job.error });
  }
  const f = scanFile(req.params.id);
  if (f && fs.existsSync(f)) return res.json({ status: 'done', result: JSON.parse(fs.readFileSync(f, 'utf8')) });
  res.status(404).json({ error: 'Scan not found' });
});

app.get('/api/scans', (req, res) => {
  const list = [];
  for (const f of fs.readdirSync(SCAN_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      list.push(summary(JSON.parse(fs.readFileSync(path.join(SCAN_DIR, f), 'utf8'))));
    } catch {}
  }
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ scans: list.slice(0, 200) });
});

app.delete('/api/scans/:id', (req, res) => {
  const f = scanFile(req.params.id);
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Grid Scanner running on http://localhost:${PORT}${DEMO ? '  (DEMO MODE: sample data, no API calls)' : ''}`);
});
