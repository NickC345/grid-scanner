const test = require('node:test');
const assert = require('node:assert');

const { buildGrid, samplePoints, milesPerDegLng } = require('../lib/grid');
const { isTarget, nameSimilarity, normDomain, domainMatches } = require('../lib/match');
const { analyzeHtml, scoreAudit } = require('../lib/audit');
const { runScan, locate } = require('../lib/scan');
const { DemoClient, demoAudit } = require('../lib/demo');

test('grid is 9 wide x 11 tall with correct spacing', () => {
  const pts = buildGrid(27.9506, -82.4572, 1);
  assert.strictEqual(pts.length, 99);
  const center = pts.find((p) => p.isCenter);
  assert.deepStrictEqual([center.row, center.col], [5, 4]);
  assert.strictEqual(center.lat, 27.9506);
  const nw = pts[0];
  const se = pts[98];
  // 10 rows apart vertically = 10 miles, 8 cols apart horizontally = 8 miles
  assert.ok(Math.abs((nw.lat - se.lat) * 69 - 10) < 0.01);
  assert.ok(Math.abs((se.lng - nw.lng) * milesPerDegLng(27.9506) - 8) < 0.01);
  assert.ok(nw.lat > se.lat && nw.lng < se.lng);
  assert.strictEqual(samplePoints(pts).length, 9);
});

test('business matching', () => {
  assert.strictEqual(normDomain('https://www.Example.com/ac-repair?x=1'), 'example.com');
  assert.ok(domainMatches('example.com', 'www.example.com'));
  assert.ok(!domainMatches('example.com', 'notexample.org'));
  assert.ok(nameSimilarity('Cool Breeze Heating & Air LLC', 'Cool Breeze Heating and Air') >= 0.9);
  const t = { cid: '123', title: 'Cool Breeze', domain: 'coolbreeze.com' };
  assert.ok(isTarget(t, { cid: '123', title: 'Other' }));
  assert.ok(isTarget(t, { cid: '999', title: 'Cool Breeze AC', domain: 'coolbreeze.com' }));
  assert.ok(!isTarget(t, { cid: '999', title: 'Arctic Air', domain: 'arctic.com' }));
});

test('website audit detects conversion basics and tracking', () => {
  const html = `<html><head><title>Cool Breeze AC Repair in Tampa, FL</title>
    <meta name="viewport" content="width=device-width"><meta name="description" content="${'x'.repeat(60)}">
    <script async src="https://www.googletagmanager.com/gtag/js?id=AW-1234567"></script>
    <script src="//cdn.callrail.com/companies/1/swap.js"></script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"HVACBusiness"}</script></head>
    <body><h1>AC Repair Tampa</h1><a href="tel:8135550100">Call (813) 555-0100</a>
    <form><input name="a"><input name="b"></form><p>Schedule service today. Licensed and insured. 5 star reviews.</p>
    <a href="/ac-repair">x</a><a href="/ac-installation">x</a><a href="/heating-repair">x</a>
    <footer>© ${new Date().getFullYear()} Cool Breeze</footer></body></html>`;
  const page = analyzeHtml(html, 'https://coolbreeze.com/');
  assert.ok(page.tracking.googleAdsTag);
  assert.ok(page.tracking.callTracking);
  assert.ok(page.localSchema);
  assert.strictEqual(page.telLinks, 1);
  assert.strictEqual(page.forms, 1);
  assert.strictEqual(page.servicePageCount, 3);
  const scored = scoreAudit(page, { performance: 80 }, { finalUrl: 'https://coolbreeze.com/', ms: 500 });
  assert.ok(scored.score >= 90, 'good site scores high: ' + scored.score);
});

test('full demo scan runs end to end', async () => {
  const client = new DemoClient();
  const [biz] = await locate(client, 'Demo Heating', '100 Demo St Tampa FL');
  const scan = await runScan(client, { business: biz, keywords: ['ac repair', 'hvac company'], spacing: 1, searchAds: true, spend: true, auditFn: demoAudit });
  assert.strictEqual(scan.keywords.length, 2);
  assert.strictEqual(scan.keywords[0].cells.length, 99);
  assert.strictEqual(scan.searchAds.samples.length, 18);
  assert.strictEqual(scan.spending.level, 'yes');
  assert.ok(scan.waste.score > 0);
  assert.ok(scan.waste.reasons.some((r) => /irrelevant/i.test(r.title)));
  assert.ok(scan.website.score < 80);
  assert.ok(scan.keywords[0].stats.found > 0);
});
