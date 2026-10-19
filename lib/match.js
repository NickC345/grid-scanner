// Helpers to decide whether a search result is the business being scanned.

const STOP = new Set(['llc', 'inc', 'co', 'company', 'corp', 'the', 'and', '&', 'of', 'services', 'service']);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}

function normDomain(d) {
  if (!d) return '';
  let s = String(d).toLowerCase().trim();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.split('/')[0].split('?')[0];
}

// Token overlap similarity (0..1) between two business names.
function nameSimilarity(a, b) {
  const ta = new Set(normName(a).split(' ').filter(Boolean));
  const tb = new Set(normName(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/**
 * target: {cid, place_id, title, domain}
 * item:   a DataForSEO maps item
 */
function isTarget(target, item) {
  if (!item) return false;
  if (target.cid && item.cid && String(target.cid) === String(item.cid)) return true;
  if (target.place_id && item.place_id && target.place_id === item.place_id) return true;
  const sameDomain = target.domain && item.domain && normDomain(target.domain) === normDomain(item.domain);
  const sim = nameSimilarity(target.title, item.title);
  if (sameDomain && sim >= 0.5) return true;
  // Without IDs, require a very close name match.
  if (!target.cid && !target.place_id && sim >= 0.9) return true;
  return false;
}

function domainMatches(targetDomain, d) {
  const a = normDomain(targetDomain);
  const b = normDomain(d);
  if (!a || !b) return false;
  return a === b || b.endsWith('.' + a) || a.endsWith('.' + b);
}

module.exports = { normName, normDomain, nameSimilarity, isTarget, domainMatches };
