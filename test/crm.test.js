const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, summarizeScan } = require('../lib/store');
const { DataForSEO } = require('../lib/dataforseo');
const { runScan, estimateCost } = require('../lib/scan');
const { DemoClient, demoAudit } = require('../lib/demo');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));
const biz = { title: 'Cool Breeze', address: '1 Main St, Tampa, FL', cid: '111', lat: 27.95, lng: -82.46, domain: 'coolbreeze.example' };

async function demoScan() {
  const client = new DemoClient();
  const scan = await runScan(client, { business: { ...biz }, keywords: ['ac repair'], spacing: 1, searchAds: false, spend: true, auditFn: demoAudit });
  return { id: '2026-01-01-abcd1234', createdAt: '2026-01-01T12:00:00.000Z', ...scan };
}

test('store: save, move, call time, notes and persistence', async () => {
  const dir = tmp();
  const store = new Store(dir);
  const scan = await demoScan();
  const lead = store.create(biz, scan);
  assert.strictEqual(lead.status, 'new');
  assert.strictEqual(lead.latest.cells.length, 99);
  assert.ok(store.findByBusiness({ cid: '111' }));

  store.update(lead.id, { contact: { name: 'Pat', email: 'pat@x.com', phone: '555' }, callAt: '2026-10-24T14:30' });
  assert.throws(() => store.update(lead.id, { callAt: 'tomorrow' }), /Call time/);
  store.move(lead.id, 'call', 0);
  store.addNote(lead.id, 'Left voicemail');
  assert.throws(() => store.move(lead.id, 'nonsense'), /Unknown stage/);

  const reloaded = new Store(dir);
  const again = reloaded.get(lead.id);
  assert.strictEqual(again.status, 'call');
  assert.strictEqual(again.callAt, '2026-10-24T14:30');
  assert.strictEqual(again.contact.name, 'Pat');
  assert.ok(again.notes.some((n) => n.kind === 'note' && n.text === 'Left voicemail'));
  assert.ok(again.notes.some((n) => n.kind === 'activity' && /Moved to Call scheduled/.test(n.text)));
});

test('store: becoming a client creates a workspace with baseline and checklists', async () => {
  const store = new Store(tmp());
  const lead = store.create(biz, await demoScan());
  store.move(lead.id, 'client');
  const c = store.get(lead.id).client;
  assert.ok(c.baseline && c.baseline.id === lead.latest.id);
  assert.ok(c.checklists.onboarding.length >= 4);
  assert.deepStrictEqual(c.services, { web: false, ads: false, seo: false });

  store.setClient(lead.id, {
    monthlyFee: '1500',
    services: { web: true },
    checklists: { web: [{ text: 'Draft home page', done: true }, { text: '   ' }] },
  });
  const c2 = store.get(lead.id).client;
  assert.strictEqual(c2.monthlyFee, 1500);
  assert.strictEqual(c2.services.web, true);
  assert.strictEqual(c2.checklists.web.length, 1, 'blank tasks are dropped');
  assert.match(c2.checklists.web[0].id, /^[a-z0-9-]+$/i, 'missing ids are generated');
});

test('store: ordering inside a column and a second scan joining the history', async () => {
  const store = new Store(tmp());
  const a = store.create({ ...biz, cid: 'a', title: 'A' });
  const b = store.create({ ...biz, cid: 'b', title: 'B' });
  const c = store.create({ ...biz, cid: 'c', title: 'C' });
  store.move(c.id, 'new', 0);
  const order = store.list().filter((l) => l.status === 'new').sort((x, y) => x.order - y.order).map((l) => l.business.title);
  assert.deepStrictEqual(order, ['C', 'A', 'B']);

  const scan = await demoScan();
  store.attachScan(a.id, scan);
  store.attachScan(a.id, { ...scan, id: '2026-02-01-ffff0000', createdAt: '2026-02-01T12:00:00.000Z' });
  store.attachScan(a.id, scan); // same scan twice is not duplicated
  assert.strictEqual(store.get(a.id).scans.length, 2);
  assert.strictEqual(store.get(a.id).latest.id, '2026-02-01-ffff0000');
});

test('store: backup merge keeps the newer copy and ignores junk', async () => {
  const store = new Store(tmp());
  const lead = store.create(biz, await demoScan());
  const backup = JSON.parse(JSON.stringify(store.list()));
  backup[0].updatedAt = '2999-01-01T00:00:00.000Z';
  backup[0].contact.name = 'From backup';
  const res = store.importLeads([...backup, { id: '../evil', business: { title: 'x' } }, null, { id: 'ok1', business: { title: 'Fresh Co', lat: 1, lng: 2 } }]);
  assert.deepStrictEqual(res, { added: 1, updated: 1 });
  assert.strictEqual(store.get(lead.id).contact.name, 'From backup');
  assert.ok(store.get('ok1'));
  assert.ok(!store.get('../evil'));
});

test('store: a damaged file is kept aside, never silently overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'leads.json'), '{not json');
  const store = new Store(dir);
  assert.deepStrictEqual(store.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('leads.corrupt-')));
});

test('economy mode estimate is cheaper than fast mode', () => {
  assert.ok(estimateCost(1, { mode: 'economy' }) < estimateCost(1, { mode: 'fast' }));
  assert.ok(estimateCost(1, { mode: 'economy', searchAds: true }) > estimateCost(1, { mode: 'economy' }));
});

test('DataForSEO queued maps: posts in chunks, collects results, reports failures', async () => {
  const realFetch = global.fetch;
  const posts = [];
  let readyCalls = 0;
  const ids = new Map(); // id -> tag
  const reply = (body) => ({ ok: true, status: 200, json: async () => ({ status_code: 20000, cost: 0, ...body }) });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/serp/google/maps/task_post')) {
      const tasks = JSON.parse(init.body);
      posts.push(tasks.length);
      return reply({
        cost: tasks.length * 0.0006,
        tasks: tasks.map((t, i) => {
          if (t.keyword === 'reject me') return { status_code: 40501, status_message: 'Invalid Field' };
          const id = `id-${t.tag}`;
          ids.set(id, t.tag);
          return { id, status_code: 20100, status_message: 'Task Created' };
        }),
      });
    }
    if (u.endsWith('/serp/google/maps/tasks_ready')) {
      readyCalls++;
      if (readyCalls < 2) return reply({ tasks: [{ status_code: 20000, result: [] }] });
      return reply({ tasks: [{ status_code: 20000, result: [...ids.keys()].map((id) => ({ id })) }] });
    }
    const m = u.match(/task_get\/advanced\/(.+)$/);
    if (m) {
      const tag = ids.get(m[1]);
      if (tag === '3') return reply({ tasks: [{ status_code: 40102, status_message: 'No Search Results.' }] });
      return reply({ tasks: [{ status_code: 20000, result: [{ items: [{ type: 'maps_search', rank_group: 1, title: `r${tag}` }] }] }] });
    }
    throw new Error('unexpected ' + u);
  };
  try {
    const client = new DataForSEO('a', 'b');
    const tasks = Array.from({ length: 230 }, (_, i) => ({ keyword: i === 7 ? 'reject me' : 'ac repair', location_coordinate: '1,2,14z' }));
    const seen = [];
    const out = await client.mapsBatch(tasks, { pollMs: 5, onResult: (i) => seen.push(i) });
    assert.deepStrictEqual(posts, [100, 100, 30], 'tasks are posted 100 at a time');
    assert.strictEqual(out.length, 230);
    assert.strictEqual(seen.length, 230, 'every task reports exactly once');
    assert.match(out[7].error, /Invalid Field/);
    assert.deepStrictEqual(out[3].result, { items: [] }, 'no results is a normal outcome');
    assert.strictEqual(out[0].result.items[0].title, 'r0');
    assert.strictEqual(out[229].result.items[0].title, 'r229');
    assert.ok(client.totalCost > 0.13 && client.totalCost < 0.15);
  } finally {
    global.fetch = realFetch;
  }
});

test('queued scan end to end with the demo client', async () => {
  const scan = await demoScan();
  assert.strictEqual(scan.keywords[0].cells.length, 99);
  assert.ok(scan.cost < 0.1, 'economy scan is cheap: ' + scan.cost);
  assert.strictEqual(summarizeScan({ ...scan, id: 'x' }).cells.length, 99);
});
