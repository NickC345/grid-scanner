// Quick website audit: fetches the homepage, checks conversion basics,
// tracking tags and trust signals, and runs Google PageSpeed (mobile).

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const PATTERNS = {
  googleAdsTag: /AW-\d{6,}|googleadservices\.com\/pagead\/conversion|google_conversion_id/i,
  gtm: /GTM-[A-Z0-9]{4,}/,
  ga4: /\bG-[A-Z0-9]{6,}\b|gtag\/js\?id=G-/,
  metaPixel: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(/i,
  callTracking: /callrail|calltrk|whatconverts|calltrackingmetrics|tctm\.co|invoca|marchex|phonewagon/i,
  booking: /servicetitan|scheduler\.servicetitan|housecallpro|book\.housecallpro|scheduleengine|calendly|jobber|getjobber|workiz|fieldedge|successware|setmore|acuityscheduling/i,
  chat: /podium|birdeye|intercom|tawk\.to|drift\.com|livechatinc|tidio|smith\.ai|hubspot.*conversations|zendesk|olark|crisp\.chat|leadconnector|gohighlevel/i,
  reviewsWidget: /elfsight|trustindex|birdeye|podium|reviewsonmywebsite|grade\.us|nicejob|embedsocial|widget\.trustpilot/i,
};

const BUILDERS = [
  ['WordPress', /wp-content|wp-includes/i],
  ['Wix', /wix\.com|_wixCIDX|wixstatic/i],
  ['Squarespace', /squarespace/i],
  ['GoDaddy Website Builder', /godaddy|img1\.wsimg\.com/i],
  ['Duda', /dudaone|multiscreensite|duda\.co/i],
  ['Webflow', /webflow/i],
  ['Shopify', /cdn\.shopify\.com/i],
  ['Weebly', /weebly/i],
  ['GoHighLevel', /leadconnectorhq|msgsndr/i],
];

const CTA_RE = /schedule|book (now|online|service|an appointment)|request (service|a quote|an estimate)|free (estimate|quote)|get (a )?quote|call (us )?(now|today)|contact us/i;
const PHONE_RE = /\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  const started = Date.now();
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  return { status: res.status, finalUrl: res.url, html, ms: Date.now() - started };
}

async function pageSpeed(url, apiKey) {
  const params = new URLSearchParams({ url, strategy: 'mobile' });
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) params.append('category', c);
  if (apiKey) params.set('key', apiKey);
  const res = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + params, {
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json.error && json.error.message) || `PageSpeed HTTP ${res.status}`);
  const lh = json.lighthouseResult || {};
  const cat = lh.categories || {};
  const aud = lh.audits || {};
  const score = (k) => (cat[k] && typeof cat[k].score === 'number' ? Math.round(cat[k].score * 100) : null);
  const num = (k) => (aud[k] && typeof aud[k].numericValue === 'number' ? aud[k].numericValue : null);
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
    lcpMs: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbtMs: num('total-blocking-time'),
    fcpMs: num('first-contentful-paint'),
  };
}

function analyzeHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const title = $('title').first().text().trim();
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const telLinks = $('a[href^="tel:"]').length;
  const forms = $('form').filter((_, f) => $(f).find('input,textarea').length >= 2).length;
  const imgs = $('img');
  const imgsNoAlt = imgs.filter((_, el) => !($(el).attr('alt') || '').trim()).length;

  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    const m = raw.match(/"@type"\s*:\s*("([^"]+)"|\[[^\]]*\])/g) || [];
    for (const t of m) schemaTypes.push(t.replace(/"@type"\s*:\s*/, '').replace(/[\[\]"]/g, ''));
  });
  const localSchema = schemaTypes.some((t) => /LocalBusiness|HVACBusiness|HomeAndConstructionBusiness|Plumber|Electrician|Organization/i.test(t));

  const years = (text.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i) || [])[1];
  const copyrightYear = years ? Number(years) : null;

  const builder = (BUILDERS.find(([, re]) => re.test(html)) || [null])[0];

  const internalLinks = new Set();
  let host = '';
  try {
    host = new URL(finalUrl).hostname;
  } catch {}
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), finalUrl);
      if (u.hostname === host) internalLinks.add(u.pathname.replace(/\/$/, ''));
    } catch {}
  });
  const servicePages = [...internalLinks].filter((p) => /repair|install|replace|maintenance|tune|service|cooling|heating|ac-|air-condition|hvac|duct|heat-pump|furnace/i.test(p));

  return {
    title,
    metaDesc,
    hasViewport: /width=device-width/i.test(viewport),
    h1s,
    telLinks,
    forms,
    phoneVisible: PHONE_RE.test(text),
    ctaFound: CTA_RE.test(text),
    imgs: imgs.length,
    imgsNoAlt,
    schemaTypes: [...new Set(schemaTypes)],
    localSchema,
    copyrightYear,
    builder,
    servicePageCount: servicePages.length,
    hasReviewsText: /reviews?|testimonials?|★|stars?/i.test(text),
    hasTrustText: /licensed|insured|certified|nate|bbb|financing|warranty|guarantee/i.test(text),
    hasFinancing: /financing|0% apr|monthly payments/i.test(text),
    hasEmergency: /24\/7|24 hours|emergency/i.test(text),
    tracking: {
      googleAdsTag: PATTERNS.googleAdsTag.test(html),
      gtm: PATTERNS.gtm.test(html),
      ga4: PATTERNS.ga4.test(html),
      metaPixel: PATTERNS.metaPixel.test(html),
      callTracking: PATTERNS.callTracking.test(html),
    },
    booking: PATTERNS.booking.test(html),
    chat: PATTERNS.chat.test(html),
    reviewsWidget: PATTERNS.reviewsWidget.test(html),
    htmlKb: Math.round(Buffer.byteLength(html, 'utf8') / 1024),
    wordCount: text.split(' ').length,
  };
}

// Turns raw findings into a 0-100 score plus a list of checks.
function scoreAudit(page, psi, fetchInfo) {
  const checks = [];
  const add = (id, label, pass, weight, detail, severity = 'high') =>
    checks.push({ id, label, pass, weight, detail, severity: pass ? 'ok' : severity });

  const https = fetchInfo.finalUrl.startsWith('https://');
  add('https', 'Secure HTTPS connection', https, 8, https ? 'Site loads over HTTPS' : 'Site loads without HTTPS; browsers show "Not secure"');
  add('viewport', 'Mobile-friendly layout', page.hasViewport, 8, page.hasViewport ? 'Has a mobile viewport tag' : 'No mobile viewport tag; page likely renders zoomed out on phones');
  add('tel', 'Click-to-call button', page.telLinks > 0, 10, page.telLinks > 0 ? `${page.telLinks} tap-to-call link(s)` : 'No tel: links; mobile visitors cannot tap to call');
  add('form', 'Quote / booking form', page.forms > 0 || page.booking, 8, page.booking ? 'Online booking tool detected' : page.forms > 0 ? `${page.forms} lead form(s) on the homepage` : 'No form or online booking on the homepage');
  add('cta', 'Clear call to action', page.ctaFound, 6, page.ctaFound ? 'Found "schedule / free estimate / call now" style CTA' : 'No clear call to action text found', 'medium');
  add('reviews', 'Reviews / testimonials shown', page.hasReviewsText || page.reviewsWidget, 6, page.reviewsWidget ? 'Review widget detected' : page.hasReviewsText ? 'Mentions reviews or testimonials' : 'No reviews or testimonials on the homepage', 'medium');
  add('trust', 'Trust signals (licensed, warranty, financing)', page.hasTrustText, 4, page.hasTrustText ? 'Mentions licensing, warranty or financing' : 'No licensing, warranty or financing mentions', 'medium');
  add('title', 'Page title', page.title.length >= 15 && page.title.length <= 70, 4, page.title ? `"${page.title.slice(0, 80)}" (${page.title.length} chars)` : 'Missing <title>', 'medium');
  add('meta', 'Meta description', page.metaDesc.length >= 50, 3, page.metaDesc ? `${page.metaDesc.length} characters` : 'Missing meta description', 'low');
  add('h1', 'Single clear H1 headline', page.h1s.length === 1, 3, page.h1s.length ? `${page.h1s.length} H1 tag(s): "${page.h1s[0].slice(0, 60)}"` : 'No H1 headline', 'low');
  add('schema', 'Local business schema markup', page.localSchema, 4, page.localSchema ? `Schema: ${page.schemaTypes.slice(0, 4).join(', ')}` : 'No LocalBusiness/HVACBusiness structured data', 'low');
  add('pages', 'Dedicated service pages', page.servicePageCount >= 3, 5, `${page.servicePageCount} service page link(s) found`, 'medium');
  const yearNow = new Date().getFullYear();
  const fresh = page.copyrightYear ? page.copyrightYear >= yearNow - 1 : true;
  add('fresh', 'Site looks maintained', fresh, 3, page.copyrightYear ? `Copyright year ${page.copyrightYear}` : 'No copyright year found', 'low');
  const altOk = page.imgs === 0 || page.imgsNoAlt / page.imgs <= 0.3;
  add('alt', 'Image alt text', altOk, 2, `${page.imgsNoAlt} of ${page.imgs} images missing alt text`, 'low');
  add('response', 'Fast server response', fetchInfo.ms < 2500, 4, `Homepage HTML loaded in ${(fetchInfo.ms / 1000).toFixed(1)}s`, 'medium');

  if (psi && psi.performance !== null) {
    const p = psi.performance;
    add('speed', 'Mobile page speed (Google PageSpeed)', p >= 50, 14, `Mobile performance ${p}/100${psi.lcpMs ? `, largest paint ${(psi.lcpMs / 1000).toFixed(1)}s` : ''}`, p < 30 ? 'high' : 'medium');
  }

  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  let score = Math.round((got / total) * 100);
  if (psi && psi.performance !== null && psi.performance < 50) score = Math.min(score, 85);
  const verdict = score >= 80 ? 'Solid' : score >= 60 ? 'Needs work' : 'Needs a rebuild';
  return { score, verdict, checks };
}

async function auditWebsite(rawUrl, { pagespeedKey, skipPageSpeed = false } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error: 'No website found for this business' };
  const out = { ok: true, url };
  const psiPromise = skipPageSpeed ? Promise.resolve(null) : pageSpeed(url, pagespeedKey).catch((e) => ({ error: e.message }));
  try {
    const f = await fetchPage(url);
    out.finalUrl = f.finalUrl;
    out.status = f.status;
    out.responseMs = f.ms;
    if (f.status >= 400) {
      out.ok = false;
      out.error = `Website returned HTTP ${f.status}`;
    }
    out.page = analyzeHtml(f.html, f.finalUrl);
    const psi = await psiPromise;
    out.pagespeed = psi && !psi.error ? psi : null;
    out.pagespeedError = psi && psi.error ? psi.error : null;
    Object.assign(out, scoreAudit(out.page, out.pagespeed, f));
  } catch (e) {
    out.ok = false;
    out.error = `Could not load website: ${e.message}`;
    const psi = await psiPromise;
    out.pagespeed = psi && !psi.error ? psi : null;
  }
  return out;
}

module.exports = { auditWebsite, analyzeHtml, scoreAudit, normalizeUrl };
