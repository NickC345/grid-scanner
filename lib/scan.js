// Orchestrates a full scan: grid ranks, ad checks, spend data, website audit.

const { buildGrid, samplePoints, zoomForSpacing } = require('./grid');
const { isTarget, nameSimilarity, normDomain, domainMatches } = require('./match');
const { auditWebsite } = require('./audit');
const { rankStats, competitorStats, spendingVerdict, wasteScore } = require('./analysis');

const COLS = 9;
const ROWS = 11;
const US = 2840; // DataForSEO location_code for the United States

// Approximate DataForSEO list prices (USD), used only for the pre-scan estimate.
// mapsQueued is the price of a normal-priority (queued) Maps search; the real cost of every
// scan is read from the API responses and shown after the scan.
const PRICE = { mapsLive: 0.002, mapsQueued: 0.0006, organicLive: 0.002, labsOverview: 0.0101, labsRanked: 0.0111, adsSearch: 0.002, locate: 0.002 };

function estimateCost(keywordCount, { searchAds = false, spend = true, mode = 'economy' } = {}) {
  const points = COLS * ROWS;
  let c = points * keywordCount * (mode === 'fast' ? PRICE.mapsLive : PRICE.mapsQueued);
  if (searchAds) c += 9 * keywordCount * PRICE.organicLive;
  if (spend) c += PRICE.labsOverview + PRICE.labsRanked + PRICE.adsSearch;
  return Math.round(c * 100) / 100;
}

function pickRating(r) {
  if (!r) return null;
  return { value: r.value ?? null, votes_count: r.votes_count ?? null };
}

function toBusiness(item) {
  return {
    title: item.title,
    address: item.address,
    cid: item.cid || null,
    place_id: item.place_id || null,
    feature_id: item.feature_id || null,
    lat: item.latitude,
    lng: item.longitude,
    domain: normDomain(item.domain || item.url),
    url: item.url || null,
    phone: item.phone || null,
    category: item.category || null,
    rating: pickRating(item.rating),
    is_claimed: item.is_claimed ?? null,
  };
}

// Finds candidate Google Business Profiles for a name + address.
async function locate(client, name, address) {
  const result = await client.mapsLive({
    keyword: `${name} ${address}`.trim(),
    location_code: US,
    language_code: 'en',
    depth: 20,
  });
  const items = (result.items || []).filter((i) => i.type === 'maps_search' && i.latitude && i.longitude);
  return items
    .map((i) => ({ ...toBusiness(i), similarity: Math.round(nameSimilarity(name, i.title) * 100) / 100 }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 6);
}

function mapItem(i) {
  return {
    rank: i.rank_group,
    title: i.title,
    cid: i.cid || null,
    domain: normDomain(i.domain || i.url),
    rating: i.rating ? i.rating.value : null,
    reviews: i.rating ? i.rating.votes_count : null,
  };
}

function mapsTask(keyword, point, zoom) {
  return { keyword, location_coordinate: `${point.lat},${point.lng},${zoom}z`, language_code: 'en', depth: 20 };
}

async function scanCell(client, business, keyword, point, zoom) {
  return cellFromResult(business, point, await client.mapsLive(mapsTask(keyword, point, zoom)));
}

function cellFromResult(business, point, result) {
  const items = result.items || [];
  const organic = items.filter((i) => i.type === 'maps_search');
  const paid = items.filter((i) => i.type === 'maps_paid_item');
  const hit = organic.find((i) => isTarget(business, i));
  return {
    row: point.row,
    col: point.col,
    rank: hit ? hit.rank_group : null,
    targetMapsAd: paid.some((i) => isTarget(business, i)),
    top: organic.slice(0, 10).map(mapItem),
    mapsAds: paid.map(mapItem),
  };
}

async function scanSearchAds(client, business, keyword, point) {
  const result = await client.organicLive({
    keyword,
    location_coordinate: `${point.lat},${point.lng},1000`,
    language_code: 'en',
    device: 'mobile',
    os: 'android',
    depth: 10,
  });
  const items = result.items || [];
  const paid = items
    .filter((i) => i.type === 'paid')
    .map((i) => ({ pos: i.rank_group, domain: normDomain(i.domain || i.url), title: i.title, url: i.url, description: i.description }));
  const lsa = [];
  for (const blk of items.filter((i) => i.type === 'local_services')) {
    for (const s of blk.items || []) lsa.push({ title: s.title, domain: normDomain(s.domain || s.url), rating: s.rating ? s.rating.value : null, reviews: s.rating ? s.rating.votes_count : null });
  }
  const targetAd = paid.find((p) => domainMatches(business.domain, p.domain)) || null;
  const targetLsa = lsa.find((s) => domainMatches(business.domain, s.domain) || nameSimilarity(business.title, s.title) >= 0.75) || null;
  return { keyword, row: point.row, col: point.col, lat: point.lat, lng: point.lng, paid, lsa, targetAd, targetLsa };
}

async function spendData(client, domain) {
  const out = { labs: { ok: false }, transparency: { ok: false } };
  if (!domain) {
    out.labs.error = out.transparency.error = 'No website domain, so spend data could not be looked up';
    return out;
  }
  const labsP = (async () => {
    const ov = await client.domainRankOverview({ target: domain, location_code: US, language_code: 'en' });
    const m = (ov.items && ov.items[0] && ov.items[0].metrics) || {};
    const paid = m.paid || {};
    const organic = m.organic || {};
    let keywords = [];
    if (paid.count > 0) {
      const rk = await client.rankedKeywords({
        target: domain,
        location_code: US,
        language_code: 'en',
        item_types: ['paid'],
        limit: 100,
        order_by: ['ranked_serp_element.serp_item.etv,desc'],
      });
      keywords = (rk.items || []).map((it) => {
        const kd = it.keyword_data || {};
        const ki = kd.keyword_info || {};
        const si = (it.ranked_serp_element && it.ranked_serp_element.serp_item) || {};
        return { keyword: kd.keyword, cpc: ki.cpc ?? null, volume: ki.search_volume ?? null, url: si.url || null, etv: si.etv ?? null, cost: si.estimated_paid_traffic_cost ?? null };
      });
    }
    return {
      ok: true,
      paidKeywords: paid.count || 0,
      paidEtv: paid.etv || 0,
      estMonthlyCost: paid.estimated_paid_traffic_cost || 0,
      organicKeywords: organic.count || 0,
      organicEtv: organic.etv || 0,
      keywords,
    };
  })().catch((e) => ({ ok: false, error: e.message }));

  const trP = (async () => {
    const r = await client.adsSearch({ target: domain, location_code: US, platform: 'all', depth: 40 });
    const ads = (r.items || []).filter((i) => i.type === 'ads_search');
    const now = Date.now();
    const active = ads.filter((a) => a.last_shown && now - Date.parse(a.last_shown) < 30 * 864e5);
    const first = ads.map((a) => a.first_shown).filter(Boolean).sort()[0] || null;
    const last = ads.map((a) => a.last_shown).filter(Boolean).sort().pop() || null;
    const formats = {};
    for (const a of ads) formats[a.format || 'unknown'] = (formats[a.format || 'unknown'] || 0) + 1;
    return {
      ok: true,
      totalAds: r.items_count ?? ads.length,
      activeAds30d: active.length,
      firstShown: first,
      lastShown: last,
      formats,
      verified: ads.some((a) => a.verified),
      ads: ads.slice(0, 12).map((a) => ({ title: a.title, format: a.format, first_shown: a.first_shown, last_shown: a.last_shown, url: a.url, preview_url: a.preview_url })),
    };
  })().catch((e) => ({ ok: false, error: e.message }));

  [out.labs, out.transparency] = await Promise.all([labsP, trP]);
  return out;
}

/**
 * opts: { business, keywords[], spacing, website?, searchAds, spend, pagespeedKey }
 * onProgress({stage, done, total, message})
 */
async function runScan(client, opts, onProgress = () => {}) {
  const business = { ...opts.business };
  if (opts.website) {
    business.url = opts.website;
    business.domain = normDomain(opts.website);
  }
  const spacing = Number(opts.spacing) || 1;
  const zoom = zoomForSpacing(spacing);
  const points = buildGrid(business.lat, business.lng, spacing, COLS, ROWS);
  const samples = samplePoints(points, COLS, ROWS);
  const keywords = opts.keywords;

  const total = points.length * keywords.length + (opts.searchAds ? samples.length * keywords.length : 0);
  let done = 0;
  const tick = (message) => onProgress({ stage: 'scanning', done: ++done, total, message });

  const audit = opts.auditFn || ((url) => auditWebsite(url, { pagespeedKey: opts.pagespeedKey }));
  const websiteP = Promise.resolve()
    .then(() => audit(business.url))
    .catch((e) => ({ ok: false, error: e.message }));
  const spendP = opts.spend ? spendData(client, business.domain) : Promise.resolve({ labs: null, transparency: null });

  const errors = [];
  const keywordResults = [];
  const errorCell = (p) => ({ row: p.row, col: p.col, rank: null, error: true, top: [], mapsAds: [], targetMapsAd: false });

  // One entry per (keyword, grid point), searched either queued (cheaper) or live (faster).
  const jobs = [];
  for (const keyword of keywords) for (const p of points) jobs.push({ keyword, p });
  const economy = opts.mode !== 'fast' && typeof client.mapsBatch === 'function';
  let allCells;
  if (economy) {
    const batch = await client.mapsBatch(
      jobs.map((j) => mapsTask(j.keyword, j.p, zoom)),
      { onResult: () => tick('Waiting for Google Maps results') }
    );
    allCells = batch.map((r, i) => {
      const { keyword, p } = jobs[i];
      if (r && r.result) return cellFromResult(business, p, r.result);
      errors.push(`${keyword} @ ${p.row},${p.col}: ${(r && r.error) || 'no result'}`);
      return errorCell(p);
    });
  } else {
    allCells = await Promise.all(
      jobs.map(({ keyword, p }) =>
        scanCell(client, business, keyword, p, zoom)
          .catch((e) => {
            errors.push(`${keyword} @ ${p.row},${p.col}: ${e.message}`);
            return errorCell(p);
          })
          .finally(() => tick(`Maps: "${keyword}"`))
      )
    );
  }

  for (let ki = 0; ki < keywords.length; ki++) {
    const keyword = keywords[ki];
    const cells = allCells.slice(ki * points.length, (ki + 1) * points.length);
    const okCells = cells.filter((c) => !c.error);
    if (!okCells.length) throw new Error(`Every map search failed for "${keyword}". First error: ${errors[0]}`);
    keywordResults.push({
      keyword,
      cells,
      stats: rankStats(okCells),
      competitors: competitorStats(okCells, business.cid || business.title),
    });
  }

  let searchAds = { samples: [] };
  if (opts.searchAds) {
    const adJobs = [];
    for (const keyword of keywords) for (const p of samples) adJobs.push({ keyword, p });
    const results = await Promise.all(
      adJobs.map(({ keyword, p }) =>
        scanSearchAds(client, business, keyword, p)
          .catch((e) => {
            errors.push(`Search ads "${keyword}" @ ${p.row},${p.col}: ${e.message}`);
            return null;
          })
          .finally(() => tick(`Search ads: "${keyword}"`))
      )
    );
    searchAds.samples = results.filter(Boolean);
    const adv = new Map();
    for (const s of searchAds.samples) {
      for (const a of s.paid) {
        const e = adv.get(a.domain) || { domain: a.domain, title: a.title, count: 0, isTarget: domainMatches(business.domain, a.domain) };
        e.count++;
        adv.set(a.domain, e);
      }
      for (const l of s.lsa) {
        const k = 'lsa:' + l.title;
        const e = adv.get(k) || { domain: l.domain, title: l.title, count: 0, lsa: true, isTarget: domainMatches(business.domain, l.domain) };
        e.count++;
        adv.set(k, e);
      }
    }
    searchAds.advertisers = [...adv.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  }

  onProgress({ stage: 'finishing', done, total, message: 'Finishing website audit and spend lookup' });
  const [website, spend] = await Promise.all([websiteP, spendP]);

  const scan = {
    business,
    grid: { cols: COLS, rows: ROWS, spacing, zoom, points },
    keywords: keywordResults,
    searchAds,
    labs: spend.labs,
    transparency: spend.transparency,
    website,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
  };
  scan.spending = spendingVerdict(scan);
  scan.waste = wasteScore(scan);
  scan.cost = Math.round(client.totalCost * 10000) / 10000;
  scan.calls = client.calls;
  return scan;
}

module.exports = { runScan, locate, estimateCost, PRICE, COLS, ROWS };
