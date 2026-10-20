(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString());

  let config = { defaultKeywords: [], prices: { mapsLive: 0.002, mapsQueued: 0.0006, organicLive: 0.002, labsOverview: 0.0101, labsRanked: 0.0111, adsSearch: 0.002 } };
  let candidates = [];
  let current = null;
  let map = null;
  let gridLayer = null;
  let activeKw = 0;

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) location.href = '/login';
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  function showErr(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // ---- setup ----
  $('#ghostGrid').innerHTML = '<i></i>'.repeat(99);
  api('/api/config').then((c) => {
    config = c;
    $('#demoBanner').hidden = !c.demo;
    $('#keywords').value = c.defaultKeywords.join('\n');
    updateCost();
  });

  function keywords() {
    return [...new Set($('#keywords').value.split('\n').map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
  }

  function updateCost() {
    const n = keywords().length;
    const pr = config.prices;
    let est = n * 99 * ($('#mode').value === 'fast' ? pr.mapsLive : pr.mapsQueued);
    if ($('#optAds').checked) est += n * 9 * pr.organicLive;
    if ($('#optSpend').checked) est += pr.labsOverview + pr.labsRanked + pr.adsSearch;
    $('#costEst').textContent = '≈ $' + est.toFixed(2);
    $('#scanBtn').textContent = `Run 9 × 11 scan (${n} keyword${n === 1 ? '' : 's'})`;
    $('#scanBtn').disabled = n === 0;
  }
  ['#keywords', '#optAds', '#optSpend', '#mode'].forEach((s) => $(s).addEventListener('input', updateCost));

  // ---- step 1: locate ----
  $('#locateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#locateBtn');
    showErr($('#locateErr'));
    btn.disabled = true;
    btn.textContent = 'Searching Google Maps…';
    try {
      const r = await api('/api/locate', { method: 'POST', body: JSON.stringify({ name: $('#name').value, address: $('#address').value }) });
      candidates = r.candidates;
      renderCandidates();
    } catch (err) {
      showErr($('#locateErr'), err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Find on Google Maps';
    }
  });

  function renderCandidates() {
    const box = $('#candidates');
    box.hidden = false;
    box.innerHTML =
      '<div class="label">Pick the right listing</div>' +
      candidates
        .map(
          (c, i) => `<label class="cand"><input type="radio" name="cand" value="${i}" ${i === 0 ? 'checked' : ''}>
          <span><strong>${esc(c.title)}</strong><span class="small muted">${esc(c.address || '')}</span><br>
          <span class="small muted">${esc(c.category || '')}${c.rating && c.rating.value ? ` · ${c.rating.value}★ (${c.rating.votes_count ?? 0})` : ''}${c.domain ? ` · ${esc(c.domain)}` : ' · no website listed'}</span></span></label>`
        )
        .join('');
    $('#step2').hidden = false;
  }

  // ---- step 2: scan ----
  $('#scanBtn').addEventListener('click', async () => {
    const sel = document.querySelector('input[name="cand"]:checked');
    if (!sel) return showErr($('#scanErr'), 'Pick a listing first.');
    showErr($('#scanErr'));
    const business = candidates[Number(sel.value)];
    $('#scanBtn').disabled = true;
    try {
      const { id } = await api('/api/scan', {
        method: 'POST',
        body: JSON.stringify({
          business,
          keywords: keywords(),
          spacing: Number($('#spacing').value),
          website: $('#website').value.trim(),
          searchAds: $('#optAds').checked,
          spend: $('#optSpend').checked,
          mode: $('#mode').value,
        }),
      });
      poll(id);
    } catch (err) {
      showErr($('#scanErr'), err.message);
      $('#scanBtn').disabled = false;
    }
  });

  async function poll(id) {
    const panel = $('#progressPanel');
    panel.hidden = false;
    const tick = async () => {
      let r;
      try {
        r = await api('/api/scan/' + id);
      } catch (err) {
        $('#progressText').textContent = err.message;
        return setTimeout(tick, 4000);
      }
      if (r.status === 'done') {
        panel.hidden = true;
        $('#scanBtn').disabled = false;
        history.replaceState(null, '', '#' + id);
        if (window.GS.refreshLeads) await window.GS.refreshLeads();
        return render(r.result);
      }
      if (r.status === 'error') {
        panel.hidden = true;
        $('#scanBtn').disabled = false;
        return showErr($('#scanErr'), 'Scan failed: ' + r.error);
      }
      const p = r.progress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      $('#progressBar').style.width = pct + '%';
      $('#progressText').textContent = `${p.message || 'Working'} · ${p.done || 0} of ${p.total || '?'} searches`;
      setTimeout(tick, 1500);
    };
    tick();
  }

  // ---- results ----
  function rankClass(rank) {
    if (rank == null) return 'r4';
    if (rank <= 3) return 'r1';
    if (rank <= 10) return 'r2';
    return 'r3';
  }
  function tone(level) {
    return { yes: 'warn', likely: 'warn', no: 'none', High: 'bad', Moderate: 'warn', Low: 'good' }[level] || 'none';
  }

  function render(s) {
    current = s;
    activeKw = 0;
    window.GS.showView('scan', { keepHash: true });
    $('#historyView').hidden = true;
    const root = $('#results');
    root.hidden = false;
    root.innerHTML = '';
    root.appendChild($('#resultTpl').content.cloneNode(true));
    const k = (name) => root.querySelector(`[data-k="${name}"]`);
    const b = s.business;

    k('scanMeta').textContent = `${s.demo ? 'DEMO DATA · ' : ''}Scan ${new Date(s.createdAt).toLocaleString()} · ${s.grid.spacing} mi spacing`;
    k('title').textContent = b.title;
    k('meta').innerHTML = [
      b.address && esc(b.address),
      b.category && esc(b.category),
      b.rating && b.rating.value != null && `${b.rating.value}★ · ${b.rating.votes_count ?? 0} reviews`,
      b.phone && esc(b.phone),
      b.domain && `<a href="${esc(b.url || 'https://' + b.domain)}" target="_blank" rel="noopener">${esc(b.domain)}</a>`,
      b.is_claimed === false && '<span class="flag">Profile not claimed</span>',
    ]
      .filter(Boolean)
      .map((x) => `<span>${x}</span>`)
      .join('');
    k('cost').textContent = `API cost $${(s.cost || 0).toFixed(3)} · ${s.calls} calls`;
    if (window.GS.attachSaveButton) window.GS.attachSaveButton(k('leadBox'), s);

    // tiles
    const avgArp = s.keywords.reduce((a, x) => a + (x.stats.avgRank ?? 21), 0) / s.keywords.length;
    const avgTop3 = Math.round(s.keywords.reduce((a, x) => a + x.stats.top3Pct, 0) / s.keywords.length);
    const site = s.website || {};
    const w = s.waste || {};
    k('tiles').innerHTML = [
      tile('Avg Maps rank', avgArp.toFixed(1), `Top 3 at ${avgTop3}% of points`, avgArp <= 5 ? 'good' : avgArp <= 12 ? 'warn' : 'bad'),
      tile('Spending on ads', { yes: 'Yes', likely: 'Likely', no: 'No' }[s.spending.level], s.spending.estMonthlySpend ? `≈ ${money(s.spending.estMonthlySpend)}/mo est.` : s.spending.verdict, s.spending.level === 'no' ? 'none' : 'warn'),
      tile('Likely waste', w.score == null ? 'n/a' : `${w.score}/100`, w.score == null ? 'No spend detected' : `${w.level} · ${w.reasons.length} issue(s)`, tone(w.level)),
      tile('Website', site.score != null ? `${site.score}/100` : '—', site.verdict || site.error || 'Not checked', site.score == null ? 'none' : site.score >= 80 ? 'good' : site.score >= 60 ? 'warn' : 'bad'),
    ].join('');

    // keyword tabs
    k('tabs').innerHTML = s.keywords
      .map((x, i) => `<button class="tab" role="tab" type="button" aria-selected="${i === 0}" data-i="${i}">${esc(x.keyword)}</button>`)
      .join('');
    k('tabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      activeKw = Number(t.dataset.i);
      k('tabs').querySelectorAll('.tab').forEach((el) => el.setAttribute('aria-selected', el === t));
      drawKeyword(k);
    });

    initMap();
    drawKeyword(k);
    renderSpend(k, s);
    renderWaste(k, s);
    renderSite(k, s);

    if (s.errorCount) {
      k('errors').innerHTML = `<div class="notice">${s.errorCount} search(es) failed and were left out. First: ${esc(s.errors[0])}</div>`;
    }
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function tile(label, big, sub, t) {
    return `<div class="tile" data-tone="${t}"><span class="label">${esc(label)}</span><span class="big">${esc(big)}</span><span class="sub">${esc(sub)}</span></div>`;
  }

  function initMap() {
    if (map) {
      map.remove();
      map = null;
    }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    map = L.map('map', { scrollWheelZoom: false });
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    const pts = current.grid.points;
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.06));
    L.marker([current.business.lat, current.business.lng], {
      icon: L.divIcon({ className: '', html: '<div style="width:12px;height:12px;background:var(--ink);transform:rotate(45deg);border:2px solid var(--panel)"></div>', iconSize: [12, 12] }),
      zIndexOffset: -100,
    })
      .addTo(map)
      .bindTooltip('Business location');
  }

  function drawKeyword(k) {
    const kw = current.keywords[activeKw];
    const pts = current.grid.points;
    if (gridLayer) gridLayer.remove();
    gridLayer = L.layerGroup().addTo(map);
    kw.cells.forEach((c) => {
      const p = pts.find((x) => x.row === c.row && x.col === c.col);
      const cls = c.error ? 'err' : rankClass(c.rank);
      const label = c.error ? '!' : c.rank == null ? '20+' : c.rank;
      const html = `<div class="pin ${cls}${c.targetMapsAd ? ' ad' : ''}${p.isCenter ? ' center' : ''}">${label}</div>`;
      const top = (c.top || []).slice(0, 3).map((t) => `${t.rank}. ${esc(t.title)}${t.rating ? ` (${t.rating}★ ${t.reviews ?? ''})` : ''}`).join('<br>');
      const ads = (c.mapsAds || []).map((a) => esc(a.title)).join(', ');
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] }) })
        .addTo(gridLayer)
        .bindTooltip(
          `<strong>${c.error ? 'Search failed' : c.rank == null ? 'Not in top 20' : 'Rank #' + c.rank}</strong><br>${top}${ads ? `<br><em>Sponsored here: ${ads}</em>` : ''}`,
          { className: 'rank-tip', direction: 'top' }
        );
    });
    const st = kw.stats;
    k('kwStats').innerHTML = [
      ['Avg rank', st.avgRank ?? '—'],
      ['Found in top 20', `${st.foundPct}%`],
      ['Top 3', `${st.top3Pct}%`],
      ['Best', st.best ?? '—'],
      ['Sponsored Maps pins', st.mapsAdPoints],
    ]
      .map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="v">${esc(v)}</div></div>`)
      .join('');
    k('competitors').innerHTML =
      '<tr><th>Business</th><th class="num">Top 3</th><th class="num">Avg</th><th class="num">Ads</th></tr>' +
      (kw.competitors || [])
        .map(
          (c) =>
            `<tr><td>${esc(c.title)}${c.rating ? `<br><span class="small muted">${c.rating}★ · ${c.reviews ?? 0}</span>` : ''}</td><td class="num">${c.top3}</td><td class="num">${c.avgRank ?? '—'}</td><td class="num">${c.mapsAds || ''}</td></tr>`
        )
        .join('');
  }

  function renderSpend(k, s) {
    const sp = s.spending;
    const pillCls = { yes: 'warn', likely: 'warn', no: 'none' }[sp.level];
    k('spendPill').innerHTML = `<span class="pill ${pillCls}">${esc(sp.verdict)}</span>`;
    k('evidence').innerHTML = sp.evidence.length
      ? sp.evidence.map((e) => `<li class="${e.strong ? 'strong' : ''}">${esc(e.text)}</li>`).join('')
      : '<li>No sponsored Maps pins, Search ads, Local Services Ads or Ads Transparency records found.</li>';

    const labs = s.labs;
    const tr = s.transparency;
    let est = '';
    if (labs && labs.ok) {
      est += `<div class="stats-row"><div class="stat"><div class="label">Est. monthly ad spend</div><div class="v">${money(labs.estMonthlyCost)}</div></div>
        <div class="stat"><div class="label">Est. paid clicks / mo</div><div class="v">${Math.round(labs.paidEtv).toLocaleString()}</div></div>
        <div class="stat"><div class="label">Paid keywords</div><div class="v">${labs.paidKeywords}</div></div></div>
        <p class="small muted">Spend is DataForSEO's estimate from the keywords and positions their ads were seen on. Treat it as a ballpark, not their real budget.</p>`;
    } else if (labs && labs.error) est += `<p class="small muted">Spend estimate unavailable: ${esc(labs.error)}</p>`;
    if (tr && tr.ok && tr.totalAds) {
      est += `<p class="small">Google Ads Transparency: <strong>${tr.totalAds}</strong> ads on record${tr.verified ? ' (verified advertiser)' : ''}, last shown ${esc((tr.lastShown || '').slice(0, 10))}. Formats: ${esc(Object.entries(tr.formats).map(([f, n]) => `${f} ${n}`).join(', '))}.</p>`;
    } else if (tr && tr.error) est += `<p class="small muted">Ads Transparency lookup unavailable: ${esc(tr.error)}</p>`;
    k('spendEst').innerHTML = est;

    const sa = s.searchAds || { samples: [] };
    if (!sa.samples.length) {
      k('minigrids').innerHTML = '<p class="small muted">Search ad sampling was turned off for this scan.</p>';
    } else {
      k('minigrids').innerHTML = s.keywords
        .map((kw) => {
          const cells = sa.samples.filter((x) => x.keyword === kw.keyword);
          const rows = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
          const cols = [...new Set(cells.map((c) => c.col))].sort((a, b) => a - b);
          let g = '';
          for (const r of rows)
            for (const c of cols) {
              const x = cells.find((y) => y.row === r && y.col === c);
              if (!x) g += '<i title="Failed">!</i>';
              else if (x.targetLsa) g += '<i class="lsa" title="Local Services Ad">L</i>';
              else if (x.targetAd) g += `<i class="yes" title="Ad position ${x.targetAd.pos}">${x.targetAd.pos}</i>`;
              else g += '<i title="No ad"></i>';
            }
          return `<div class="minigrid"><span class="small">${esc(kw.keyword)}</span><div class="g">${g}</div></div>`;
        })
        .join('');
    }
    const adv = sa.advertisers || [];
    k('advertisers').innerHTML = adv.length
      ? '<tr><th>Advertiser</th><th>Type</th><th class="num">Times seen</th></tr>' +
        adv
          .map((a) => `<tr${a.isTarget ? ' style="font-weight:700"' : ''}><td>${esc(a.title || a.domain)}${a.domain ? `<br><span class="small muted">${esc(a.domain)}</span>` : ''}</td><td>${a.lsa ? 'Local Services' : 'Search ad'}</td><td class="num">${a.count}</td></tr>`)
          .join('')
      : '<tr><td class="muted">No advertisers captured.</td></tr>';
  }

  function renderWaste(k, s) {
    const w = s.waste;
    if (w.score == null) {
      k('wastePill').innerHTML = '<span class="pill none">Not spending</span>';
      k('wasteGauge').innerHTML = `<p>${esc(w.summary)}</p>`;
      return;
    }
    const color = { High: 'var(--bad)', Moderate: 'var(--warn)', Low: 'var(--good)' }[w.level];
    k('wastePill').innerHTML = `<span class="pill ${tone(w.level)}">${esc(w.level)} likely waste</span>`;
    k('wasteGauge').innerHTML = `<div class="gauge"><div class="ring" style="--p:${w.score};--c:${color}"><span>${w.score}</span></div>
      <p class="small muted">Points add up from problems that make ad clicks less likely to turn into calls. It is a sales signal, not an audit of their Google Ads account.</p></div>`;
    k('reasons').innerHTML = w.reasons.length
      ? w.reasons.map((r) => `<li><span class="pts">+${r.points}</span><span><strong>${esc(r.title)}</strong><span class="small muted">${esc(r.detail)}</span></span></li>`).join('')
      : '<li><span class="pts">0</span><span>No obvious waste signals found.</span></li>';

    const labs = s.labs;
    if (labs && labs.ok && labs.keywords && labs.keywords.length) {
      const bad = /\b(jobs?|careers?|hiring|salary|salaries|school|training|course|class(es)?|certification|license test|diy|how to|youtube|reddit|manual|wholesale|supply|supplies|parts store|definition|what is|meaning|free)\b/i;
      k('paidKw').innerHTML = `<h3 style="margin-top:18px">Keywords they pay for</h3><div class="table-scroll"><table>
        <tr><th>Keyword</th><th class="num">CPC</th><th class="num">Searches/mo</th><th>Lands on</th></tr>
        ${labs.keywords
          .slice(0, 25)
          .map((x) => {
            let p = '';
            try {
              p = new URL(x.url).pathname || '/';
            } catch {}
            return `<tr><td>${bad.test(x.keyword) ? '<span class="flag">⚑ </span>' : ''}${esc(x.keyword)}</td><td class="num">${x.cpc != null ? '$' + x.cpc.toFixed(2) : '—'}</td><td class="num">${x.volume ?? '—'}</td><td class="mono small">${esc(p)}</td></tr>`;
          })
          .join('')}</table></div><p class="small muted">⚑ = looks like a non-buyer search (jobs, DIY, training).</p>`;
    }
  }

  function renderSite(k, s) {
    const site = s.website || {};
    if (!site.checks) {
      k('sitePill').innerHTML = '<span class="pill none">Not checked</span>';
      k('site').innerHTML = `<p>${esc(site.error || 'No website found on the Google profile. Add one with the website override and rescan.')}</p>`;
      return;
    }
    const t = site.score >= 80 ? 'good' : site.score >= 60 ? 'warn' : 'bad';
    k('sitePill').innerHTML = `<span class="pill ${t}">${esc(site.verdict)} · ${site.score}/100</span>`;
    const psi = site.pagespeed;
    const p = site.page;
    const failing = site.checks.filter((c) => !c.pass);
    const passing = site.checks.filter((c) => c.pass);
    const mark = (c) => (c.pass ? '✓' : '✕');
    const row = (c) => `<li class="${c.severity}"><span class="mark">${mark(c)}</span><span><strong>${esc(c.label)}</strong><br><span class="small muted">${esc(c.detail)}</span></span></li>`;
    const track = p.tracking;
    k('site').innerHTML = `
      <p class="small"><a href="${esc(site.finalUrl || site.url)}" target="_blank" rel="noopener">${esc(site.finalUrl || site.url)}</a>${p.builder ? ` · Built with ${esc(p.builder)}` : ''}</p>
      ${psi ? `<div class="psi">
        <div><div class="label">Mobile speed</div><div class="v">${psi.performance ?? '—'}</div></div>
        <div><div class="label">Largest paint</div><div class="v">${psi.lcpMs ? (psi.lcpMs / 1000).toFixed(1) + 's' : '—'}</div></div>
        <div><div class="label">Layout shift</div><div class="v">${psi.cls != null ? psi.cls.toFixed(2) : '—'}</div></div>
        <div><div class="label">SEO</div><div class="v">${psi.seo ?? '—'}</div></div></div>` : `<p class="small muted">PageSpeed not available${site.pagespeedError ? ': ' + esc(site.pagespeedError) : ''}.</p>`}
      <div class="two-col">
        <div><h3>Needs fixing (${failing.length})</h3><ul class="checks" style="margin-top:8px">${failing.map(row).join('') || '<li class="ok"><span class="mark">✓</span><span>Nothing major.</span></li>'}</ul></div>
        <div><h3>Working (${passing.length})</h3><ul class="checks" style="margin-top:8px">${passing.map(row).join('')}</ul>
          <h3 style="margin-top:16px">Tracking found</h3>
          <p class="small">${[
            ['Google Ads conversion tag', track.googleAdsTag],
            ['Google Tag Manager', track.gtm],
            ['Google Analytics 4', track.ga4],
            ['Call tracking', track.callTracking],
            ['Meta pixel', track.metaPixel],
          ]
            .map(([l, v]) => `<span class="pill ${v ? 'good' : 'none'}">${v ? '✓' : '✕'} ${l}</span>`)
            .join(' ')}</p></div>
      </div>`;
  }

  // ---- history ----
  $('#historyBtn').addEventListener('click', async () => {
    $('#results').hidden = true;
    $('#historyView').hidden = false;
    const list = $('#historyList');
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { scans } = await api('/api/scans');
      list.innerHTML = scans.length
        ? scans
            .map(
              (s) => `<div class="history-item" data-id="${esc(s.id)}"><div><strong>${esc(s.business.title)}</strong>${s.demo ? ' <span class="pill warn">demo</span>' : ''}<br>
            <span class="small muted">${new Date(s.createdAt).toLocaleString()} · ${esc(s.keywords.join(', '))} · ${s.spacing} mi</span></div>
            <div class="small num" style="text-align:right">Avg rank ${s.avgRank ?? '—'}<br>Waste ${s.waste ?? 'n/a'} · Site ${s.websiteScore ?? '—'}</div></div>`
            )
            .join('')
        : '<p class="muted">No scans yet.</p>';
    } catch (err) {
      list.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
  $('#historyList').addEventListener('click', async (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    const r = await api('/api/scan/' + item.dataset.id);
    if (r.result) {
      history.replaceState(null, '', '#' + item.dataset.id);
      render(r.result);
    }
  });
  $('#historyClose').addEventListener('click', () => {
    $('#historyView').hidden = true;
    $('#results').hidden = false;
  });

  // Shared with crm.js (pipeline and clients).
  window.GS = Object.assign(window.GS || {}, {
    $, esc, money, api, showErr,
    watchScan: (id) => {
      window.GS.showView('scan');
      poll(id);
    },
    openScan: async (id) => {
      const r = await api('/api/scan/' + id);
      if (r.result) {
        history.replaceState(null, '', '#' + id);
        render(r.result);
      }
    },
  });
})();
