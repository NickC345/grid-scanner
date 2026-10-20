// DEMO MODE: a fake DataForSEO client that returns synthetic, clearly fictional
// data so the whole pipeline and UI can be tried without an API account.

const { analyzeHtml, scoreAudit } = require('./audit');

const DEMO_CENTER = { lat: 27.9506, lng: -82.4572 };
const COMPETITORS = [
  ['Demo Cooling Co (sample)', 'democooling.example'],
  ['Sample Air Pros (sample)', 'sampleairpros.example'],
  ['Example Heating & Air (sample)', 'exampleheatingair.example'],
  ['Placeholder HVAC (sample)', 'placeholderhvac.example'],
  ['Test Comfort Systems (sample)', 'testcomfort.example'],
  ['Mock Mechanical (sample)', 'mockmech.example'],
  ['Fake Breeze AC (sample)', 'fakebreeze.example'],
];

function rand(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function parseCoord(s) {
  const [lat, lng] = String(s).split(',').map(Number);
  return { lat, lng };
}

function competitorItem(i, rank, type = 'maps_search') {
  const [title, domain] = COMPETITORS[i % COMPETITORS.length];
  return { type, rank_group: rank, title, domain, cid: 'demo-c' + (i % COMPETITORS.length), rating: { value: 4.5 + ((i % COMPETITORS.length) % 5) / 10, votes_count: 120 + (i % COMPETITORS.length) * 85 } };
}

class DemoClient {
  constructor() {
    this.totalCost = 0;
    this.calls = 0;
    this.target = null;
  }

  _cost(c) {
    this.calls++;
    this.totalCost += c;
  }

  async mapsLive(task) {
    this._cost(0.002);
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
    if (!task.location_coordinate) {
      // locate request
      const name = task.keyword.split(/\d/)[0].trim() || 'Demo Business';
      return {
        items: [
          { type: 'maps_search', rank_group: 1, title: name, address: '100 Demo St, Tampa, FL 33602 (sample)', cid: 'demo-target', place_id: 'demo-place', latitude: DEMO_CENTER.lat, longitude: DEMO_CENTER.lng, domain: 'demo-hvac.example', url: 'https://demo-hvac.example/', phone: '(555) 010-0000', category: 'HVAC contractor', rating: { value: 4.1, votes_count: 38 }, is_claimed: true },
          { ...competitorItem(0, 2), latitude: 27.96, longitude: -82.46, address: '200 Sample Ave, Tampa, FL (sample)' },
        ],
      };
    }
    const { lat, lng } = parseCoord(task.location_coordinate);
    const dist = Math.hypot((lat - DEMO_CENTER.lat) * 69, (lng - DEMO_CENTER.lng) * 61);
    const kwSeed = [...task.keyword].reduce((s, c) => s + c.charCodeAt(0), 0);
    const noise = rand(lat * 1000 + lng * 777 + kwSeed) * 6 - 2;
    let targetRank = Math.round(1 + dist * 1.6 + noise);
    if (targetRank > 20 || rand(lat * 31 + lng + kwSeed) < dist / 30) targetRank = null;
    const items = [];
    let r = 1;
    const offset = Math.floor(rand(lat * 13 + lng * 7) * COMPETITORS.length);
    for (let i = 0; r <= 20; i++) {
      if (targetRank === r) {
        items.push({ type: 'maps_search', rank_group: r, title: this.targetTitle || 'Demo Business', cid: 'demo-target', domain: 'demo-hvac.example', rating: { value: 4.1, votes_count: 38 } });
      } else {
        items.push(competitorItem(offset + i, r));
      }
      r++;
    }
    if (rand(lat * 99 + lng * 3) > 0.55) items.unshift({ ...competitorItem(offset + 2, 1, 'maps_paid_item') });
    if (dist < 2.5 && rand(lat * 5 + lng * 9 + kwSeed) > 0.6) {
      items.unshift({ type: 'maps_paid_item', rank_group: 1, title: this.targetTitle || 'Demo Business', cid: 'demo-target', domain: 'demo-hvac.example' });
    }
    return { items };
  }

  // Mirrors DataForSEO's queued mode: results come back one by one.
  async mapsBatch(tasks, { onResult = () => {} } = {}) {
    const out = new Array(tasks.length).fill(null);
    await Promise.all(
      tasks.map(async (t, i) => {
        const result = await this.mapsLive(t);
        this.totalCost -= 0.002 - 0.0006; // queued searches cost less
        out[i] = { result };
        onResult(i, out[i]);
      })
    );
    return out;
  }

  async organicLive(task) {
    this._cost(0.002);
    await new Promise((r) => setTimeout(r, 30));
    const { lat, lng } = parseCoord(task.location_coordinate);
    const dist = Math.hypot((lat - DEMO_CENTER.lat) * 69, (lng - DEMO_CENTER.lng) * 61);
    const items = [];
    const showTarget = dist < 6 && rand(lat * 17 + lng) > 0.3;
    let pos = 1;
    if (showTarget) items.push({ type: 'paid', rank_group: pos++, domain: 'demo-hvac.example', title: 'AC Repair Tampa | Demo HVAC (sample ad)', url: 'https://demo-hvac.example/', description: 'Sample ad text for demo mode.' });
    items.push({ type: 'paid', rank_group: pos++, domain: COMPETITORS[1][1], title: 'Same Day AC Repair (sample ad)', url: `https://${COMPETITORS[1][1]}/ac-repair`, description: 'Sample competitor ad.' });
    if (rand(lat + lng * 3) > 0.5) items.push({ type: 'paid', rank_group: pos++, domain: COMPETITORS[3][1], title: '24/7 HVAC Service (sample ad)', url: `https://${COMPETITORS[3][1]}/`, description: 'Sample competitor ad.' });
    items.push({ type: 'local_services', rank_group: 1, items: [competitorItem(0, 1), competitorItem(4, 2), competitorItem(5, 3)].map((c) => ({ title: c.title, domain: c.domain, rating: c.rating })) });
    return { items };
  }

  async domainRankOverview() {
    this._cost(0.0101);
    return { items: [{ metrics: { organic: { count: 212, etv: 640 }, paid: { count: 34, etv: 410, estimated_paid_traffic_cost: 4850 } } }] };
  }

  async rankedKeywords() {
    this._cost(0.0111);
    const kws = [
      ['ac repair tampa', 18.5, 2400, '/'],
      ['hvac company near me', 22.1, 1900, '/'],
      ['air conditioning repair', 16.2, 1600, '/'],
      ['hvac technician jobs', 3.1, 880, '/'],
      ['ac replacement cost', 12.4, 720, '/'],
      ['how to fix ac yourself', 1.9, 590, '/'],
      ['emergency ac repair', 24.0, 480, '/'],
      ['hvac training school', 4.2, 320, '/'],
    ];
    return { items: kws.map(([k, cpc, vol, path]) => ({ keyword_data: { keyword: k, keyword_info: { cpc, search_volume: vol } }, ranked_serp_element: { serp_item: { url: 'https://demo-hvac.example' + path, etv: vol * 0.05, estimated_paid_traffic_cost: vol * 0.05 * cpc } } })) };
  }

  async adsSearch() {
    this._cost(0.002);
    const now = new Date();
    const d = (days) => new Date(now - days * 864e5).toISOString().slice(0, 19).replace('T', ' ') + ' +00:00';
    return {
      items_count: 27,
      items: [
        { type: 'ads_search', title: 'Demo HVAC (sample)', format: 'text', first_shown: d(610), last_shown: d(1), verified: true, url: 'https://adstransparency.google.com/' },
        { type: 'ads_search', title: 'Demo HVAC (sample)', format: 'text', first_shown: d(200), last_shown: d(3), verified: true },
        { type: 'ads_search', title: 'Demo HVAC (sample)', format: 'image', first_shown: d(400), last_shown: d(90), verified: true },
      ],
    };
  }
}

const DEMO_HTML = `<!doctype html><html><head><title>Demo HVAC</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://www.googletagmanager.com/gtag/js?id=G-DEMO12345"></script></head>
<body><h1>Welcome to Demo HVAC</h1><h1>Our Services</h1>
<p>Call us at 555-010-0000 for air conditioning service. Family owned since 1998.</p>
<a href="/about">About</a><a href="/contact">Contact</a><a href="/services">Services</a>
<img src="a.jpg"><img src="b.jpg"><img src="c.jpg" alt="truck">
<footer>&copy; 2019 Demo HVAC (sample site)</footer></body></html>`;

async function demoAudit(url) {
  const page = analyzeHtml(DEMO_HTML, url || 'https://demo-hvac.example/');
  const pagespeed = { performance: 31, accessibility: 72, bestPractices: 78, seo: 83, lcpMs: 7400, cls: 0.21, tbtMs: 980, fcpMs: 3100 };
  const fetchInfo = { finalUrl: url || 'https://demo-hvac.example/', ms: 2900 };
  return { ok: true, url, finalUrl: fetchInfo.finalUrl, status: 200, responseMs: fetchInfo.ms, page, pagespeed, ...scoreAudit(page, pagespeed, fetchInfo) };
}

module.exports = { DemoClient, demoAudit };
