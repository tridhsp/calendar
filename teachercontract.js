/* teachercontract.js — contract dates and a running countdown on the Teacher Calendars cards  (7 Oct 2026)

   Loaded by teachercalendar.html AFTER teacher.js and teachercalendar-v2.js. It edits
   neither of them. It watches #tBoardContent and, whenever the By-teacher cards are
   (re)drawn, appends ONE strip to the bottom of every .tcv2-card:

       [icon] CONTRACT · ending soon           85  days left
              1 Jan 2026 -> 31 Dec 2026 · 365 d      04:12:33     [Renewable · +12 mo]
              ============================--------

   The clock ticks every second (one timer for the whole page). Colours follow the
   days left: blue, amber at 60, red at 14, dark red once the end date has passed.
   A card with no dates shows a dashed "Set contract dates" strip (Admins only).
   Clicking a strip opens the popup: start, end, quick lengths, can-it-be-extended,
   a note, and a live preview of the strip. Remove is in the popup too.

   FIXED HOURS (contract3, 7 Oct 2026) is NOT part of the contract. It is a per-teacher flag in
   its own table (teacher_flags) that this module also draws: a PIN button beside the pencil in
   the card's action row (admins only; one click toggles it, POST /api/cal-fixed-hours-set) and a
   dark "Fixed hours" badge in the card header beside the role badges. The list reply carries
   fixed: [emails]. A teacher with no contract dates can still be marked.

   DATA comes from three routes in cal-contracts.calendar.js, called with the
   Supabase token the page already holds (the global `client` from teacher.js):
       GET  /api/cal-contracts-list     POST /api/cal-contract-save     POST /api/cal-contract-delete
   The server decides who may edit (canEdit in the list reply). A Teacher receives
   only their own contract, so other cards simply carry no strip for them.

   DATES are plain YYYY-MM-DD and are read in the browser's own time zone. The end
   date is the LAST DAY of the contract: the countdown runs to midnight at the end
   of that day.

   Uses from the page: client (teacher.js), uiToast / uiConfirm (ui-dialog.js).
   Falls back to alert() / confirm() if those are missing. No library.           */
(function () {
  'use strict';
  if (window.__tcContract) return;                                   // loaded twice: keep the first copy
  window.__tcContract = true;

  const TC = {
    VERSION: '20261007_contract3',                                 // contract3: Fixed hours pin + header badge (7 Oct 2026)
    SOON_DAYS: 60,                      // amber from here down
    URGENT_DAYS: 14,                    // red from here down
    EXT: { yes: 'Renewable', no: 'Fixed term', discuss: 'To discuss' },
    EXT_ICON: { yes: 'fa-solid fa-rotate', no: 'fa-solid fa-lock', discuss: 'fa-regular fa-circle-question' },
    QUICK: [[3, '3 months'], [6, '6 months'], [12, '1 year'], [24, '2 years']],
    DAY: 24 * 60 * 60 * 1000
  };

  const st = {
    byEmail: new Map(),                 // email -> contract row
    fixed: new Set(),                   // emails whose free hours are FIXED (teacher_flags)     tansinh fixed-hours
    canEdit: false, role: null, me: null,
    loaded: false, loading: null,
    timer: null, obs: null,
    modal: null, editing: null          // { email, name, initials, acc, row }
  };

  /* ---------- tiny helpers ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function parseYmd(s) {                                              // local midnight, or null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) || d.getDate() !== Number(m[3]) ? null : d;
  }
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  function addMonths(d, n) {                                          // 31 Jan + 1 month -> 28/29 Feb, not 3 Mar
    const x = new Date(d); const day = x.getDate();
    x.setDate(1); x.setMonth(x.getMonth() + n);
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last)); return x;
  }
  const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtWeekday = (d) => d.toLocaleDateString('en-GB', { weekday: 'long' });
  const fmtStamp = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const toast = (msg, kind) => (window.uiToast ? window.uiToast(msg, kind) : alert(msg));
  const confirmBox = (msg, opts) => (window.uiConfirm ? window.uiConfirm(msg, opts) : Promise.resolve(window.nativeConfirm ? window.nativeConfirm(msg) : confirm(msg)));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /* ---------- the arithmetic: one place, used by the card, the ticker and the preview ---------- */
  function calc(startS, endS, now) {
    const s = parseYmd(startS), e = parseYmd(endS);
    if (!s || !e) return null;
    const eEnd = addDays(e, 1);                                       // midnight after the last day
    now = now || new Date();
    const totalDays = Math.max(1, Math.round((eEnd - s) / TC.DAY));
    const o = { s, e, eEnd, totalDays, pct: 0, state: 'ok', days: 0, clock: '' };
    let rem;
    if (now < s) { o.state = 'future'; rem = s - now; }
    else if (now >= eEnd) { o.state = 'over'; o.pct = 100; o.days = Math.floor((now - eEnd) / TC.DAY); return o; }
    else {
      rem = eEnd - now;
      o.pct = Math.max(0, Math.min(100, (now - s) / (eEnd - s) * 100));
    }
    o.days = Math.floor(rem / TC.DAY);
    const left = rem - o.days * TC.DAY;
    o.clock = `${pad(Math.floor(left / 3600000))}:${pad(Math.floor(left / 60000) % 60)}:${pad(Math.floor(left / 1000) % 60)}`;
    if (o.state !== 'future') o.state = o.days < TC.URGENT_DAYS ? 'urgent' : o.days < TC.SOON_DAYS ? 'soon' : 'ok';
    return o;
  }
  const STATE_WORD = { ok: '', soon: 'ending soon', urgent: `under ${TC.URGENT_DAYS} days`, over: 'expired', future: 'not started yet' };
  function countParts(o) {                                            // -> { big, unit, clock, word }  (word = big is a word, not a number)
    if (o.state === 'over') return { big: 'Ended', unit: o.days === 0 ? 'today' : `${plural(o.days, 'day')} ago`, clock: '', word: true };
    if (o.state === 'future') return { big: String(o.days), unit: o.days === 1 ? 'day to start' : 'days to start', clock: o.clock, word: false };
    if (o.days === 0) return { big: 'Last day', unit: 'ends in', clock: o.clock, word: true };
    return { big: String(o.days), unit: o.days === 1 ? 'day left' : 'days left', clock: o.clock, word: false };
  }

  /* ---------- the strip ---------- */
  function extTag(row) {
    const k = TC.EXT[row.extension] ? row.extension : 'discuss';
    const more = k === 'yes' && row.extension_months ? ` · +${row.extension_months} mo` : '';
    return `<span class="tc-ext tc-ext-${k}" title="${esc(row.note || '')}"><i class="${TC.EXT_ICON[k]}" aria-hidden="true"></i>${TC.EXT[k]}${esc(more)}</span>`;
  }
  function stripHtml(email, row, canEdit) {
    const edit = canEdit ? ' tc-edit" role="button" tabindex="0" title="Click to edit the contract dates' : '';
    if (!row) {
      if (!canEdit) return '';
      return `<div class="tc-strip tc-none${edit}" data-email="${esc(email)}">`
        + `<span class="tc-ico"><i class="fa-solid fa-file-signature" aria-hidden="true"></i></span>`
        + `<span class="tc-main"><span class="tc-lbl">Contract</span><span class="tc-range">No contract dates yet</span></span>`
        + `<span class="tc-set"><i class="fa-solid fa-plus" aria-hidden="true"></i> Set contract dates</span></div>`;
    }
    const o = calc(row.start_date, row.end_date);
    if (!o) return '';
    const p = countParts(o);
    const word = STATE_WORD[o.state];
    return `<div class="tc-strip tc-${o.state}${edit}" data-email="${esc(email)}" data-start="${esc(row.start_date)}" data-end="${esc(row.end_date)}">`
      + `<span class="tc-ico"><i class="fa-solid fa-file-signature" aria-hidden="true"></i></span>`
      + `<span class="tc-main">`
      + `<span class="tc-lbl">Contract${word ? ` <small>· ${word}</small>` : ''}</span>`
      + `<span class="tc-range"><b>${esc(fmtDate(o.s))}</b><i class="fa-solid fa-arrow-right-long" aria-hidden="true"></i><b>${esc(fmtDate(o.e))}</b><span class="tc-len">· ${o.totalDays} d</span></span>`
      + `<span class="tc-bar"><i style="width:${o.pct.toFixed(1)}%"></i></span>`
      + `</span>`
      + `<span class="tc-count"><b class="tc-days${p.word ? ' word' : ''}">${esc(p.big)}</b><span class="tc-dl">${esc(p.unit)}</span><span class="tc-clock">${p.clock}</span></span>`
      + extTag(row)
      + `</div>`;
  }

  /* every second: update the numbers in place, change the colour only when the day count moves */
  function tick() {
    const strips = document.querySelectorAll('.tc-strip[data-end]');
    if (!strips.length) return;
    const now = new Date();
    strips.forEach(el => {
      const o = calc(el.dataset.start, el.dataset.end, now); if (!o) return;
      const p = countParts(o);
      const big = el.querySelector('.tc-days'), unit = el.querySelector('.tc-dl'), clk = el.querySelector('.tc-clock'), bar = el.querySelector('.tc-bar i');
      if (big && big.textContent !== p.big) { big.textContent = p.big; big.classList.toggle('word', p.word); }
      if (unit && unit.textContent !== p.unit) unit.textContent = p.unit;
      if (clk && clk.textContent !== p.clock) clk.textContent = p.clock;
      if (bar) { const w = o.pct.toFixed(1) + '%'; if (bar.style.width !== w) bar.style.width = w; }
      const cls = 'tc-' + o.state;
      if (!el.classList.contains(cls)) {
        ['tc-ok', 'tc-soon', 'tc-urgent', 'tc-over', 'tc-future'].forEach(c => el.classList.remove(c));
        el.classList.add(cls);
        const lbl = el.querySelector('.tc-lbl'); const word = STATE_WORD[o.state];
        if (lbl) lbl.innerHTML = 'Contract' + (word ? ` <small>· ${word}</small>` : '');
      }
    });
  }
  function startTicker() { if (!st.timer) st.timer = setInterval(tick, 1000); }

  /* ---------- the data ---------- */
  async function token() {
    try {
      if (typeof client === 'undefined' || !client) return null;
      const { data } = await client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch (e) { return null; }
  }
  async function api(path, body) {
    const t = await token();
    if (!t) throw new Error('Please sign in first.');
    const res = await fetch('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Authorization': 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let j = null; try { j = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((j && j.error) || `${path} failed (${res.status})`);
    return j || {};
  }
  function load() {
    if (st.loading) return st.loading;
    st.loading = (async () => {
      try {
        const j = await api('cal-contracts-list');
        st.byEmail = new Map((j.contracts || []).map(r => [String(r.teacher_email).toLowerCase(), r]));
        st.fixed = new Set((j.fixed || []).map(e => String(e).toLowerCase()));                   // tansinh fixed-hours
        st.canEdit = !!j.canEdit; st.role = j.role || null; st.me = j.me || null;
        st.loaded = true;
      } catch (e) {
        console.warn('[tc-contract] could not load contracts:', e.message || e);
        st.loaded = false;
      } finally { st.loading = null; }
    })();
    return st.loading;
  }
  function reset() { st.byEmail = new Map(); st.fixed = new Set(); st.canEdit = false; st.role = null; st.me = null; st.loaded = false; }   // tansinh fixed-hours

  /* ---------- decorate the cards ---------- */
  function decorate() {
    const root = document.getElementById('tBoardContent'); if (!root) return;
    const cards = root.querySelectorAll('.tcv2-card');
    if (!cards.length) return;
    if (!st.loaded) { load().then(() => { if (st.loaded) decorate(); }); return; }
    cards.forEach(card => {
      const email = String(card.dataset.email || '').toLowerCase(); if (!email) return;
      pinCard(card, email);                                             // tansinh fixed-hours: the pin and the header badge
      const row = st.byEmail.get(email) || null;
      const key = keyOf(row);
      const old = card.querySelector(':scope > .tc-strip');
      if (old) {
        if (old.dataset.tcKey === key) return;                         // same data: leave it, the ticker owns the numbers
        old.remove();
      }
      const html = stripHtml(email, row, st.canEdit);
      if (!html) return;
      card.insertAdjacentHTML('beforeend', html);
      const el = card.querySelector(':scope > .tc-strip'); if (el) el.dataset.tcKey = key;
    });
    tick();
  }
  /* what the strip depends on, with no clock in it — so re-running decorate() over an untouched card changes nothing */
  function keyOf(row) { return JSON.stringify([st.canEdit, row ? [row.start_date, row.end_date, row.extension, row.extension_months, row.note] : null]); }
  function refreshCard(email) {
    const root = document.getElementById('tBoardContent'); if (!root) return;
    root.querySelectorAll('.tcv2-card').forEach(card => {
      if (String(card.dataset.email || '').toLowerCase() !== email) return;
      card.querySelector(':scope > .tc-strip')?.remove();
      const row = st.byEmail.get(email) || null;
      const html = stripHtml(email, row, st.canEdit);
      if (html) { card.insertAdjacentHTML('beforeend', html); const el = card.querySelector(':scope > .tc-strip'); if (el) el.dataset.tcKey = keyOf(row); }
    });
    tick();
  }

  /* === tansinh fixed-hours BEGIN (7 Oct 2026) === the pin beside the pencil, and the header badge */
  const FIXED_ON_TIP  = 'Fixed hours is ON: this teacher\'s free hours are fixed and will not change. Click to switch it off.';
  const FIXED_OFF_TIP = 'Fixed hours is off. Click to mark this teacher\'s free hours as fixed.';
  /* idempotent: called on every (re)draw, changes the DOM only when the state differs */
  function pinCard(card, email) {
    const on = st.fixed.has(email);
    const head = card.querySelector(':scope > .tcv2-chd');
    if (head) {
      let badge = head.querySelector(':scope > .tc-hbadge');
      if (on && !badge) {
        badge = document.createElement('span'); badge.className = 'tc-hbadge'; badge.title = FIXED_ON_TIP;
        badge.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>Fixed hours';
        const now = head.querySelector(':scope > .tcv2-onnow');                  // roles, then Fixed hours, then On now
        if (now) head.insertBefore(badge, now); else head.appendChild(badge);
      } else if (!on && badge) badge.remove();
    }
    const acts = card.querySelector(':scope > .tcv2-acts'); if (!acts) return;
    let pin = acts.querySelector(':scope > .tc-pin');
    if (!st.canEdit) { if (pin) pin.remove(); return; }                   // a Teacher sees the badge, not the button
    if (!pin) {
      pin = document.createElement('button'); pin.type = 'button'; pin.className = 'card-action tc-pin';
      pin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
      acts.insertBefore(pin, acts.firstChild);                                // before the pencil
    }
    pin.dataset.email = email;
    pin.setAttribute('aria-pressed', on ? 'true' : 'false');
    pin.title = on ? FIXED_ON_TIP : FIXED_OFF_TIP;
    pin.setAttribute('aria-label', on ? 'Fixed hours on. Switch off' : 'Fixed hours off. Switch on');
  }
  async function setFixed(email, on, pin) {
    if (pin) pin.disabled = true;
    try {
      const j = await api('cal-fixed-hours-set', { teacherEmail: email, fixedHours: !!on });
      const now = !!(j && j.fixedHours);
      if (now) st.fixed.add(email); else st.fixed.delete(email);
      document.querySelectorAll('#tBoardContent .tcv2-card').forEach(card => {
        if (String(card.dataset.email || '').toLowerCase() === email) pinCard(card, email);
      });
      toast(now ? 'Fixed hours on.' : 'Fixed hours off.', 'ok');
    } catch (err) { toast(err.message || 'Could not change Fixed hours.', 'error'); }
    finally { if (pin) pin.disabled = false; }
  }
  /* === tansinh fixed-hours END === */

  /* ---------- the popup ---------- */
  function buildModal() {
    if (st.modal) return st.modal;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop tc-backdrop'; wrap.id = 'tcModal'; wrap.hidden = true;
    wrap.innerHTML = `
      <div class="modal tc-modal" role="dialog" aria-modal="true" aria-labelledby="tcTitle">
        <div class="modal-header">
          <h2 id="tcTitle"><i class="fa-solid fa-file-signature" aria-hidden="true"></i> Contract
            <span class="tc-who"><span class="tc-av" id="tcAv">?</span><span id="tcName">…</span></span></h2>
          <button class="modal-close" id="tcClose" type="button" aria-label="Close">×</button>
        </div>
        <div class="modal-body tc-body">
          <section class="tc-sec">
            <h3 class="tc-h">Contract period</h3>
            <div class="tc-dates">
              <label class="tc-field" id="tcStartF"><span>Start date</span><input type="date" id="tcStart"></label>
              <span class="tc-arrow" aria-hidden="true"><i class="fa-solid fa-arrow-right-long"></i></span>
              <label class="tc-field" id="tcEndF"><span>End date <small style="font-weight:500;color:#94a3b8">(last day)</small></span><input type="date" id="tcEnd"></label>
            </div>
            <div class="tc-quick" id="tcQuick"><span>Length</span>${TC.QUICK.map(([m, l]) => `<button type="button" data-m="${m}">${l}</button>`).join('')}<span>from the start date</span></div>
            <p class="tc-sum" id="tcSum"></p>
          </section>
          <section class="tc-sec">
            <h3 class="tc-h">Can it be extended?</h3>
            <div class="tc-seg" id="tcExt" role="radiogroup" aria-label="Extension">
              ${['yes', 'no', 'discuss'].map(k => `<button type="button" role="radio" aria-checked="false" data-v="${k}"><i class="${TC.EXT_ICON[k]}" aria-hidden="true"></i>${TC.EXT[k]}</button>`).join('')}
            </div>
            <div class="tc-months hidden" id="tcMonthsRow"><span>Each extension adds</span><input type="number" id="tcMonths" min="1" max="120" step="1" placeholder="12" inputmode="numeric"><span>months <small>(optional)</small></span></div>
          </section>
          <section class="tc-sec">
            <h3 class="tc-h">Note <small>optional</small></h3>
            <input type="text" class="tc-note" id="tcNote" maxlength="300" placeholder="e.g. renews by signing an appendix · 30 days notice" autocomplete="off">
          </section>
          <section class="tc-sec tc-prevsec">
            <h3 class="tc-h">On the card</h3>
            <div id="tcPreview"></div>
          </section>
          <p class="tc-msg" id="tcMsg"></p>
        </div>
        <div class="modal-footer tc-foot">
          <button class="btn-secondary tc-danger hidden" id="tcRemove" type="button"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Remove</button>
          <span class="tc-meta" id="tcMeta"></span>
          <button class="btn-secondary" id="tcCancel" type="button">Cancel</button>
          <button class="btn-primary" id="tcSave" type="button"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    st.modal = wrap;

    const close = () => { wrap.hidden = true; st.editing = null; };
    $('#tcClose', wrap).addEventListener('click', close);
    $('#tcCancel', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) close(); });

    $('#tcStart', wrap).addEventListener('input', () => { markQuick(); preview(); });
    $('#tcEnd', wrap).addEventListener('input', () => { markQuick(); preview(); });
    $('#tcQuick', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]'); if (!b) return;
      const sI = $('#tcStart', wrap), eI = $('#tcEnd', wrap);
      let s = parseYmd(sI.value);
      if (!s) { s = new Date(); s.setHours(0, 0, 0, 0); sI.value = ymd(s); }
      eI.value = ymd(addDays(addMonths(s, Number(b.dataset.m)), -1));   // 1 Jan + 1 year - 1 day = 31 Dec
      markQuick(); preview();
    });
    $('#tcExt', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      setExt(b.dataset.v); preview();
    });
    $('#tcMonths', wrap).addEventListener('input', preview);
    $('#tcNote', wrap).addEventListener('input', preview);
    $('#tcSave', wrap).addEventListener('click', save);
    $('#tcRemove', wrap).addEventListener('click', remove);
    return wrap;
  }
  function setExt(v) {
    const wrap = st.modal;
    wrap.querySelectorAll('#tcExt button').forEach(b => b.setAttribute('aria-checked', b.dataset.v === v ? 'true' : 'false'));
    $('#tcMonthsRow', wrap).classList.toggle('hidden', v !== 'yes');
  }
  function getExt() { return st.modal.querySelector('#tcExt button[aria-checked="true"]')?.dataset.v || 'discuss'; }
  function markQuick() {                                               // light the chip that matches the dates, if any
    const wrap = st.modal, s = parseYmd($('#tcStart', wrap).value), e = parseYmd($('#tcEnd', wrap).value);
    wrap.querySelectorAll('#tcQuick button').forEach(b => {
      b.classList.toggle('on', !!(s && e && ymd(addDays(addMonths(s, Number(b.dataset.m)), -1)) === ymd(e)));
    });
  }
  function formRow() {
    const wrap = st.modal;
    const ext = getExt();
    const months = ext === 'yes' ? Number($('#tcMonths', wrap).value) || null : null;
    return { start_date: $('#tcStart', wrap).value, end_date: $('#tcEnd', wrap).value, extension: ext, extension_months: months, note: $('#tcNote', wrap).value.trim() };
  }
  function preview() {
    const wrap = st.modal, row = formRow(), sum = $('#tcSum', wrap), pv = $('#tcPreview', wrap), msg = $('#tcMsg', wrap);
    const s = parseYmd(row.start_date), e = parseYmd(row.end_date);
    $('#tcStartF', wrap).classList.toggle('bad', !!(row.start_date && !s));
    $('#tcEndF', wrap).classList.toggle('bad', !!(row.end_date && !e) || !!(s && e && e < s));
    msg.textContent = '';
    const sec = pv.closest('.tc-prevsec');
    if (!s || !e) { sum.innerHTML = '<span style="color:#94a3b8">Pick a start and an end date.</span>'; pv.innerHTML = ''; sec?.classList.add('hidden'); return; }
    if (e < s) { sum.innerHTML = '<span style="color:#b42318">The end date is before the start date.</span>'; pv.innerHTML = ''; sec?.classList.add('hidden'); return; }
    sec?.classList.remove('hidden');
    const o = calc(row.start_date, row.end_date);
    const bits = [`<b>${o.totalDays} days</b>`, `ends on a <b>${fmtWeekday(e)}</b>`];
    if (o.state === 'future') bits.push(`starts in <b>${plural(o.days, 'day')}</b>`);
    else if (o.state === 'over') bits.push(`<b style="color:#b42318">already ended</b>`);
    else bits.push(`<b>${o.days === 0 ? 'last day today' : plural(o.days, 'day') + ' left'}</b>`);
    sum.innerHTML = bits.join('<span class="dot" aria-hidden="true"></span>');
    pv.innerHTML = stripHtml(st.editing ? st.editing.email : '', row, false);
  }
  function open(email, name, initials, acc) {
    const wrap = buildModal();
    const row = st.byEmail.get(email) || null;
    st.editing = { email, name, initials, acc, row };
    $('#tcName', wrap).textContent = name || email;
    const av = $('#tcAv', wrap); av.textContent = initials || '?'; av.style.setProperty('--acc', acc || '#475569');
    $('#tcStart', wrap).value = row ? row.start_date : '';
    $('#tcEnd', wrap).value = row ? row.end_date : '';
    $('#tcMonths', wrap).value = row && row.extension_months ? row.extension_months : '';
    $('#tcNote', wrap).value = row && row.note ? row.note : '';
    setExt(row ? row.extension : 'discuss');
    $('#tcRemove', wrap).classList.toggle('hidden', !row);
    $('#tcMeta', wrap).textContent = row && row.updated_by ? `Last saved by ${row.updated_by}${row.updated_at ? ' · ' + fmtStamp(row.updated_at) : ''}` : '';
    $('#tcMsg', wrap).textContent = '';
    const sb = $('#tcSave', wrap); sb.disabled = false;
    markQuick(); preview();
    wrap.hidden = false;
    setTimeout(() => $('#tcStart', wrap).focus(), 30);
  }
  async function save() {
    const wrap = st.modal, row = formRow(), msg = $('#tcMsg', wrap), btn = $('#tcSave', wrap);
    const s = parseYmd(row.start_date), e = parseYmd(row.end_date);
    if (!s || !e) { msg.textContent = 'Please pick both dates.'; return; }
    if (e < s) { msg.textContent = 'The end date must not be before the start date.'; return; }
    if (row.extension === 'yes' && $('#tcMonths', wrap).value && !row.extension_months) { msg.textContent = 'Months must be a whole number from 1 to 120, or left empty.'; return; }
    btn.disabled = true; msg.textContent = '';
    try {
      const j = await api('cal-contract-save', {
        teacherEmail: st.editing.email, startDate: row.start_date, endDate: row.end_date,
        extension: row.extension, extensionMonths: row.extension_months, note: row.note || null
      });
      const saved = j.contract || Object.assign({ teacher_email: st.editing.email }, row);
      st.byEmail.set(st.editing.email, saved);
      refreshCard(st.editing.email);
      wrap.hidden = true; st.editing = null;
      toast('Contract saved.', 'ok');
    } catch (err) {
      msg.textContent = err.message || 'Save failed.';
    } finally { btn.disabled = false; }
  }
  async function remove() {
    const wrap = st.modal, msg = $('#tcMsg', wrap), who = st.editing;
    if (!who) return;
    const ok = await confirmBox(`Remove the contract dates for "${who.name || who.email}"?\nThe card goes back to "No contract dates yet".`, { title: 'Remove contract?', okLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await api('cal-contract-delete', { teacherEmail: who.email });
      st.byEmail.delete(who.email);
      refreshCard(who.email);
      wrap.hidden = true; st.editing = null;
      toast('Contract removed.', 'ok');
    } catch (err) { msg.textContent = err.message || 'Remove failed.'; }
  }

  /* ---------- wiring ---------- */
  function cardInfo(strip) {
    const card = strip.closest('.tcv2-card');
    return {
      email: String(strip.dataset.email || card?.dataset.email || '').toLowerCase(),
      name: card?.querySelector('.tcv2-name')?.textContent?.trim() || '',
      initials: card?.querySelector('.tcv2-av')?.textContent?.trim() || '?',
      acc: card ? getComputedStyle(card).getPropertyValue('--acc').trim() : ''
    };
  }
  function bind() {
    const root = document.getElementById('tBoardContent'); if (!root) return;
    root.addEventListener('click', (e) => {                              // tansinh fixed-hours: the pin
      const pin = e.target.closest('.tc-pin'); if (!pin) return;
      e.preventDefault(); e.stopPropagation();                        // the card's own handlers must not see this click
      const email = String(pin.dataset.email || pin.closest('.tcv2-card')?.dataset.email || '').toLowerCase();
      if (!email || pin.disabled) return;
      setFixed(email, pin.getAttribute('aria-pressed') !== 'true', pin);
    });
    root.addEventListener('click', (e) => {
      const strip = e.target.closest('.tc-strip.tc-edit'); if (!strip) return;
      e.preventDefault(); e.stopPropagation();                        // keep the card's other click handlers out of it
      const i = cardInfo(strip); if (i.email) open(i.email, i.name, i.initials, i.acc);
    });
    root.addEventListener('keydown', (e) => {
      const strip = e.target.closest ? e.target.closest('.tc-strip.tc-edit') : null; if (!strip) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const i = cardInfo(strip); if (i.email) open(i.email, i.name, i.initials, i.acc); }
    });
    // whenever the board is (re)drawn — render, tab switch, refresh — put the strips back
    st.obs = new MutationObserver(() => { clearTimeout(st.decT); st.decT = setTimeout(decorate, 30); });
    st.obs.observe(root, { childList: true, subtree: true });
    // the Refresh button re-reads the contracts too, so a change by another admin shows up
    document.getElementById('tRefreshBoard')?.addEventListener('click', () => { st.loaded = false; });
    // a sign-out must forget the previous person's data (a Teacher must never see an Admin's list)
    let tries = 0;
    const hook = setInterval(() => {
      tries++;
      if (typeof client !== 'undefined' && client && client.auth) {
        clearInterval(hook);
        try { client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { reset(); document.querySelectorAll('#tBoardContent .tc-strip, #tBoardContent .tc-pin, #tBoardContent .tc-hbadge').forEach(el => el.remove()); } }); } catch (e) { /* harmless */ }   // tansinh fixed-hours
      } else if (tries > 100) clearInterval(hook);                     // 20 s: give up quietly
    }, 200);
    startTicker();
    decorate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // for the console: tcContract.calc('2026-01-01','2026-12-31'), tcContract.reload()
  window.tcContract = { VERSION: TC.VERSION, calc, reload: () => { st.loaded = false; return load().then(decorate); }, state: st, setFixed: (email, on) => setFixed(String(email || '').toLowerCase(), !!on) };   // tansinh fixed-hours
})();
