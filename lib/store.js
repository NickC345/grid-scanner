// Saved companies (leads): pipeline stage, contact details, notes, scan history and the
// client workspace. Kept in one JSON file inside DATA_DIR and written atomically.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const templates = require('./templates');

const STATUSES = ['new', 'contacted', 'responded', 'followup', 'call', 'client', 'lost'];
const STATUS_LABELS = {
  new: 'New lead',
  contacted: 'Contacted',
  responded: 'Responded',
  followup: 'Follow up',
  call: 'Call scheduled',
  client: 'Client',
  lost: 'Not interested',
};
const SERVICES = ['web', 'ads', 'seo'];
const CALL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9-]{1,48}$/i;

const validId = (v) => typeof v === 'string' && ID_RE.test(v);
const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function cleanBusiness(b = {}) {
  return {
    title: str(b.title),
    address: str(b.address, 300),
    cid: b.cid ? str(b.cid, 40) : null,
    place_id: b.place_id ? str(b.place_id, 80) : null,
    lat: Number(b.lat),
    lng: Number(b.lng),
    domain: str(b.domain, 120),
    url: b.url ? str(b.url, 300) : null,
    phone: b.phone ? str(b.phone, 40) : null,
    category: b.category ? str(b.category, 80) : null,
    rating: b.rating && typeof b.rating === 'object' ? { value: b.rating.value ?? null, votes_count: b.rating.votes_count ?? null } : null,
  };
}

// Compact snapshot of one scan, kept on the lead so cards and the client page need no big files.
function summarizeScan(scan) {
  const kws = scan.keywords || [];
  const cols = (scan.grid && scan.grid.cols) || 9;
  const rows = (scan.grid && scan.grid.rows) || 11;
  const cells = new Array(cols * rows).fill(null);
  if (kws[0]) for (const c of kws[0].cells) if (c.rank != null) cells[c.row * cols + c.col] = c.rank;
  const avg = (f) => (kws.length ? kws.reduce((a, k) => a + f(k), 0) / kws.length : null);
  const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    id: scan.id,
    at: scan.createdAt,
    keyword: kws.map((k) => k.keyword).join(', '),
    spacing: scan.grid && scan.grid.spacing,
    avgRank: r1(avg((k) => k.stats.avgRank ?? 21)),
    top3Pct: r1(avg((k) => k.stats.top3Pct)),
    foundPct: r1(avg((k) => k.stats.foundPct)),
    spending: scan.spending && scan.spending.level,
    estMonthlySpend: (scan.spending && scan.spending.estMonthlySpend) ?? null,
    waste: scan.waste && scan.waste.score,
    wasteLevel: scan.waste && scan.waste.level,
    websiteScore: scan.website && scan.website.score != null ? scan.website.score : null,
    demo: !!scan.demo,
    cells,
  };
}

function cleanItems(items, cap = 60) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, cap).map((it) => ({
    id: validId(it && it.id) ? it.id : newId(),
    text: str(it && it.text, 300),
    done: !!(it && it.done),
  })).filter((it) => it.text);
}

function templateItems(key) {
  return (templates[key] || []).map((text) => ({ id: newId(), text, done: false }));
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'leads.json');
    this.leads = [];
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    try {
      const j = JSON.parse(raw);
      this.leads = Array.isArray(j.leads) ? j.leads : [];
    } catch {
      // Never overwrite a damaged file: keep a copy so nothing is lost.
      fs.copyFileSync(this.file, path.join(this.dir, `leads.corrupt-${Date.now()}.json`));
      this.leads = [];
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, leads: this.leads }));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.leads;
  }

  get(id) {
    return this.leads.find((l) => l.id === id) || null;
  }

  findByBusiness(b) {
    return (
      this.leads.find((l) => (b.cid && l.business.cid === b.cid) || (b.place_id && l.business.place_id === b.place_id)) || null
    );
  }

  _log(lead, text) {
    lead.notes.unshift({ id: newId(), at: now(), text, kind: 'activity' });
    if (lead.notes.length > 300) lead.notes.length = 300;
  }

  _nextOrder(status) {
    const col = this.leads.filter((l) => l.status === status);
    return col.length ? Math.max(...col.map((l) => l.order)) + 1 : 0;
  }

  create(business, scan) {
    const lead = {
      id: newId(),
      createdAt: now(),
      updatedAt: now(),
      business: cleanBusiness(business),
      contact: { name: '', email: '', phone: '' },
      status: 'new',
      order: this._nextOrder('new'),
      callAt: '',
      notes: [],
      scans: [],
      latest: null,
      client: null,
    };
    this.leads.push(lead);
    if (scan) this.attachScan(lead.id, scan);
    else this.save();
    return lead;
  }

  attachScan(id, scan) {
    const lead = this.get(id);
    if (!lead) return null;
    const s = summarizeScan(scan);
    const i = lead.scans.findIndex((x) => x.id === s.id);
    if (i >= 0) lead.scans[i] = s;
    else {
      lead.scans.push(s);
      this._log(lead, `Scanned "${s.keyword}": average rank ${s.avgRank}, top 3 at ${s.top3Pct}% of points`);
    }
    lead.scans.sort((a, b) => (a.at < b.at ? -1 : 1));
    if (lead.scans.length > 100) lead.scans.splice(0, lead.scans.length - 100);
    lead.latest = lead.scans[lead.scans.length - 1];
    // Keep the saved business details fresh (rating, phone, website).
    const nb = scan.business || {};
    lead.business.rating = nb.rating || lead.business.rating;
    lead.business.phone = nb.phone || lead.business.phone;
    lead.business.domain = nb.domain || lead.business.domain;
    lead.business.url = nb.url || lead.business.url;
    lead.updatedAt = now();
    this.save();
    return lead;
  }

  update(id, patch) {
    const lead = this.get(id);
    if (!lead) return null;
    if (patch.contact && typeof patch.contact === 'object') {
      lead.contact = {
        name: str(patch.contact.name, 120),
        email: str(patch.contact.email, 160),
        phone: str(patch.contact.phone, 40),
      };
    }
    if (patch.callAt !== undefined) {
      const v = str(patch.callAt, 20);
      if (v && !CALL_RE.test(v)) throw Object.assign(new Error('Call time must look like 2026-10-24T14:30'), { status: 400 });
      if (v !== lead.callAt) {
        lead.callAt = v;
        this._log(lead, v ? `Call set for ${v.replace('T', ' at ')}` : 'Call time cleared');
      }
    }
    lead.updatedAt = now();
    this.save();
    return lead;
  }

  move(id, status, index) {
    const lead = this.get(id);
    if (!lead) return null;
    if (!STATUSES.includes(status)) throw Object.assign(new Error('Unknown stage'), { status: 400 });
    const changed = lead.status !== status;
    lead.status = status;
    const col = this.leads.filter((l) => l.status === status && l.id !== id).sort((a, b) => a.order - b.order);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, col.length)) : col.length;
    col.splice(at, 0, lead);
    col.forEach((l, i) => (l.order = i));
    if (changed) {
      this._log(lead, `Moved to ${STATUS_LABELS[status]}`);
      if (status === 'client') this._ensureClient(lead);
    }
    lead.updatedAt = now();
    this.save();
    return lead;
  }

  _ensureClient(lead) {
    if (lead.client) return;
    lead.client = {
      startedAt: now().slice(0, 10),
      monthlyFee: null,
      services: { web: false, ads: false, seo: false },
      checklists: { onboarding: templateItems('onboarding'), web: [], ads: [], seo: [] },
      baseline: lead.latest || null,
    };
  }

  setClient(id, body) {
    const lead = this.get(id);
    if (!lead) return null;
    this._ensureClient(lead);
    const c = lead.client;
    if (body.startedAt !== undefined) c.startedAt = DATE_RE.test(body.startedAt) ? body.startedAt : c.startedAt;
    if (body.monthlyFee !== undefined) {
      const n = body.monthlyFee === null || body.monthlyFee === '' ? null : Number(body.monthlyFee);
      c.monthlyFee = Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
    }
    if (body.services && typeof body.services === 'object') {
      for (const k of SERVICES) c.services[k] = !!body.services[k];
    }
    if (body.checklists && typeof body.checklists === 'object') {
      for (const k of ['onboarding', ...SERVICES]) if (k in body.checklists) c.checklists[k] = cleanItems(body.checklists[k]);
    }
    lead.updatedAt = now();
    this.save();
    return lead;
  }

  addNote(id, text) {
    const lead = this.get(id);
    if (!lead) return null;
    const t = str(text, 2000);
    if (!t) throw Object.assign(new Error('Write a note first'), { status: 400 });
    lead.notes.unshift({ id: newId(), at: now(), text: t, kind: 'note' });
    lead.updatedAt = now();
    this.save();
    return lead;
  }

  deleteNote(id, noteId) {
    const lead = this.get(id);
    if (!lead) return null;
    lead.notes = lead.notes.filter((n) => n.id !== noteId);
    this.save();
    return lead;
  }

  remove(id) {
    const before = this.leads.length;
    this.leads = this.leads.filter((l) => l.id !== id);
    if (this.leads.length !== before) this.save();
  }

  // Merge leads from a backup. Existing leads are replaced only when the backup copy is newer.
  importLeads(incoming) {
    let added = 0;
    let updated = 0;
    for (const raw of (Array.isArray(incoming) ? incoming : []).slice(0, 5000)) {
      if (!raw || !validId(raw.id) || !raw.business || !raw.business.title) continue;
      const lead = {
        id: raw.id,
        createdAt: str(raw.createdAt, 40) || now(),
        updatedAt: str(raw.updatedAt, 40) || now(),
        business: cleanBusiness(raw.business),
        contact: {
          name: str(raw.contact && raw.contact.name, 120),
          email: str(raw.contact && raw.contact.email, 160),
          phone: str(raw.contact && raw.contact.phone, 40),
        },
        status: STATUSES.includes(raw.status) ? raw.status : 'new',
        order: Number.isFinite(raw.order) ? raw.order : 0,
        callAt: CALL_RE.test(raw.callAt || '') ? raw.callAt : '',
        notes: (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 300).map((n) => ({
          id: validId(n && n.id) ? n.id : newId(),
          at: str(n && n.at, 40),
          text: str(n && n.text, 2000),
          kind: n && n.kind === 'activity' ? 'activity' : 'note',
        })),
        scans: (Array.isArray(raw.scans) ? raw.scans : []).slice(0, 100),
        latest: raw.latest || null,
        client: null,
      };
      if (raw.client && typeof raw.client === 'object') {
        const c = raw.client;
        lead.client = {
          startedAt: DATE_RE.test(c.startedAt || '') ? c.startedAt : now().slice(0, 10),
          monthlyFee: Number.isFinite(c.monthlyFee) ? c.monthlyFee : null,
          services: { web: !!(c.services && c.services.web), ads: !!(c.services && c.services.ads), seo: !!(c.services && c.services.seo) },
          checklists: {
            onboarding: cleanItems(c.checklists && c.checklists.onboarding),
            web: cleanItems(c.checklists && c.checklists.web),
            ads: cleanItems(c.checklists && c.checklists.ads),
            seo: cleanItems(c.checklists && c.checklists.seo),
          },
          baseline: c.baseline || null,
        };
      }
      const i = this.leads.findIndex((l) => l.id === lead.id);
      if (i < 0) {
        this.leads.push(lead);
        added++;
      } else if (lead.updatedAt > this.leads[i].updatedAt) {
        this.leads[i] = lead;
        updated++;
      }
    }
    if (added || updated) this.save();
    return { added, updated };
  }
}

module.exports = { Store, STATUSES, STATUS_LABELS, summarizeScan };
