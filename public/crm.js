// Pipeline board, company dialog and Clients workspace. Loaded after app.js, which provides window.GS.
(() => {
  const GS = window.GS;
  const { $, esc, money, api } = GS;

  const state = { leads: [], config: { stages: [], persistent: true }, templates: null, view: 'scan', clientId: null, leadId: null };
  const HINTS = {
    new: 'Saved from a scan',
    contacted: 'Email or call sent',
    responded: 'They wrote back',
    followup: 'Needs another touch',
    call: 'Soonest call first',
    client: 'Won. Opens a workspace',
    lost: 'Closed out',
  };
  const SERVICE_LABELS = { web: 'Website redesign', ads: 'Google Ads', seo: 'Local SEO' };
  const SPEND = { yes: ['warn', 'Running ads'], likely: ['warn', 'Likely runs ads'], no: ['none', 'No ads seen'] };
  const WASTE_TONE = { High: 'bad', Moderate: 'warn', Low: 'good' };

  const byId = (id) => state.leads.find((l) => l.id === id);
  const stageLabel = (id) => (state.config.stages.find((s) => s.id === id) || {}).label || id;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Math.random().toString(16).slice(2, 14));

  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      toast(e.message);
      await refreshLeads().catch(() => {});
      rerender();
      return null;
    }
  }

  // ---- formatting -------------------------------------------------------
  const fmtCall = (at) => {
    const d = new Date(at);
    return isNaN(d) ? at : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const cellClass = (r) => (r == null ? 'r4' : r <= 3 ? 'r1' : r <= 10 ? 'r2' : 'r3');
  const miniGrid = (cells, big) => `<div class="mini${big ? ' big' : ''}" aria-hidden="true">${(cells || []).map((r) => `<i class="${cellClass(r)}"></i>`).join('')}</div>`;
  const shortAddr = (a) => String(a || '').split(',').slice(-3, -1).join(',').trim() || String(a || '');

  // ---- data -------------------------------------------------------------
  async function refreshLeads() {
    state.leads = (await api('/api/leads')).leads;
    updateCounts();
    return state.leads;
  }
  function replaceLead(lead) {
    const i = state.leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) state.leads[i] = lead;
    else state.leads.push(lead);
  }
  function updateCounts() {
    const open = state.leads.filter((l) => l.status !== 'client' && l.status !== 'lost').length;
    const clients = state.leads.filter((l) => l.status === 'client').length;
    for (const [id, n] of [['pipeCount', open], ['clientCount', clients]]) {
      $('#' + id).textContent = n;
      $('#' + id).hidden = !n;
    }
  }
  function rerender() {
    updateCounts();
    if (state.view === 'pipeline') renderBoard();
    if (state.view === 'clients') renderClients();
    if ($('#leadDialog').open) renderLeadDialog();
  }
  const getTemplates = async () => (state.templates ||= await api('/api/templates'));

  // ---- views and routing ------------------------------------------------
  const VIEWS = { scan: '#scanView', pipeline: '#pipelineView', clients: '#clientsView' };
  function showView(name, opts = {}) {
    state.view = name;
    for (const [k, sel] of Object.entries(VIEWS)) $(sel).hidden = k !== name;
    document.querySelectorAll('#nav button').forEach((b) => (b.dataset.view === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    if (!opts.keepHash) {
      const h = name === 'pipeline' ? '#pipeline' : name === 'clients' ? (state.clientId ? '#client/' + state.clientId : '#clients') : '';
      history.replaceState(null, '', location.pathname + h);
    }
    if (name === 'pipeline') renderPipeline();
    if (name === 'clients') renderClients();
  }

  function route() {
    const h = location.hash.slice(1);
    if (h === 'pipeline') showView('pipeline', { keepHash: true });
    else if (h === 'clients') {
      state.clientId = null;
      showView('clients', { keepHash: true });
    } else if (h.startsWith('client/')) {
      state.clientId = h.slice(7);
      showView('clients', { keepHash: true });
    } else if (/^\d{4}-\d{2}-\d{2}-[a-f0-9]+$/.test(h)) GS.openScan(h).catch(() => {});
  }

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.clientId = null;
    showView(b.dataset.view);
  });
  $('#historyBtn').addEventListener('click', () => showView('scan', { keepHash: true }), true);
  window.addEventListener('hashchange', route);

  // ---- save button on scan results -----------------------------------------
  function leadForScan(scan) {
    return (
      state.leads.find((l) => l.scans.some((s) => s.id === scan.id)) ||
      state.leads.find((l) => (scan.business.cid && l.business.cid === scan.business.cid) || (scan.business.place_id && l.business.place_id === scan.business.place_id)) ||
      null
    );
  }
  function attachSaveButton(box, scan) {
    if (!box) return;
    const draw = () => {
      const lead = leadForScan(scan);
      const hasScan = lead && lead.scans.some((s) => s.id === scan.id);
      if (lead && hasScan) {
        box.innerHTML = `<span class="pill good">Saved · ${esc(stageLabel(lead.status))}</span> <button class="btn" type="button" data-open>Open card</button>`;
      } else if (lead) {
        box.innerHTML = `<button class="btn primary" type="button" data-save>Add scan to saved company</button>`;
      } else {
        box.innerHTML = `<button class="btn primary" type="button" data-save>Save to pipeline</button>`;
      }
    };
    draw();
    box.onclick = async (e) => {
      if (e.target.closest('[data-open]')) return openLead(leadForScan(scan).id);
      const btn = e.target.closest('[data-save]');
      if (!btn) return;
      btn.disabled = true;
      await guarded(async () => {
        const r = await api('/api/leads', { method: 'POST', body: JSON.stringify({ scanId: scan.id }) });
        replaceLead(r.lead);
        await refreshLeads();
        toast(r.existing ? 'Scan added to the saved company' : 'Saved to the pipeline as a new lead');
      });
      draw();
    };
  }

  // ---- pipeline board -----------------------------------------------------
  function renderPipeline() {
    $('#pipelineView').innerHTML = `
      <div class="page-head">
        <div><h2>Pipeline</h2><p class="muted small">Drag a company to the stage it is in. Click a card for contact details and notes.</p></div>
        <div class="page-actions">
          <button class="btn" id="backupBtn" type="button">Download backup</button>
          <label class="btn" for="restoreFile">Restore backup</label>
          <input id="restoreFile" type="file" accept="application/json,.json" hidden>
        </div>
      </div>
      ${storageNotice()}
      <div class="board" id="board"></div>`;
    renderBoard();
  }

  function storageNotice() {
    return state.config.persistent
      ? ''
      : '<div class="notice warn-note">Saved companies are on temporary storage, so they are erased when the app restarts or updates. Download a backup regularly until permanent storage is added.</div>';
  }

  function sortedStage(stage) {
    const list = state.leads.filter((l) => l.status === stage);
    if (stage === 'call') return list.sort((a, b) => (a.callAt || '9999').localeCompare(b.callAt || '9999'));
    return list.sort((a, b) => a.order - b.order);
  }

  function cardHtml(l) {
    const lt = l.latest;
    const sp = lt && SPEND[lt.spending];
    const callAt = l.callAt && new Date(l.callAt);
    const overdue = l.status === 'call' && callAt && callAt < new Date();
    return `<article class="card" draggable="true" data-id="${l.id}" tabindex="0" aria-label="${esc(l.business.title)}">
      <strong>${esc(l.business.title)}</strong>
      <div class="small muted">${esc(shortAddr(l.business.address))}</div>
      ${lt ? `<div class="card-body">${miniGrid(lt.cells)}
        <div class="card-stats">
          <div><span class="label">Avg rank</span><b class="num">${lt.avgRank ?? '—'}</b></div>
          <div><span class="label">Top 3</span><b class="num">${lt.top3Pct ?? '—'}%</b></div>
        </div></div>
        <div class="chips">${sp ? `<span class="pill ${sp[0]}">${sp[1]}</span>` : ''}${lt.waste != null ? `<span class="pill ${WASTE_TONE[lt.wasteLevel] || 'none'}">Waste ${lt.waste}</span>` : ''}${lt.websiteScore != null ? `<span class="pill none">Site ${lt.websiteScore}</span>` : ''}</div>` : '<div class="small muted">No scan yet</div>'}
      ${l.callAt ? `<div class="call-line${overdue ? ' overdue' : ''}"><span class="label">Call</span> ${esc(fmtCall(l.callAt))}${overdue ? ' · past' : ''}</div>` : ''}
      ${l.contact.name ? `<div class="small muted">${esc(l.contact.name)}</div>` : ''}
      <select class="move-select" aria-label="Move ${esc(l.business.title)} to another stage" data-move="${l.id}">
        ${state.config.stages.map((s) => `<option value="${s.id}"${s.id === l.status ? ' selected' : ''}>${s.id === l.status ? 'Stage: ' : 'Move to: '}${esc(s.label)}</option>`).join('')}
      </select>
    </article>`;
  }

  function renderBoard() {
    const board = $('#board');
    if (!board) return;
    if (!state.leads.length) {
      board.innerHTML = '<div class="panel empty board-empty"><h2>No companies saved yet</h2><p class="muted">Run a scan, then press <b>Save to pipeline</b> on the results. The company lands here as a new lead.</p><button class="btn primary" type="button" data-go="scan">Go to Scan</button></div>';
      return;
    }
    board.innerHTML = state.config.stages
      .map((s) => {
        const list = sortedStage(s.id);
        return `<section class="col" data-stage="${s.id}">
          <header><h3>${esc(s.label)}</h3><span class="count">${list.length}</span></header>
          <p class="small muted col-hint">${esc(HINTS[s.id] || '')}</p>
          <div class="col-body">${list.map(cardHtml).join('') || '<div class="drop-empty small muted">Drop a company here</div>'}</div>
        </section>`;
      })
      .join('');
  }

  // drag and drop (desktop); phones use the "Move to" menu on each card
  let dragId = null;
  const pv = $('#pipelineView');
  pv.addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    dragId = c.dataset.id;
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => c.classList.add('dragging'));
  });
  pv.addEventListener('dragend', () => {
    dragId = null;
    pv.querySelectorAll('.dragging, .over').forEach((el) => el.classList.remove('dragging', 'over'));
  });
  pv.addEventListener('dragover', (e) => {
    const col = e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    pv.querySelectorAll('.col.over').forEach((el) => el !== col && el.classList.remove('over'));
    col.classList.add('over');
  });
  pv.addEventListener('drop', (e) => {
    const col = e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    const cards = [...col.querySelectorAll('.card:not(.dragging)')];
    let index = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (index < 0) index = cards.length;
    const id = dragId;
    pv.querySelectorAll('.over').forEach((el) => el.classList.remove('over'));
    moveLead(id, col.dataset.stage, index);
  });

  pv.addEventListener('click', async (e) => {
    if (e.target.closest('[data-go]')) return showView(e.target.closest('[data-go]').dataset.go);
    if (e.target.closest('#backupBtn')) {
      window.location = '/api/backup';
      return;
    }
    if (e.target.closest('.move-select')) return;
    const card = e.target.closest('.card');
    if (card) openLead(card.dataset.id);
  });
  pv.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('card')) openLead(e.target.dataset.id);
  });
  pv.addEventListener('change', async (e) => {
    if (e.target.matches('.move-select')) {
      const id = e.target.dataset.move;
      e.target.blur();
      moveLead(id, e.target.value);
    }
    if (e.target.id === 'restoreFile') {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await guarded(async () => {
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          throw new Error('That file is not a Grid Scanner backup.');
        }
        const r = await api('/api/restore', { method: 'POST', body: JSON.stringify(data) });
        await refreshLeads();
        rerender();
        toast(`Restored ${r.added} new and ${r.updated} updated companies, ${r.scans} scans`);
      });
    }
  });

  async function moveLead(id, stage, index) {
    const lead = byId(id);
    if (!lead) return;
    if (lead.status === stage && index === undefined) return;
    let callAt;
    if (stage === 'call' && !lead.callAt) {
      const picked = await askCallTime(lead);
      if (picked === null) return rerender(); // cancelled: put the card and menus back
      callAt = picked || undefined;
    }
    // Show the move right away; the server response confirms it.
    lead.status = stage;
    if (callAt) lead.callAt = callAt;
    rerender();
    await guarded(async () => {
      const r = await api(`/api/leads/${id}/move`, { method: 'POST', body: JSON.stringify({ status: stage, index, callAt }) });
      replaceLead(r.lead);
      await refreshLeads();
      rerender();
      if (stage === 'client') toast(`${lead.business.title} is now a client. Open the Clients tab to set up their workspace.`);
    });
  }

  // "When is the call?" prompt. Resolves a datetime string, '' (skip) or null (cancel).
  function askCallTime(lead) {
    return new Promise((resolve) => {
      const dlg = $('#callDialog');
      dlg.innerHTML = `<form method="dialog" class="dlg-inner">
        <h3>When is the call with ${esc(lead.business.title)}?</h3>
        <div class="field"><label for="callWhen">Date and time</label><input id="callWhen" type="datetime-local" required></div>
        <div class="dlg-actions">
          <button class="btn primary" value="save">Save call time</button>
          <button class="btn" value="skip" formnovalidate>Skip for now</button>
          <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
        </div></form>`;
      dlg.onclose = () => {
        const v = dlg.returnValue;
        resolve(v === 'save' ? $('#callWhen').value : v === 'skip' ? '' : null);
      };
      dlg.returnValue = 'cancel';
      dlg.showModal();
    });
  }

  // ---- company dialog -------------------------------------------------------
  function openLead(id) {
    state.leadId = id;
    renderLeadDialog();
    const dlg = $('#leadDialog');
    if (!dlg.open) dlg.showModal();
  }

  function notesHtml(lead) {
    if (!lead.notes.length) return '<p class="small muted">Nothing yet. Notes you add and every stage change show up here.</p>';
    return `<ul class="notes">${lead.notes
      .slice(0, 60)
      .map(
        (n) => `<li class="${n.kind}"><div class="small muted">${esc(fmtWhen(n.at))}${n.kind === 'activity' ? ' · activity' : ''}</div>
        <div>${esc(n.text)}</div>${n.kind === 'note' ? `<button class="link-btn" type="button" data-act="del-note" data-note="${n.id}">Delete</button>` : ''}</li>`
      )
      .join('')}</ul>`;
  }

  function renderLeadDialog() {
    const lead = byId(state.leadId);
    const dlg = $('#leadDialog');
    if (!lead) return dlg.open && dlg.close();
    const keep = dlg.querySelector('.dlg-body');
    const top = keep ? keep.scrollTop : 0;
    const lt = lead.latest;
    const b = lead.business;
    dlg.innerHTML = `
      <div class="dlg-head">
        <div><h2>${esc(b.title)}</h2><div class="small muted">${esc(b.address || '')}${b.domain ? ` · <a href="${esc(b.url || 'https://' + b.domain)}" target="_blank" rel="noopener">${esc(b.domain)}</a>` : ''}</div></div>
        <button class="btn ghost" type="button" data-act="close" aria-label="Close">Close</button>
      </div>
      <div class="dlg-body">
        <div class="form-row">
          <div class="field"><label for="ld-stage">Stage</label>
            <select id="ld-stage">${state.config.stages.map((s) => `<option value="${s.id}"${s.id === lead.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="ld-call">Call date and time</label>
            <div class="inline"><input id="ld-call" type="datetime-local" value="${esc(lead.callAt)}">${lead.callAt ? '<button class="link-btn" type="button" data-act="clear-call">Clear</button>' : ''}</div></div>
        </div>

        <h3>Contact</h3>
        <div class="form-row three">
          <div class="field"><label for="ld-name">Name</label><input id="ld-name" class="ld-contact" type="text" value="${esc(lead.contact.name)}" placeholder="Owner or manager"></div>
          <div class="field"><label for="ld-email">Email</label><input id="ld-email" class="ld-contact" type="text" inputmode="email" value="${esc(lead.contact.email)}"></div>
          <div class="field"><label for="ld-phone">Phone</label><input id="ld-phone" class="ld-contact" type="text" inputmode="tel" value="${esc(lead.contact.phone || b.phone || '')}"></div>
        </div>

        <h3>Latest scan</h3>
        ${
          lt
            ? `<div class="scan-sum">${miniGrid(lt.cells, true)}
          <div class="sum-stats">
            <div><span class="label">Avg rank</span><b class="num">${lt.avgRank ?? '—'}</b></div>
            <div><span class="label">Top 3</span><b class="num">${lt.top3Pct ?? '—'}%</b></div>
            <div><span class="label">Ads</span><b>${esc((SPEND[lt.spending] || [0, '—'])[1])}</b></div>
            <div><span class="label">Waste</span><b class="num">${lt.waste ?? 'n/a'}</b></div>
            <div><span class="label">Website</span><b class="num">${lt.websiteScore ?? '—'}</b></div>
            <div class="small muted">${esc(lt.keyword)} · ${esc(fmtDay(lt.at))}${lt.demo ? ' · demo data' : ''}</div>
          </div></div>
          <div class="btn-row"><button class="btn" type="button" data-act="open-scan" data-scan="${lt.id}">Open full scan</button>
          <button class="btn" type="button" data-act="rescan">Rescan</button>
          ${lead.status === 'client' ? '<button class="btn primary" type="button" data-act="open-client">Open client workspace</button>' : ''}</div>
          ${lead.scans.length > 1 ? `<details class="history"><summary>${lead.scans.length} scans saved</summary><table><tr><th>Date</th><th class="num">Avg rank</th><th class="num">Top 3</th><th class="num">Waste</th><th class="num">Site</th><th></th></tr>
            ${lead.scans.slice().reverse().map((s) => `<tr><td>${esc(fmtDay(s.at))}</td><td class="num">${s.avgRank ?? '—'}</td><td class="num">${s.top3Pct ?? '—'}%</td><td class="num">${s.waste ?? '—'}</td><td class="num">${s.websiteScore ?? '—'}</td><td><button class="link-btn" type="button" data-act="open-scan" data-scan="${s.id}">Open</button></td></tr>`).join('')}</table></details>` : ''}`
            : '<p class="muted">No scan saved for this company.</p>'
        }

        <h3>Notes and activity</h3>
        <div class="field"><label for="ld-note" class="sr">New note</label>
          <textarea id="ld-note" rows="2" placeholder="What happened? Next step?"></textarea></div>
        <div class="btn-row"><button class="btn primary" type="button" data-act="add-note">Add note</button></div>
        ${notesHtml(lead)}

        <div class="danger-zone"><button class="link-btn danger" type="button" data-act="delete">Delete this company</button></div>
      </div>`;
    const body = dlg.querySelector('.dlg-body');
    if (body) body.scrollTop = top;
  }

  async function patchLead(id, patch) {
    return guarded(async () => {
      const r = await api(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      replaceLead(r.lead);
      rerender();
      return r.lead;
    });
  }

  const ld = $('#leadDialog');
  ld.addEventListener('click', async (e) => {
    if (e.target === ld) return ld.close();
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const lead = byId(state.leadId);
    if (!lead) return;
    switch (act.dataset.act) {
      case 'close':
        return ld.close();
      case 'clear-call':
        return void patchLead(lead.id, { callAt: '' });
      case 'add-note': {
        const ta = $('#ld-note');
        if (!ta.value.trim()) return ta.focus();
        return void guarded(async () => {
          const r = await api(`/api/leads/${lead.id}/notes`, { method: 'POST', body: JSON.stringify({ text: ta.value }) });
          replaceLead(r.lead);
          rerender();
        });
      }
      case 'del-note':
        return void guarded(async () => {
          const r = await api(`/api/leads/${lead.id}/notes/${act.dataset.note}`, { method: 'DELETE' });
          replaceLead(r.lead);
          rerender();
        });
      case 'open-scan':
        ld.close();
        GS.showView('scan', { keepHash: true });
        return void GS.openScan(act.dataset.scan);
      case 'rescan':
        return void startRescan(lead.id);
      case 'open-client':
        ld.close();
        return openClient(lead.id);
      case 'delete':
        if (!act.dataset.armed) {
          act.dataset.armed = '1';
          act.textContent = 'Click again to delete for good';
          return;
        }
        return void guarded(async () => {
          await api(`/api/leads/${lead.id}`, { method: 'DELETE' });
          state.leads = state.leads.filter((l) => l.id !== lead.id);
          ld.close();
          if (state.clientId === lead.id) state.clientId = null;
          rerender();
          toast('Company deleted');
        });
    }
  });
  ld.addEventListener('change', (e) => {
    const lead = byId(state.leadId);
    if (!lead) return;
    if (e.target.id === 'ld-stage') moveLead(lead.id, e.target.value);
    else if (e.target.id === 'ld-call') patchLead(lead.id, { callAt: e.target.value });
    else if (e.target.classList.contains('ld-contact')) {
      patchLead(lead.id, { contact: { name: $('#ld-name').value, email: $('#ld-email').value, phone: $('#ld-phone').value } });
    }
  });

  async function startRescan(id) {
    await guarded(async () => {
      const r = await api(`/api/leads/${id}/rescan`, { method: 'POST' });
      $('#leadDialog').open && $('#leadDialog').close();
      GS.watchScan(r.id);
      toast('Rescan started. The result is added to this company automatically.');
    });
  }

  // ---- clients ----------------------------------------------------------------
  function openClient(id) {
    state.clientId = id;
    showView('clients');
  }

  function checklistTotals(c) {
    let done = 0;
    let total = 0;
    for (const k of ['onboarding', 'web', 'ads', 'seo']) {
      if (k !== 'onboarding' && !c.services[k]) continue;
      for (const it of c.checklists[k] || []) {
        total++;
        if (it.done) done++;
      }
    }
    return { done, total };
  }

  function renderClients() {
    const root = $('#clientsView');
    const clients = state.leads.filter((l) => l.status === 'client' && l.client);
    const lead = state.clientId && byId(state.clientId);
    if (lead && lead.client) return renderWorkspace(root, lead);
    state.clientId = null;
    const mrr = clients.reduce((a, l) => a + (l.client.monthlyFee || 0), 0);
    root.innerHTML = `
      <div class="page-head"><div><h2>Clients</h2><p class="muted small">Companies you have won. Each one gets a workspace with checklists and before and after results.</p></div>
        ${mrr ? `<div class="mrr"><span class="label">Monthly revenue</span><b class="num">${money(mrr)}</b></div>` : ''}</div>
      ${storageNotice()}
      ${
        clients.length
          ? `<div class="client-grid">${clients
              .map((l) => {
                const t = checklistTotals(l.client);
                const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
                const svc = Object.keys(SERVICE_LABELS).filter((k) => l.client.services[k]);
                return `<button class="client-card" type="button" data-open-client="${l.id}">
                  <strong>${esc(l.business.title)}</strong>
                  <span class="small muted">Client since ${esc(fmtDay(l.client.startedAt))}${l.client.monthlyFee ? ` · ${money(l.client.monthlyFee)}/mo` : ''}</span>
                  <span class="chips">${svc.length ? svc.map((k) => `<span class="pill none">${SERVICE_LABELS[k]}</span>`).join('') : '<span class="small muted">No services chosen yet</span>'}</span>
                  <span class="bar"><i style="width:${pct}%"></i></span>
                  <span class="small muted">${t.done} of ${t.total} tasks done</span>
                </button>`;
              })
              .join('')}</div>`
          : '<div class="panel empty"><h2>No clients yet</h2><p class="muted">When a company says yes, drag its card to <b>Client</b> on the Pipeline. It appears here with a starter checklist and its baseline scan.</p><button class="btn primary" type="button" data-go="pipeline">Go to Pipeline</button></div>'
      }`;
  }

  function deltaCell(before, after, lowerIsBetter, suffix = '') {
    if (before == null || after == null) return '<td class="num">—</td>';
    const d = Math.round((after - before) * 10) / 10;
    if (d === 0) return '<td class="num muted">no change</td>';
    const good = lowerIsBetter ? d < 0 : d > 0;
    return `<td class="num ${good ? 'delta-good' : 'delta-bad'}">${d > 0 ? '+' : '−'}${Math.abs(d)}${suffix}</td>`;
  }

  function compareHtml(lead) {
    const b = lead.client.baseline;
    const l = lead.latest;
    if (!l) return '<p class="muted">No scan saved yet. Rescan to record where they stand.</p>';
    const same = !b || b.id === l.id;
    const row = (label, f, lower, suffix = '') =>
      `<tr><td>${label}</td><td class="num">${b && b[f] != null ? b[f] + suffix : '—'}</td><td class="num">${l[f] != null ? l[f] + suffix : '—'}</td>${same ? '<td class="num muted">—</td>' : deltaCell(b && b[f], l[f], lower, suffix)}</tr>`;
    return `<div class="compare">
      <div class="compare-grids">
        <figure>${miniGrid(b ? b.cells : l.cells, true)}<figcaption class="small muted">${b ? `Baseline · ${esc(fmtDay(b.at))}` : 'No baseline'}</figcaption></figure>
        <figure>${miniGrid(l.cells, true)}<figcaption class="small muted">Latest · ${esc(fmtDay(l.at))}</figcaption></figure>
      </div>
      <div class="table-scroll"><table><tr><th></th><th class="num">Baseline</th><th class="num">Latest</th><th class="num">Change</th></tr>
        ${row('Average Maps rank (lower is better)', 'avgRank', true)}
        ${row('Top 3 coverage', 'top3Pct', false, '%')}
        ${row('Found in top 20', 'foundPct', false, '%')}
        ${row('Website score', 'websiteScore', false)}
        ${row('Likely waste score (lower is better)', 'waste', true)}
      </table></div>
      ${same ? '<p class="small muted">The latest scan is the baseline. Press Rescan after the work is live to show progress.</p>' : ''}
    </div>`;
  }

  function checklistHtml(c, key) {
    const items = c.checklists[key] || [];
    const done = items.filter((i) => i.done).length;
    const labels = { onboarding: 'Onboarding', ...SERVICE_LABELS };
    return `<section class="panel checklist" data-list="${key}">
      <div class="section-head"><h3>${labels[key]}</h3><span class="small muted" data-progress>${done} of ${items.length} done</span></div>
      <div class="bar"><i style="width:${items.length ? Math.round((done / items.length) * 100) : 0}%"></i></div>
      <ul class="ck-list">${items
        .map(
          (it) => `<li><input class="ck-box" type="checkbox" data-item="${it.id}" ${it.done ? 'checked' : ''} aria-label="Done">
            <input class="ck-text${it.done ? ' done' : ''}" type="text" data-item="${it.id}" value="${esc(it.text)}" aria-label="Task">
            <button class="link-btn" type="button" data-act="ck-del" data-item="${it.id}" aria-label="Remove task">Remove</button></li>`
        )
        .join('')}</ul>
      <div class="ck-add"><input class="ck-add-input" type="text" placeholder="Add a task" aria-label="New task"><button class="btn" type="button" data-act="ck-add">Add</button></div>
    </section>`;
  }

  function renderWorkspace(root, lead) {
    const c = lead.client;
    const keys = ['onboarding', ...Object.keys(SERVICE_LABELS).filter((k) => c.services[k])];
    root.innerHTML = `
      <div class="page-head">
        <div><button class="link-btn" type="button" data-act="back">All clients</button>
          <h2>${esc(lead.business.title)}</h2>
          <p class="small muted">${esc(lead.business.address || '')}${lead.contact.name ? ` · ${esc(lead.contact.name)}` : ''}${lead.contact.email ? ` · ${esc(lead.contact.email)}` : ''}</p></div>
        <div class="page-actions"><button class="btn" type="button" data-act="open-card" data-id="${lead.id}">Contact and notes</button>
          <button class="btn primary" type="button" data-act="rescan" data-id="${lead.id}">Rescan now</button></div>
      </div>
      <div class="client-layout">
        <div class="stack">
          <section class="panel"><div class="section-head"><h3>Results so far</h3></div>${compareHtml(lead)}</section>
          ${keys.map((k) => checklistHtml(c, k)).join('')}
        </div>
        <aside class="stack">
          <section class="panel">
            <h3>Deal</h3>
            <div class="field"><label for="cl-start">Client since</label><input id="cl-start" type="date" value="${esc(c.startedAt)}"></div>
            <div class="field"><label for="cl-fee">Monthly fee ($)</label><input id="cl-fee" type="number" min="0" step="50" value="${c.monthlyFee ?? ''}" placeholder="Optional"></div>
          </section>
          <section class="panel">
            <h3>What we are doing for them</h3>
            ${Object.entries(SERVICE_LABELS)
              .map(([k, label]) => `<label class="check"><input class="svc-toggle" type="checkbox" data-svc="${k}" ${c.services[k] ? 'checked' : ''}><span>${label}</span></label>`)
              .join('')}
            <p class="small muted">Turning a service on adds its starter checklist. Edit the tasks freely.</p>
          </section>
          <section class="panel"><h3>Recent activity</h3>${notesHtml({ notes: lead.notes.slice(0, 6) })}</section>
        </aside>
      </div>`;
  }

  // Saves the whole client record. Requests are chained so quick clicks cannot land out of order.
  let saveChain = Promise.resolve();
  function queueSave(id) {
    saveChain = saveChain.then(async () => {
      const lead = byId(id);
      if (!lead || !lead.client) return;
      const { startedAt, monthlyFee, services, checklists } = lead.client;
      try {
        await api(`/api/leads/${id}/client`, { method: 'PUT', body: JSON.stringify({ startedAt, monthlyFee, services, checklists }) });
      } catch (e) {
        toast('Could not save: ' + e.message);
      }
    });
  }

  const cv = $('#clientsView');
  const currentClient = () => byId(state.clientId);
  function refreshProgress(section, items) {
    const done = items.filter((i) => i.done).length;
    section.querySelector('[data-progress]').textContent = `${done} of ${items.length} done`;
    section.querySelector('.bar > i').style.width = (items.length ? Math.round((done / items.length) * 100) : 0) + '%';
  }

  cv.addEventListener('click', async (e) => {
    if (e.target.closest('[data-go]')) return showView(e.target.closest('[data-go]').dataset.go);
    const card = e.target.closest('[data-open-client]');
    if (card) return openClient(card.dataset.openClient);
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const lead = currentClient();
    switch (act.dataset.act) {
      case 'back':
        state.clientId = null;
        return showView('clients');
      case 'open-card':
        return openLead(act.dataset.id);
      case 'rescan':
        return void startRescan(act.dataset.id);
      case 'ck-del': {
        const sec = act.closest('[data-list]');
        const list = lead.client.checklists[sec.dataset.list];
        lead.client.checklists[sec.dataset.list] = list.filter((i) => i.id !== act.dataset.item);
        queueSave(lead.id);
        return renderClients();
      }
      case 'ck-add': {
        const sec = act.closest('[data-list]');
        const input = sec.querySelector('.ck-add-input');
        if (!input.value.trim()) return input.focus();
        lead.client.checklists[sec.dataset.list].push({ id: uid(), text: input.value.trim(), done: false });
        queueSave(lead.id);
        renderClients();
        return void cv.querySelector(`[data-list="${sec.dataset.list}"] .ck-add-input`).focus();
      }
    }
  });
  cv.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('ck-add-input')) e.target.closest('.ck-add').querySelector('[data-act="ck-add"]').click();
    if (e.key === 'Enter' && e.target.classList.contains('ck-text')) e.target.blur();
  });
  cv.addEventListener('change', async (e) => {
    const lead = currentClient();
    if (!lead) return;
    const t = e.target;
    const sec = t.closest('[data-list]');
    if (t.classList.contains('ck-box')) {
      const items = lead.client.checklists[sec.dataset.list];
      const it = items.find((i) => i.id === t.dataset.item);
      it.done = t.checked;
      sec.querySelector(`.ck-text[data-item="${it.id}"]`).classList.toggle('done', it.done);
      refreshProgress(sec, items);
      queueSave(lead.id);
    } else if (t.classList.contains('ck-text')) {
      const items = lead.client.checklists[sec.dataset.list];
      const it = items.find((i) => i.id === t.dataset.item);
      if (!t.value.trim()) lead.client.checklists[sec.dataset.list] = items.filter((i) => i !== it);
      else it.text = t.value.trim();
      queueSave(lead.id);
      if (!t.value.trim()) renderClients();
    } else if (t.classList.contains('svc-toggle')) {
      const key = t.dataset.svc;
      lead.client.services[key] = t.checked;
      if (t.checked && !(lead.client.checklists[key] || []).length) {
        const tpl = await getTemplates();
        lead.client.checklists[key] = (tpl[key] || []).map((text) => ({ id: uid(), text, done: false }));
      }
      queueSave(lead.id);
      renderClients();
    } else if (t.id === 'cl-fee') {
      lead.client.monthlyFee = t.value === '' ? null : Number(t.value);
      queueSave(lead.id);
    } else if (t.id === 'cl-start') {
      if (t.value) lead.client.startedAt = t.value;
      queueSave(lead.id);
    }
  });

  // ---- start ------------------------------------------------------------------
  Object.assign(GS, { showView, refreshLeads, attachSaveButton, openLead, state });
  Promise.all([api('/api/config'), refreshLeads()])
    .then(([cfg]) => {
      state.config = cfg;
      route();
    })
    .catch(() => route());
})();
