/* teacherlevels.js — "Level assignment": the levels a teacher may teach, on the Teacher Calendars cards  (9 Oct 2026)

   Loaded by teachercalendar.html AFTER teacher.js, teachercalendar-v2.js and teachercontract.js.
   It edits none of them. It watches #tBoardContent and, whenever the By-teacher cards are
   (re)drawn, puts ONE badge in the header of every .tcv2-card, after the role badges:

       [layers] Levels (5)          or, with nothing assigned yet:     [+] Assign levels

   ADMINS ONLY. The list route answers 403 to a Teacher, and then this module draws NOTHING —
   no badge, no popup. The server decides; the page only follows.

   Clicking the badge opens the picker, modelled on "Chọn cấp lớp" in writing.tansinh.info:
   a search box, one row per GROUP (KET, Test Prep, IELTS, B1, ...) with a colour dot, a count
   and a chevron that unfolds the levels inside it, a checkbox on the group that takes the whole
   group, "Select all", "Selected: N levels", Clear, Apply.

   DATA comes from two routes in cal-teacher-levels.calendar.js, called with the Supabase token the
   page already holds (the global `client` from teacher.js):
       GET  /api/cal-teacher-levels-list     POST /api/cal-teacher-levels-save
   The rows live in level_assignments (teacher_email, class_name) — the table the calendar's
   "Level Mismatch" check already reads, so a change here is felt the next time a teacher is put
   on a student. The GROUPS come from the server too, grouped by the same rules as script.js.

   Uses from the page: client (teacher.js), uiToast (ui-dialog.js). Falls back to alert().
   Every class name starts with tlv- so nothing here collides with the page's own CSS.      */
(function () {
  'use strict';
  if (window.__tcLevels) return;                                      // loaded twice: keep the first copy
  window.__tcLevels = true;

  const TL = {
    VERSION: '20261009_levels1',
    TIP_MAX: 12,                                                      // levels named in the badge tooltip before "…"
    RETRY_MS: 30 * 1000                                               // after a failed load, wait this long before trying again
  };
  /* one colour per group — the hues the writing picker uses; a group not listed gets slate */
  const COLOR = {
    'PRE-STARTERS': '#0EA5E9', 'STARTERS': '#06B6D4', 'MOVERS': '#3B82F6', 'FLYERS': '#6366F1',
    'KET': '#F59E0B', 'TEST PREP': '#7C3AED', 'IELTS': '#14B8A6', 'B1': '#EC4899', 'B2': '#65A30D',
    'INTERACTION': '#F97316', 'TIỂU HỌC': '#0D9488', 'THCS/THPT': '#DC2626',
    'BUSINESS 1': '#475569', 'BUSINESS 2': '#B45309', 'TOEIC': '#2563EB', 'OTHERS': '#64748B'
  };

  const st = {
    loaded: false, loading: null, denied: false, failedAt: 0,
    canEdit: false, me: null,
    levels: [],                          // [{ name, group, students }]
    groups: [],                          // [{ key, label, levels: [names] }]
    byEmail: new Map(),                  // email -> [names]
    modal: null, editing: null,          // { email, name, initials, acc }
    sel: new Set(), open: new Set(), q: '',
    obs: null, decT: null
  };

  /* ---------- tiny helpers ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const toast = (msg, kind) => (window.uiToast ? window.uiToast(msg, kind) : alert(msg));
  const lower = (s) => String(s || '').trim().toLowerCase();
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

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
    if (!t) { const e = new Error('Please sign in first.'); e.status = 401; throw e; }
    const res = await fetch('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Authorization': 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let j = null; try { j = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) { const e = new Error((j && j.error) || `${path} failed (${res.status})`); e.status = res.status; throw e; }
    return j || {};
  }
  function load() {
    if (st.loading) return st.loading;
    st.loading = (async () => {
      try {
        const j = await api('cal-teacher-levels-list');
        st.levels = Array.isArray(j.levels) ? j.levels : [];
        st.groups = Array.isArray(j.groups) ? j.groups : [];
        st.byEmail = new Map(Object.entries(j.assignments || {}).map(([e, l]) => [lower(e), Array.isArray(l) ? l : []]));
        st.canEdit = !!j.canEdit; st.me = j.me || null;
        st.denied = false; st.loaded = true;
      } catch (e) {
        if (e.status === 403 || e.status === 401) {                   // a Teacher, or not signed in: nothing to draw, say nothing
          st.denied = true; st.canEdit = false; st.loaded = true;
        } else {
          console.warn('[tc-levels] could not load the level assignments:', e.message || e);
          st.loaded = false; st.failedAt = Date.now();
        }
      } finally { st.loading = null; }
    })();
    return st.loading;
  }
  function reset() { st.loaded = false; st.denied = false; st.canEdit = false; st.me = null; st.levels = []; st.groups = []; st.byEmail = new Map(); }

  /* ---------- the badge on every card ---------- */
  function badgeHtml(list) {
    if (!list.length) return '<i class="fa-regular fa-square-plus" aria-hidden="true"></i>Assign levels';
    return `<i class="fa-solid fa-layer-group" aria-hidden="true"></i>Levels<b>${list.length}</b>`;
  }
  function badgeTip(list) {
    if (!list.length) return 'No levels assigned yet. Click to choose the levels this teacher can teach.';
    const shown = list.slice(0, TL.TIP_MAX).join(', ') + (list.length > TL.TIP_MAX ? ` … (+${list.length - TL.TIP_MAX})` : '');
    return `Levels this teacher can teach: ${shown}\nClick to change.`;
  }
  function badgeCard(card, email) {
    const head = card.querySelector(':scope > .tcv2-chd'); if (!head) return;
    let b = head.querySelector(':scope > .tlv-hb');
    if (!st.canEdit) { if (b) b.remove(); return; }                   // not an admin: no badge at all
    const list = st.byEmail.get(email) || [];
    const key = list.join('|');
    if (!b) {
      b = document.createElement('span');
      b.setAttribute('role', 'button'); b.tabIndex = 0;
      const before = head.querySelector(':scope > .tfx-hb') || head.querySelector(':scope > .tcv2-onnow');   // roles, LEVELS, fixed hours, On now
      if (before) head.insertBefore(b, before); else head.appendChild(b);
    }
    b.dataset.email = email;
    if (b.dataset.k !== key) {                                        // rewrite only on a real change (observer!)
      b.className = 'tlv-hb ' + (list.length ? 'tlv-set' : 'tlv-none');
      b.innerHTML = badgeHtml(list);
      b.title = badgeTip(list);
      b.setAttribute('aria-label', list.length ? `${list.length} levels assigned, click to change` : 'No levels assigned, click to choose');
      b.dataset.k = key;
    }
  }
  function decorate() {
    const root = document.getElementById('tBoardContent'); if (!root) return;
    const cards = root.querySelectorAll('.tcv2-card');
    if (!cards.length) return;
    if (!st.loaded) {
      if (st.failedAt && Date.now() - st.failedAt < TL.RETRY_MS) return;   // a failing route is not hammered on every redraw
      load().then(() => { if (st.loaded) decorate(); }); return;
    }
    cards.forEach(card => {
      const email = lower(card.dataset.email); if (!email) return;
      badgeCard(card, email);
    });
  }
  function refreshCard(email) {
    document.querySelectorAll('#tBoardContent .tcv2-card').forEach(card => {
      if (lower(card.dataset.email) === email) badgeCard(card, email);
    });
  }

  /* ---------- the picker ---------- */
  function buildModal() {
    if (st.modal) return st.modal;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop tlv-backdrop'; wrap.id = 'tlvModal'; wrap.hidden = true;
    wrap.innerHTML = `
      <div class="modal tlv-modal" role="dialog" aria-modal="true" aria-labelledby="tlvTitle">
        <div class="modal-header tlv-head">
          <h2 id="tlvTitle"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> Level assignment
            <span class="tlv-who"><span class="tlv-av" id="tlvAv">?</span><span id="tlvName">…</span></span></h2>
          <button class="modal-close" id="tlvClose" type="button" aria-label="Close">×</button>
        </div>
        <div class="modal-body tlv-body">
          <p class="tlv-hint">Tick every level this teacher can handle. The calendar warns when a student's level is outside this list.</p>
          <div class="tlv-panel">
            <div class="tlv-top">
              <span class="tlv-cap">Levels <b class="tlv-pill" id="tlvCount">0</b></span>
              <label class="tlv-all"><input type="checkbox" id="tlvAll"><span>Select all</span></label>
            </div>
            <label class="tlv-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
              <input type="search" id="tlvQ" placeholder="Find a level…" autocomplete="off" spellcheck="false"></label>
            <div class="tlv-list" id="tlvList" aria-live="polite"></div>
          </div>
          <p class="tlv-msg" id="tlvMsg"></p>
        </div>
        <div class="modal-footer tlv-foot">
          <span class="tlv-sum" id="tlvSum">Selected: 0 levels</span>
          <button class="btn-secondary tlv-clear" id="tlvClear" type="button"><i class="fa-regular fa-circle-xmark" aria-hidden="true"></i> Clear</button>
          <button class="btn-secondary" id="tlvCancel" type="button">Cancel</button>
          <button class="btn-primary tlv-apply" id="tlvApply" type="button"><i class="fa-solid fa-check" aria-hidden="true"></i> Apply</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    st.modal = wrap;

    const close = () => { wrap.hidden = true; st.editing = null; };
    $('#tlvClose', wrap).addEventListener('click', close);
    $('#tlvCancel', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) close(); });

    $('#tlvQ', wrap).addEventListener('input', (e) => { st.q = lower(e.target.value); render(); });
    $('#tlvAll', wrap).addEventListener('change', (e) => {
      const names = visibleNames();
      if (e.target.checked) names.forEach(n => st.sel.add(n)); else names.forEach(n => st.sel.delete(n));
      render();
    });
    $('#tlvClear', wrap).addEventListener('click', () => { st.sel.clear(); render(); });
    $('#tlvApply', wrap).addEventListener('click', save);

    const list = $('#tlvList', wrap);
    list.addEventListener('change', (e) => {
      const t = e.target;
      if (t.classList.contains('tlv-gc')) {                           // the group checkbox takes the whole group (what the search shows of it)
        const names = groupNames(t.dataset.g, true);
        if (t.checked) names.forEach(n => st.sel.add(n)); else names.forEach(n => st.sel.delete(n));
        if (t.checked) st.open.add(t.dataset.g);
        render();
      } else if (t.classList.contains('tlv-sc')) {
        if (t.checked) st.sel.add(t.dataset.l); else st.sel.delete(t.dataset.l);
        render();
      }
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.tlv-chev, .tlv-gn'); if (!btn) return;
      e.preventDefault();
      const g = btn.dataset.g;
      if (st.open.has(g)) st.open.delete(g); else st.open.add(g);
      render();
    });
    return wrap;
  }
  function groupNames(key, visibleOnly) {
    const g = st.groups.find(x => x.key === key); if (!g) return [];
    return visibleOnly && st.q ? g.levels.filter(n => lower(n).includes(st.q)) : g.levels.slice();
  }
  function visibleNames() {                                           // every level the list shows right now
    return st.groups.flatMap(g => st.q ? g.levels.filter(n => lower(n).includes(st.q)) : g.levels);
  }
  function render() {
    const wrap = st.modal; if (!wrap) return;
    const list = $('#tlvList', wrap);
    const keep = list.scrollTop;
    const stud = new Map(st.levels.map(l => [l.name, l.students]));
    const rows = [];
    for (const g of st.groups) {
      const names = st.q ? g.levels.filter(n => lower(n).includes(st.q)) : g.levels;
      if (!names.length) continue;
      const picked = names.filter(n => st.sel.has(n)).length;
      const all = picked === names.length, some = picked > 0 && !all;
      const open = st.open.has(g.key) || !!st.q;                      // a search unfolds every group it matches
      const col = COLOR[g.key] || COLOR.OTHERS;
      rows.push(`<div class="tlv-g${open ? ' open' : ''}${all ? ' all' : some ? ' some' : ''}" style="--g:${col}" data-g="${esc(g.key)}">`
        + `<div class="tlv-gr">`
        + `<input type="checkbox" class="tlv-gc" data-g="${esc(g.key)}" aria-label="All of ${esc(g.label)}"${all ? ' checked' : ''}${some ? ' data-some="1"' : ''}>`
        + `<span class="tlv-dot" aria-hidden="true"></span>`
        + `<button type="button" class="tlv-gn" data-g="${esc(g.key)}">${esc(g.label)}</button>`
        + `<span class="tlv-cnt" title="${picked ? `${picked} of ${names.length} chosen` : `${names.length} level${names.length === 1 ? '' : 's'}`}">${picked ? `<b>${picked}</b>/` : ''}${names.length}</span>`
        + `<button type="button" class="tlv-chev" data-g="${esc(g.key)}" aria-expanded="${open}" aria-label="${open ? 'Fold' : 'Unfold'} ${esc(g.label)}"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`
        + `</div>`
        + `<div class="tlv-sub"${open ? '' : ' hidden'}>`
        + names.map(n => `<label class="tlv-sr${st.sel.has(n) ? ' on' : ''}"><input type="checkbox" class="tlv-sc" data-l="${esc(n)}"${st.sel.has(n) ? ' checked' : ''}>`
          + `<span class="tlv-sn">${hi(n)}</span>${stud.has(n) ? `<small>${stud.get(n) ? `${stud.get(n)} student${stud.get(n) === 1 ? '' : 's'}` : 'no students'}</small>` : ''}</label>`).join('')
        + `</div></div>`);
    }
    list.innerHTML = rows.length ? rows.join('')
      : `<div class="tlv-empty">${st.levels.length ? 'No level matches that.' : 'No levels found. A level appears here once a student has it or a teacher holds it.'}</div>`;
    list.querySelectorAll('.tlv-gc[data-some]').forEach(cb => { cb.indeterminate = true; });
    list.scrollTop = keep;
    sum();
  }
  function hi(name) {                                                 // the matching part of a name, in bold
    if (!st.q) return esc(name);
    const i = lower(name).indexOf(st.q); if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + st.q.length)) + '</mark>' + esc(name.slice(i + st.q.length));
  }
  function sum() {
    const wrap = st.modal, n = st.sel.size;
    $('#tlvCount', wrap).textContent = n;
    $('#tlvSum', wrap).textContent = `Selected: ${n} level${n === 1 ? '' : 's'}`;
    const vis = visibleNames(), picked = vis.filter(x => st.sel.has(x)).length;
    const all = $('#tlvAll', wrap);
    all.checked = vis.length > 0 && picked === vis.length;
    all.indeterminate = picked > 0 && picked < vis.length;
    all.disabled = !vis.length;
    const stored = new Set(st.editing ? (st.byEmail.get(st.editing.email) || []) : []);
    $('#tlvApply', wrap).classList.toggle('tlv-same', sameSet(st.sel, stored));
  }
  function open(email, name, initials, acc) {
    const wrap = buildModal();
    st.editing = { email, name, initials, acc };
    st.sel = new Set(st.byEmail.get(email) || []);
    st.open = new Set(st.groups.filter(g => g.levels.some(n => st.sel.has(n))).map(g => g.key));   // what is chosen starts unfolded
    st.q = ''; $('#tlvQ', wrap).value = '';
    $('#tlvName', wrap).textContent = name || email;
    const av = $('#tlvAv', wrap); av.textContent = initials || '?'; av.style.setProperty('--acc', acc || '#475569');
    $('#tlvMsg', wrap).textContent = '';
    $('#tlvApply', wrap).disabled = false;
    render();
    wrap.hidden = false;
    setTimeout(() => $('#tlvQ', wrap).focus(), 30);
  }
  async function save() {
    const wrap = st.modal, who = st.editing; if (!who) return;
    const msg = $('#tlvMsg', wrap), btn = $('#tlvApply', wrap);
    const stored = new Set(st.byEmail.get(who.email) || []);
    if (sameSet(st.sel, stored)) { wrap.hidden = true; st.editing = null; toast('No change.', 'info'); return; }
    btn.disabled = true; msg.textContent = '';
    try {
      const j = await api('cal-teacher-levels-save', { teacherEmail: who.email, levels: [...st.sel] });
      const after = Array.isArray(j.levels) ? j.levels : [...st.sel];
      st.byEmail.set(who.email, after);
      refreshCard(who.email);
      wrap.hidden = true; st.editing = null;
      toast(`Levels saved for ${who.name || who.email}: ${after.length}${j.added || j.removed ? ` (+${j.added || 0} −${j.removed || 0})` : ''}.`, 'ok');
    } catch (err) {
      msg.textContent = err.message || 'Save failed.';
    } finally { btn.disabled = false; }
  }

  /* ---------- wiring ---------- */
  function cardInfo(el) {
    const card = el.closest('.tcv2-card');
    return {
      email: lower(el.dataset.email || card?.dataset.email),
      name: card?.querySelector('.tcv2-name')?.textContent?.trim() || '',
      initials: card?.querySelector('.tcv2-av')?.textContent?.trim() || '?',
      acc: card ? getComputedStyle(card).getPropertyValue('--acc').trim() : ''
    };
  }
  function bind() {
    const root = document.getElementById('tBoardContent'); if (!root) return;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.tlv-hb'); if (!b) return;
      e.preventDefault(); e.stopPropagation();                        // the card's own handlers must not see this click
      const i = cardInfo(b); if (i.email && st.canEdit) open(i.email, i.name, i.initials, i.acc);
    });
    root.addEventListener('keydown', (e) => {
      const b = e.target.closest ? e.target.closest('.tlv-hb') : null; if (!b) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const i = cardInfo(b); if (i.email && st.canEdit) open(i.email, i.name, i.initials, i.acc); }
    });
    // whenever the board is (re)drawn — render, tab switch, refresh — put the badges back
    st.obs = new MutationObserver(() => { clearTimeout(st.decT); st.decT = setTimeout(decorate, 30); });
    st.obs.observe(root, { childList: true, subtree: true });
    // the Refresh button re-reads the assignments too, so a change by another admin shows up
    document.getElementById('tRefreshBoard')?.addEventListener('click', () => { st.loaded = false; st.failedAt = 0; });
    // a sign-out must forget the previous person's data (a Teacher must never see an Admin's list)
    let tries = 0;
    const hook = setInterval(() => {
      tries++;
      if (typeof client !== 'undefined' && client && client.auth) {
        clearInterval(hook);
        try {
          client.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') { reset(); document.querySelectorAll('#tBoardContent .tlv-hb').forEach(el => el.remove()); if (st.modal) st.modal.hidden = true; }
            if (event === 'SIGNED_IN') { st.loaded = false; st.failedAt = 0; decorate(); }      // the next person may be an admin
          });
        } catch (e) { /* harmless */ }
      } else if (tries > 100) clearInterval(hook);                     // 20 s: give up quietly
    }, 200);
    decorate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // for the console: tcLevels.reload(), tcLevels.open('teacher@tansinh.info'), tcLevels.state
  window.tcLevels = {
    VERSION: TL.VERSION, state: st,
    reload: () => { st.loaded = false; st.failedAt = 0; return load().then(decorate); },
    open: (email) => { const b = document.querySelector(`#tBoardContent .tlv-hb[data-email="${lower(email)}"]`); if (b) { const i = cardInfo(b); open(i.email, i.name, i.initials, i.acc); } else toast('No card for that teacher on screen.', 'error'); }
  };
})();
