// Turns raw scan data into rank stats, spend evidence and a waste score.

const { normDomain } = require('./match');

function rankStats(cells) {
  const n = cells.length;
  const found = cells.filter((c) => c.rank !== null);
  const top3 = found.filter((c) => c.rank <= 3).length;
  // Average rank position, counting "not in top 20" as 21 (same convention as most grid tools).
  const arp = n ? cells.reduce((s, c) => s + (c.rank === null ? 21 : c.rank), 0) / n : null;
  const avgFound = found.length ? found.reduce((s, c) => s + c.rank, 0) / found.length : null;
  return {
    points: n,
    found: found.length,
    foundPct: n ? Math.round((found.length / n) * 100) : 0,
    top3: top3,
    top3Pct: n ? Math.round((top3 / n) * 100) : 0,
    avgRank: arp === null ? null : Math.round(arp * 10) / 10,
    avgRankWhenFound: avgFound === null ? null : Math.round(avgFound * 10) / 10,
    best: found.length ? Math.min(...found.map((c) => c.rank)) : null,
    mapsAdPoints: cells.filter((c) => c.targetMapsAd).length,
  };
}

function competitorStats(cells, targetKey) {
  const map = new Map();
  for (const c of cells) {
    for (const t of c.top || []) {
      const key = t.cid || t.title;
      if (key === targetKey) continue;
      const e = map.get(key) || { title: t.title, domain: t.domain || '', rating: t.rating, reviews: t.reviews, appearances: 0, top3: 0, rankSum: 0, mapsAds: 0 };
      e.appearances++;
      e.rankSum += t.rank;
      if (t.rank <= 3) e.top3++;
      map.set(key, e);
    }
    for (const ad of c.mapsAds || []) {
      const key = ad.cid || ad.title;
      if (key === targetKey) continue;
      const e = map.get(key) || { title: ad.title, domain: ad.domain || '', rating: ad.rating, reviews: ad.reviews, appearances: 0, top3: 0, rankSum: 0, mapsAds: 0 };
      e.mapsAds++;
      map.set(key, e);
    }
  }
  return [...map.values()]
    .map((e) => ({ ...e, avgRank: e.appearances ? Math.round((e.rankSum / e.appearances) * 10) / 10 : null, rankSum: undefined }))
    .sort((a, b) => b.top3 - a.top3 || b.appearances - a.appearances)
    .slice(0, 10);
}

const IRRELEVANT_KW = /\b(jobs?|careers?|hiring|salary|salaries|school|training|course|class(es)?|certification|license test|diy|how to|youtube|reddit|manual|wholesale|supply|supplies|parts store|definition|what is|meaning|free)\b/i;

function adLandingStats(samples, targetDomain) {
  const urls = samples.filter((s) => s.targetAd && s.targetAd.url).map((s) => s.targetAd.url);
  const homepage = urls.filter((u) => {
    try {
      const p = new URL(u).pathname.replace(/\/+$/, '');
      return p === '' || p === '/index.html' || p === '/home';
    } catch {
      return false;
    }
  });
  return { urls: [...new Set(urls)], homepageCount: homepage.length, total: urls.length };
}

function spendingVerdict(scan) {
  const evidence = [];
  const targetDomain = scan.business.domain;

  const mapsAdPoints = scan.keywords.reduce((s, k) => s + k.stats.mapsAdPoints, 0);
  const mapsChecks = scan.keywords.reduce((s, k) => s + k.cells.length, 0);
  if (mapsAdPoints > 0) evidence.push({ strong: true, text: `Sponsored Google Maps listing seen at ${mapsAdPoints} of ${mapsChecks} map searches` });

  const sa = scan.searchAds || { samples: [] };
  const adHits = sa.samples.filter((s) => s.targetAd).length;
  if (adHits > 0) evidence.push({ strong: true, text: `Google Search ad seen at ${adHits} of ${sa.samples.length} sampled searches` });
  const lsaHits = sa.samples.filter((s) => s.targetLsa).length;
  if (lsaHits > 0) evidence.push({ strong: true, text: `Local Services Ad (Google Guaranteed) seen at ${lsaHits} of ${sa.samples.length} sampled searches` });

  const tr = scan.transparency;
  if (tr && tr.ok && tr.totalAds > 0) {
    evidence.push({
      strong: tr.activeAds30d > 0,
      text: `${tr.totalAds} ad(s) in Google's Ads Transparency Center${tr.activeAds30d ? `, ${tr.activeAds30d} shown in the last 30 days` : ''}${tr.firstShown ? ` (advertising since ${tr.firstShown.slice(0, 10)})` : ''}`,
    });
  }

  const labs = scan.labs;
  if (labs && labs.ok && labs.paidKeywords > 0) {
    evidence.push({ strong: false, text: `Bidding on about ${labs.paidKeywords} keyword(s) in Google Search (DataForSEO keyword database)` });
  }

  const strong = evidence.filter((e) => e.strong).length;
  let verdict, level;
  if (strong > 0) {
    verdict = 'Yes, actively advertising';
    level = 'yes';
  } else if (evidence.length > 0) {
    verdict = 'Likely, but not seen live during this scan';
    level = 'likely';
  } else {
    verdict = 'No ad spend detected';
    level = 'no';
  }

  return {
    verdict,
    level,
    evidence,
    estMonthlySpend: labs && labs.ok && labs.estMonthlyCost ? Math.round(labs.estMonthlyCost) : null,
    estMonthlyClicks: labs && labs.ok && labs.paidEtv ? Math.round(labs.paidEtv) : null,
    searchAdCoveragePct: sa.samples.length ? Math.round((adHits / sa.samples.length) * 100) : null,
    targetDomain,
  };
}

function wasteScore(scan) {
  const reasons = [];
  const add = (points, title, detail) => reasons.push({ points, title, detail });
  const spending = scan.spending;
  const site = scan.website || {};
  const page = site.page;
  const psi = site.pagespeed;
  const sa = scan.searchAds || { samples: [] };

  if (spending.level === 'no') {
    return { score: null, level: 'n/a', reasons: [], summary: 'No ad spend detected, so there is nothing to waste yet. Pitch angle: they are invisible in paid results while competitors buy the clicks.' };
  }

  if (page) {
    const t = page.tracking;
    if (!t.googleAdsTag && !t.gtm) add(20, 'No conversion tracking found', 'No Google Ads conversion tag or Tag Manager on the site. Google cannot tell which clicks became calls, so bidding runs blind.');
    else if (!t.googleAdsTag && t.gtm) add(8, 'Conversion tracking not confirmed', 'Tag Manager is installed but no Google Ads conversion tag is visible in the page. It may be configured inside GTM; verify.');
    if (!t.callTracking) add(8, 'No call tracking', 'No CallRail, WhatConverts or similar. HVAC leads are mostly phone calls, so they cannot see which ads produce calls.');
    if (page.telLinks === 0) add(10, 'No tap-to-call on the landing page', 'Mobile ad clicks land on a page without a tap-to-call link.');
    if (page.forms === 0 && !page.booking) add(6, 'No form or online booking', 'Visitors who will not call have no way to convert.');
    if (!page.hasViewport) add(10, 'Not mobile friendly', 'Most HVAC ad clicks are on phones and this site has no mobile viewport.');
  } else if (site.error) {
    add(15, 'Website did not load', site.error);
  }

  if (psi && psi.performance !== null) {
    if (psi.performance < 35) add(14, 'Very slow mobile page', `PageSpeed mobile score ${psi.performance}/100. Slow pages lower Quality Score and raise cost per click.`);
    else if (psi.performance < 60) add(7, 'Slow mobile page', `PageSpeed mobile score ${psi.performance}/100.`);
  }

  const landing = adLandingStats(sa.samples, scan.business.domain);
  if (landing.total > 0 && landing.homepageCount === landing.total) {
    add(12, 'Ads send everyone to the homepage', 'Every ad seen pointed to the homepage instead of a page matching the search (e.g. "AC repair").');
  }

  const labs = scan.labs;
  if (labs && labs.ok && labs.keywords && labs.keywords.length) {
    const bad = labs.keywords.filter((k) => IRRELEVANT_KW.test(k.keyword));
    if (bad.length) {
      const share = bad.length / labs.keywords.length;
      add(Math.min(15, 5 + Math.round(share * 30)), 'Paying for irrelevant searches', `${bad.length} of ${labs.keywords.length} paid keywords look like non-buyers: ${bad.slice(0, 5).map((k) => `"${k.keyword}"`).join(', ')}.`);
    }
    const homepageKws = labs.keywords.filter((k) => {
      try {
        return new URL(k.url).pathname.replace(/\/+$/, '') === '';
      } catch {
        return false;
      }
    });
    if (landing.total === 0 && labs.keywords.length >= 5 && homepageKws.length / labs.keywords.length > 0.8) {
      add(10, 'Most paid keywords land on the homepage', `${homepageKws.length} of ${labs.keywords.length} paid keywords point to the homepage.`);
    }
  }

  const ranks = scan.keywords.map((k) => k.stats);
  const avgFoundPct = ranks.length ? ranks.reduce((s, r) => s + r.foundPct, 0) / ranks.length : 0;
  const avgTop3 = ranks.length ? ranks.reduce((s, r) => s + r.top3Pct, 0) / ranks.length : 0;
  if (avgTop3 < 15) add(8, 'Weak organic Maps ranking', `Top 3 on Maps at only ${Math.round(avgTop3)}% of grid points (found at ${Math.round(avgFoundPct)}%). They depend on paid clicks for visibility.`);

  const rating = scan.business.rating;
  if (rating && rating.value && rating.value < 4.3) add(8, 'Low star rating', `${rating.value} stars. Ad clicks from comparison shoppers convert poorly against 4.8+ competitors.`);
  else if (rating && rating.votes_count !== undefined && rating.votes_count < 50) add(5, 'Few reviews', `Only ${rating.votes_count} Google reviews, while competitors running ads usually have hundreds.`);

  if (spending.searchAdCoveragePct !== null && spending.searchAdCoveragePct > 0 && spending.searchAdCoveragePct < 34 && spending.level === 'yes') {
    add(4, 'Patchy ad coverage', `Ads appeared at only ${spending.searchAdCoveragePct}% of sampled points. Budget may be running out early or geo targeting is off.`);
  }

  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  const level = score >= 50 ? 'High' : score >= 25 ? 'Moderate' : 'Low';
  reasons.sort((a, b) => b.points - a.points);
  return { score, level, reasons, landing };
}

module.exports = { rankStats, competitorStats, spendingVerdict, wasteScore, IRRELEVANT_KW };
