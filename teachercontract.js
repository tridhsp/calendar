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
   FIXED BLOCKS (8 Oct 2026): the pin now opens a popup that pins WHOLE BLOCKS or PART OF A BLOCK
   ("fixed from 18:00"). Rows in teacher_fixed_hours, read by cal-fixed-ranges-list, written by
   cal-fixed-ranges-save. The old flag is kept in step. See the fixed-blocks block below.

   CONTRACT4 (7 Oct 2026): the strip is drawn as a TIME BAR like the rows above it — the two dates at
   either end, a filled track with a "today" marker, the count on the right — instead of a tinted
   panel. And a card whose teacher has Fixed hours carries the class tc-fixed, which the CSS turns
   into an ink ring, a tinted top, a ring round the avatar and an amber pin. The class names inside
   the strip did not change, so tick() and the popup preview are untouched.

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
    VERSION: '20261008_fixedblocks6',                                 // contract4: time-bar strip + the Fixed-hours card look (7 Oct 2026)
    SOON_DAYS: 60,                      // amber from here down
    URGENT_DAYS: 14,                    // red from here down
    EXT: { yes: 'Renewable', no: 'Fixed term', discuss: 'To discuss' },
    EXT_ICON: { yes: 'fa-solid fa-rotate', no: 'fa-solid fa-lock', discuss: 'fa-regular fa-circle-question' },
    QUICK: [[3, '3 months'], [4, '4 months'], [6, '6 months'], [12, '1 year'], [24, '2 years']],   // 4 months added 8 Oct 2026
    DAY: 24 * 60 * 60 * 1000
  };

  const st = {
    byEmail: new Map(),                 // email -> contract row
    fixed: new Set(),                   // emails whose free hours are FIXED (teacher_flags)     tansinh fixed-hours
    ranges: new Map(),                  // email -> [{day, s, e}] fixed ranges in minutes (teacher_fixed_hours)     tansinh fixed-blocks
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
  /* === tansinh contract4 BEGIN (7 Oct 2026) === the strip is a TIME BAR, like the rows above it:
       [ico] CONTRACT . under 14 days  [Fixed term]                2 days left . 03:04:51
       1 Oct 2026 ==================o------------------------------ 9 Oct 2026 . 9 days
     The class names inside are the same as before, so tick() and the popup preview need no change. */
  function stripHtml(email, row, canEdit) {
    const edit = canEdit ? ' tc-edit" role="button" tabindex="0" title="Click to edit the contract dates' : '';
    const ico = `<span class="tc-ico"><i class="fa-solid fa-file-signature" aria-hidden="true"></i></span>`;
    if (!row) {
      if (!canEdit) return '';
      return `<div class="tc-strip tc-none${edit}" data-email="${esc(email)}">`
        + `<span class="tc-top">${ico}<span class="tc-lbl">Contract <small>· no dates yet</small></span>`
        + `<span class="tc-set"><i class="fa-solid fa-plus" aria-hidden="true"></i> Set contract dates</span></span>`
        + `</div>`;
    }
    const o = calc(row.start_date, row.end_date);
    if (!o) return '';
    const p = countParts(o);
    const word = STATE_WORD[o.state];
    return `<div class="tc-strip tc-${o.state}${edit}" data-email="${esc(email)}" data-start="${esc(row.start_date)}" data-end="${esc(row.end_date)}">`
      + `<span class="tc-top">${ico}`
      + `<span class="tc-lbl">Contract${word ? ` <small>· ${word}</small>` : ''}</span>`
      + extTag(row)
      + `<span class="tc-count"><b class="tc-days${p.word ? ' word' : ''}">${esc(p.big)}</b><span class="tc-dl">${esc(p.unit)}</span><span class="tc-clock">${p.clock}</span></span>`
      + `</span>`
      + `<span class="tc-track">`
      + `<b class="tc-d0">${esc(fmtDate(o.s))}</b>`
      + `<span class="tc-bar"><i style="width:${o.pct.toFixed(1)}%"></i></span>`
      + `<b class="tc-d1">${esc(fmtDate(o.e))}</b>`
      + `<span class="tc-len">· ${plural(o.totalDays, 'day')}</span>`
      + `</span>`
      + `</div>`;
  }
  /* === tansinh contract4 END === */

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
        const [j, fr] = await Promise.all([api('cal-contracts-list'),                                 // tansinh fixed-blocks: both lists at once
          api('cal-fixed-ranges-list').catch(e => { console.warn('[tc-contract] fixed ranges not loaded:', e.message || e); return { ranges: [] }; })]);
        st.byEmail = new Map((j.contracts || []).map(r => [String(r.teacher_email).toLowerCase(), r]));
        st.fixed = new Set((j.fixed || []).map(e => String(e).toLowerCase()));                   // tansinh fixed-hours
        st.ranges = tfxIndex(fr.ranges);                                                            // tansinh fixed-blocks
        st.canEdit = !!j.canEdit; st.role = j.role || null; st.me = j.me || null;
        st.loaded = true;
      } catch (e) {
        console.warn('[tc-contract] could not load contracts:', e.message || e);
        st.loaded = false;
      } finally { st.loading = null; }
    })();
    return st.loading;
  }
  function reset() { st.byEmail = new Map(); st.fixed = new Set(); st.ranges = new Map(); st.canEdit = false; st.role = null; st.me = null; st.loaded = false; }   // tansinh fixed-hours

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

  /* === tansinh fixed-blocks BEGIN (8 Oct 2026) === fixed hours PER BLOCK, and PART of a block.
     The pin on the card no longer flips one flag for the whole teacher. It opens a popup that draws
     the teacher's week exactly like the card (same ruler, same bars) and lets an admin pin whole
     blocks, or only part of one: a block 16:00-21:00 can be "fixed from 18:00".
     DATA: public.teacher_fixed_hours, one row per fixed range (teacher_email, day_of_week,
     time_start, time_end), read by GET /api/cal-fixed-ranges-list and written as a SET by
     POST /api/cal-fixed-ranges-save (cal-fixedhours.calendar.js). Keyed by TIME, never by the
     availability row's id, because save-teacher-schedule re-creates those rows on every edit. A
     range survives a re-cut as long as it still falls inside a block; one outside every block is
     not drawn and is dropped on the next save.
     teacher_flags.fixed_hours (the old per-teacher flag) is kept in step through the existing
     /api/cal-fixed-hours-set: true while at least one range exists. Anything else that reads the
     flag keeps working. pinCard() keeps its name, so decorate() did not change.
     ON THE CARD (fixedblocks3, 8 Oct 2026): the fixed part of a bar is a slightly darker band with an
     underline in the TEACHER'S OWN COLOUR (--acc, the card's accent) over a white hairline, so it reads
     on any role colour. No pin on the bars. The header badge measures the teacher:
         "Fixed 67% · 2 blocks"   percent = fixed minutes / the teacher's free minutes (per day, overlaps
                                  counted once), blocks = number of separate fixed ranges that fall
                                  inside a free block; a short bar in the badge fills to the percent.
     Three looks, thresholds in TFX.TIERS:  full (>= 75%) an ink border and a gold star — the
     teachers the school wants; mid (>= 25%) amber; low (anything else above 0) red, a teacher to
     keep an eye on. The badge stays white so the bar and the teacher's colour read. The card itself
     is NOT ringed any more (TFX.CARD_RING): most teachers have some fixed hours, so a ring on most
     cards would say nothing. NO RANGES, NO BADGE, NO RING, NO DARK PIN — the old on/off flag is
     never used for display any more (it stays in step for whatever else reads it).
     All of it is idempotent: decorate() runs on every DOM change, so a second pass must change
     nothing (the MutationObserver would otherwise loop). */
  const FIXED_OFF_TIP = 'No fixed hours yet. Click to choose which of this teacher\'s free hours are fixed.';
  const TFX = {
    START: 18 * 60, LANE: 24,                                           // the quick rule's default "from", and the popup's lane height (same as the card)
    TIERS: { full: 75, mid: 25 },                                       // percent of free hours fixed: >= full ink border + star, >= mid amber, else red
    CARD_RING: false                                                    // true = the top tier also gets contract4's ink ring round the whole card. Off since 8 Oct: most teachers reach it, so the ring said nothing
  };
  const TIER_WORD = { full: 'solid fixed hours', mid: 'partly fixed', low: 'barely fixed' };

  /* ---- time helpers: minutes since midnight <-> "HH:MM" ---- */
  const tfxMin = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const tfxFmt = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const tfxOverlap = (aS, aE, bS, bE) => aS < bE && bS < aE;
  const tfxDayName = (d) => (typeof weekdayLong === 'function' ? weekdayLong(d) : (TCV2.SHORTDAY[d] || String(d)));

  /* the list reply -> Map email -> [{day, s, e}] in minutes, sorted */
  function tfxIndex(rows) {
    const m = new Map();
    for (const r of (rows || [])) {
      const email = String(r.teacher_email || '').toLowerCase();
      const s = tfxMin(r.time_start), e = tfxMin(r.time_end), day = Number(r.day_of_week);
      if (!email || isNaN(s) || isNaN(e) || e <= s || !(day >= 0 && day <= 6)) continue;
      if (!m.has(email)) m.set(email, []);
      m.get(email).push({ day, s, e });
    }
    for (const list of m.values()) list.sort((a, b) => a.day - b.day || a.s - b.s);
    return m;
  }
  const tfxRanges = (email) => st.ranges.get(email) || [];
  const tfxHasAny = (email) => tfxRanges(email).length > 0;            // the old flag never decides what is shown
  /* merge ranges of one day that overlap or touch, so the table never holds 18-20 next to 18-21 */
  function tfxMerge(list) {
    const out = [];
    for (const r of [...list].sort((a, b) => a.day - b.day || a.s - b.s)) {
      const last = out[out.length - 1];
      if (last && last.day === r.day && r.s <= last.e) last.e = Math.max(last.e, r.e);
      else out.push({ day: r.day, s: r.s, e: r.e });
    }
    return out;
  }
  /* the pieces of a block [s, e) that are fixed, clipped to the block, sorted */
  function tfxPieces(email, day, s, e) {
    const out = [];
    if (e > s) for (const r of tfxRanges(email)) if (r.day === day && tfxOverlap(r.s, r.e, s, e)) out.push([Math.max(s, r.s), Math.min(e, r.e)]);
    return out.sort((a, b) => a[0] - b[0]);
  }
  /* [[s,e],...] -> merged, sorted (overlapping or touching intervals become one) */
  function tfxUnion(list) {
    const out = [];
    for (const [s, e] of [...list].sort((a, b) => a[0] - b[0])) { const l = out[out.length - 1]; if (l && s <= l[1]) l[1] = Math.max(l[1], e); else out.push([s, e]); }
    return out;
  }
  const tfxH = (min) => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${pad(m)}` : `${h}h`; };
  /* THE MEASURE. blocks [{day,s,e}] are the teacher's free hours, ranges [{day,s,e}] the fixed ones.
     Per day: free = the union of the blocks (a stacked overlap counts once), fixed = the union of the
     ranges clipped to that free time. -> { free, fixed, pct, blocks, days, workDays, tier } */
  function tfxStats(blocks, ranges) {
    const byDay = new Map();
    for (const b of blocks) { if (!byDay.has(b.day)) byDay.set(b.day, []); byDay.get(b.day).push([b.s, b.e]); }
    let free = 0, fixed = 0, days = 0, n = 0;
    for (const [day, iv] of byDay) {
      const fu = tfxUnion(iv); free += fu.reduce((a, [s, e]) => a + e - s, 0);
      const pieces = [];
      for (const r of ranges) if (r.day === day) for (const [s, e] of fu) if (tfxOverlap(r.s, r.e, s, e)) pieces.push([Math.max(s, r.s), Math.min(e, r.e)]);
      const fx = tfxUnion(pieces); const fxMin = fx.reduce((a, [s, e]) => a + e - s, 0);
      fixed += fxMin; n += fx.length; if (fxMin > 0) days++;
    }
    const pct = free && fixed ? Math.max(1, Math.round(fixed / free * 100)) : 0;
    const tier = !fixed ? '' : pct >= TFX.TIERS.full ? 'full' : pct >= TFX.TIERS.mid ? 'mid' : 'low';
    return { free, fixed, pct, blocks: n, days, workDays: byDay.size, tier };
  }
  const tfxCardBlocks = (card) => [...card.querySelectorAll('.tcv2-lane .tcv2-bk[data-day]')]
    .map(bk => ({ day: Number(bk.dataset.day), s: Number(bk.dataset.s), e: Number(bk.dataset.e) })).filter(b => b.e > b.s);
  function tfxBadgeHtml(st_) {
    return `<i class="tfx-bar" style="--p:${st_.pct}" aria-hidden="true"></i>Fixed ${st_.pct}%<small>· ${st_.blocks} block${st_.blocks === 1 ? '' : 's'}</small>`;
  }
  function tfxBadgeTip(st_, rs) {
    return `${TIER_WORD[st_.tier] || ''}: ${tfxH(st_.fixed)} of ${tfxH(st_.free)} free hours are fixed (${st_.pct}%), on ${st_.days} of ${st_.workDays} working day${st_.workDays === 1 ? '' : 's'}. `
      + rs.map(r => `${TCV2.SHORTDAY[r.day]} ${tfxFmt(r.s)}–${tfxFmt(r.e)}`).join(' · ');
  }

  /* idempotent: called on every (re)draw, changes the DOM only when the state differs */
  function pinCard(card, email) {
    const rs = tfxRanges(email), on = tfxHasAny(email);
    const m = tfxStats(tfxCardBlocks(card), rs);
    const show = on && m.fixed > 0;                                       // ranges that fall inside no block show nothing
    card.classList.toggle('tc-fixed', TFX.CARD_RING && m.tier === 'full'); // contract4's ink ring round the card: off by default (see TFX.CARD_RING)
    const head = card.querySelector(':scope > .tcv2-chd');
    if (head) {
      let badge = head.querySelector(':scope > .tfx-hb');
      if (show && !badge) {
        badge = document.createElement('span');
        const now = head.querySelector(':scope > .tcv2-onnow');                  // roles, then the measure, then On now
        if (now) head.insertBefore(badge, now); else head.appendChild(badge);
      } else if (!show && badge) { badge.remove(); badge = null; }
      if (badge) {
        const key = `${m.tier}|${m.pct}|${m.blocks}|` + rs.map(r => `${r.day}:${r.s}-${r.e}`).join('|');
        if (badge.dataset.k !== key) {                                           // rewrite only on a real change (observer!)
          badge.className = `tfx-hb tfx-${m.tier}`;
          badge.innerHTML = tfxBadgeHtml(m);
          badge.title = tfxBadgeTip(m, rs);
          badge.dataset.k = key;
        }
      }
    }
    tfxPaintBars(card, email);
    const acts = card.querySelector(':scope > .tcv2-acts'); if (!acts) return;
    let pin = acts.querySelector(':scope > .tc-pin');
    if (!st.canEdit) { if (pin) pin.remove(); return; }                   // a Teacher sees the badge and the bands, not the button
    if (!pin) {
      pin = document.createElement('button'); pin.type = 'button'; pin.className = 'card-action tc-pin';
      pin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
      acts.insertBefore(pin, acts.firstChild);                                // before the pencil
    }
    pin.dataset.email = email;
    pin.setAttribute('aria-pressed', show ? 'true' : 'false');
    pin.title = show ? `Fixed hours: ${m.pct}% of this teacher\'s free hours are fixed (${m.blocks} block${m.blocks === 1 ? '' : 's'}). Click to change which hours.` : FIXED_OFF_TIP;
    pin.setAttribute('aria-label', show ? 'Fixed hours set. Change which hours' : 'No fixed hours. Choose which hours');
  }
  /* the bands on the card's bars. Each bar keeps a key of its pieces in data-tfx; same key = nothing to do. */
  function tfxPaintBars(card, email) {
    card.querySelectorAll('.tcv2-lane .tcv2-bk[data-day]').forEach(bk => {
      const day = Number(bk.dataset.day), s = Number(bk.dataset.s), e = Number(bk.dataset.e);
      const pieces = tfxPieces(email, day, s, e);
      const key = pieces.map(p => p.join('-')).join(',');
      if ((bk.dataset.tfx || '') === key) return;
      bk.querySelectorAll(':scope > .tfx-bp').forEach(x => x.remove());
      const span = e - s;
      pieces.forEach(([a, b]) => {
        const i = document.createElement('i'); i.className = 'tfx-bp';
        i.style.left = ((a - s) / span * 100).toFixed(2) + '%'; i.style.width = ((b - a) / span * 100).toFixed(2) + '%';
        bk.insertBefore(i, bk.firstChild);
      });
      bk.classList.toggle('tfx', pieces.length > 0);
      bk.classList.toggle('tfx-all', pieces.length === 1 && pieces[0][0] <= s && pieces[0][1] >= e);
      if (!('tip0' in bk.dataset)) bk.dataset.tip0 = bk.dataset.tip || '';     // the card's own tooltip, kept once
      bk.dataset.tip = bk.dataset.tip0 + (pieces.length ? ' · fixed ' + pieces.map(([a, b]) => `${tfxFmt(a)}–${tfxFmt(b)}`).join(', ') : '');
      bk.dataset.tfx = key;
    });
  }
  /* kept for the console and for anything that still flips the old flag by hand */
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

  /* ---------- the popup ---------- */
  function tfxBuildModal() {
    if (st.fxModal) return st.fxModal;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop tfx-backdrop'; wrap.id = 'tfxModal'; wrap.hidden = true;
    wrap.innerHTML = `
      <div class="modal tfx-modal" role="dialog" aria-modal="true" aria-labelledby="tfxTitle">
        <div class="modal-header">
          <h2 id="tfxTitle"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i> Fixed hours
            <span class="tc-who"><span class="tc-av" id="tfxAv">?</span><span id="tfxName">…</span></span></h2>
          <button class="modal-close" id="tfxClose" type="button" aria-label="Close">×</button>
        </div>
        <div class="modal-body tfx-body">
          <p class="tfx-hint">Click a bar to pin the whole block. Pinned hours never change; the rest may move week to week. To pin only <b>part</b> of a block — the start, the middle or the end — click it, press <b>Part of it</b>, then pick <b>from</b> and <b>to</b> below.</p>
          <div class="tfx-week" id="tfxWeek"></div>
          <div class="tfx-ed" id="tfxEd"></div>
          <div class="tfx-tools">
            <span class="tfx-lg"><i class="tfx-lg-on"></i>fixed <i class="tfx-lg-off"></i>flexible</span>
            <span class="tfx-rule"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Every day, fixed from <select id="tfxFrom" aria-label="Fixed from"></select> to <select id="tfxTo" aria-label="Fixed to"></select> <button type="button" id="tfxApplyFrom">Apply</button></span>
            <button type="button" id="tfxAll">Pin all</button>
            <button type="button" id="tfxNone">Unpin all</button>
          </div>
          <p class="tc-msg" id="tfxMsg"></p>
        </div>
        <div class="modal-footer tc-foot">
          <span class="tc-meta" id="tfxSum"></span>
          <button class="btn-secondary" id="tfxCancel" type="button">Cancel</button>
          <button class="btn-primary tfx-save" id="tfxSave" type="button"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    st.fxModal = wrap;

    const close = () => { wrap.hidden = true; st.fx = null; };
    $('#tfxClose', wrap).addEventListener('click', close);
    $('#tfxCancel', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) close(); });

    const week = $('#tfxWeek', wrap);
    week.addEventListener('click', (e) => { const bk = e.target.closest('.tfx-bk'); if (bk) tfxToggle(Number(bk.dataset.i), false); });
    week.addEventListener('keydown', (e) => {
      const bk = e.target.closest('.tfx-bk'); if (!bk) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tfxToggle(Number(bk.dataset.i), true); }
    });
    const ed = $('#tfxEd', wrap);
    ed.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]'); if (!b || !st.fx || st.fx.sel === null) return;
      tfxSetMode(st.fx.sel, b.dataset.m); tfxRender(true);              // the row is redrawn too, so the chosen button goes dark
      if (b.dataset.m === 'part') { const ps = $('#tfxPs', wrap); if (ps) ps.focus(); }
    });
    const onPart = (e) => { if (e.target.matches('#tfxPs, #tfxPe')) tfxPartInput(); };
    ed.addEventListener('input', onPart); ed.addEventListener('change', onPart);
    $('#tfxApplyFrom', wrap).addEventListener('click', () => {
      const t1 = Number($('#tfxFrom', wrap).value), t2v = $('#tfxTo', wrap).value, t2 = t2v === '' ? null : Number(t2v);
      if (t2 !== null && t2 <= t1) { $('#tfxMsg', wrap).textContent = 'In the quick rule, "to" must be after "from".'; return; }
      st.fx.blocks.forEach(b => {                                        // each block keeps the part of itself inside [from, to)
        const fs = Math.max(b.s, t1), fe = t2 === null ? b.e : Math.min(b.e, t2);
        if (fe > fs) { b.fs = fs; b.fe = fe; } else { b.fs = null; b.fe = null; }
      });
      $('#tfxMsg', wrap).textContent = ''; tfxRender(true);
    });
    $('#tfxAll', wrap).addEventListener('click', () => { st.fx.blocks.forEach(b => { b.fs = b.s; b.fe = b.e; }); tfxRender(true); });
    $('#tfxNone', wrap).addEventListener('click', () => { st.fx.blocks.forEach(b => { b.fs = null; b.fe = null; }); tfxRender(true); });
    $('#tfxSave', wrap).addEventListener('click', tfxSave);
    window.addEventListener('resize', () => { if (!wrap.hidden) { clearTimeout(st.fxFitT); st.fxFitT = setTimeout(() => tfxFit(wrap), 120); } });
    return wrap;
  }
  /* open the popup for one teacher. The blocks are read off the CARD (the bars carry day, start,
     end and role), so the popup shows exactly what the admin was looking at. */
  function openFixed(email, pin) {
    const card = pin && pin.closest ? pin.closest('.tcv2-card')
      : [...document.querySelectorAll('#tBoardContent .tcv2-card')].find(c => String(c.dataset.email || '').toLowerCase() === email);
    if (!card) { toast('Open the By-teacher board first.', 'error'); return; }
    const bars = [...card.querySelectorAll('.tcv2-lane .tcv2-bk[data-day]')];
    if (!bars.length) { toast('Add free hours first — there is nothing to pin yet.', 'error'); return; }
    const blocks = bars.map(bk => {
      const day = Number(bk.dataset.day), s = Number(bk.dataset.s), e = Number(bk.dataset.e);
      const p = tfxPieces(email, day, s, e);
      return { day, s, e, role: String(bk.dataset.role || 'none'), fs: p.length ? p[0][0] : null, fe: p.length ? p[p.length - 1][1] : null };
    }).filter(b => b.e > b.s && b.day >= 0 && b.day <= 6)
      .sort((a, b) => TCV2.ORDER.indexOf(a.day) - TCV2.ORDER.indexOf(b.day) || a.s - b.s || a.e - b.e);
    const info = cardInfo(card);
    const wrap = tfxBuildModal();
    st.fx = { email, blocks, sel: null };
    $('#tfxName', wrap).textContent = info.name || email;
    const av = $('#tfxAv', wrap); av.textContent = info.initials || '?'; av.style.setProperty('--acc', info.acc || '#475569');
    const ax = tfxAxis(blocks);
    $('#tfxFrom', wrap).innerHTML = tfxOptions(ax.a, ax.b - 15, 30, Math.min(Math.max(TFX.START, ax.a), ax.b - 15));
    $('#tfxTo', wrap).innerHTML = '<option value="" selected>end of block</option>' + tfxOptions(ax.a + 30, ax.b, 30, null);
    $('#tfxMsg', wrap).textContent = '';
    $('#tfxSave', wrap).disabled = false;
    wrap.style.setProperty('--acc', info.acc || '#475569');                 // the bands and the ring use the teacher's colour
    wrap.hidden = false;                                                   // SHOW FIRST: tfxFit measures widths, and a hidden box measures 0
    tfxRender(true);
    setTimeout(() => { const first = wrap.querySelector('.tfx-bk'); if (first) first.focus(); }, 30);
  }
  function tfxAxis(blocks) {
    let a = TCV2.AXIS_START, b = TCV2.AXIS_END;
    for (const x of blocks) { if (x.s < a) a = Math.floor(x.s / 60) * 60; if (x.e > b) b = Math.ceil(x.e / 60) * 60; }
    a = Math.max(0, a); b = Math.min(24 * 60, Math.max(b, a + 60));
    return { a, b, x: (m) => Math.max(0, Math.min(100, (m - a) / (b - a) * 100)) };
  }
  function tfxRulerHours(ax) {                                         // the start, every even hour, the end
    const hs = [ax.a];
    for (let m = Math.ceil(ax.a / 120) * 120; m < ax.b; m += 120) if (m - ax.a >= 90 && ax.b - m >= 90) hs.push(m);
    hs.push(ax.b); return hs;
  }
  const tfxMode = (b) => b.fs === null ? 'none' : (b.fs <= b.s && b.fe >= b.e) ? 'whole' : 'part';
  /* <option>s from a to b in steps of `step` minutes, always including b, plus `value` itself when it is off the grid.
     Values are MINUTES, labels are 24-hour "HH:MM" — a browser in Vietnamese shows a type="time" box as "06:00 CH". */
  function tfxOptions(a, b, step, value) {
    const vals = []; for (let m = a; m < b; m += step) vals.push(m); vals.push(b);
    if (value !== null && !vals.includes(value)) { vals.push(value); vals.sort((x, y) => x - y); }
    return vals.map(m => `<option value="${m}"${m === value ? ' selected' : ''}>${tfxFmt(m)}</option>`).join('');
  }
  function tfxSetMode(i, mode) {
    const b = st.fx.blocks[i];
    if (mode === 'none') { b.fs = null; b.fe = null; }
    else if (mode === 'whole') { b.fs = b.s; b.fe = b.e; }
    else if (tfxMode(b) !== 'part') {                                   // part: start at the quick-rule time when it falls inside the block, else at the start
      b.fs = (TFX.START > b.s && TFX.START < b.e) ? TFX.START : b.s;
      b.fe = b.e;
      if (b.fs <= b.s && b.fe >= b.e) b.fs = Math.min(b.s + 60, b.e - 1);  // the whole block would be no "part": shave the first hour
    }
  }
  function tfxToggle(i, byKeyboard) {
    const b = st.fx.blocks[i]; if (!b) return;
    st.fx.sel = i;
    tfxSetMode(i, b.fs === null ? 'whole' : 'none');
    tfxRender(true);
    if (byKeyboard) { const el = st.fxModal.querySelector('.tfx-bk.sel'); if (el) el.focus(); }
  }
  /* the from/to inputs of the selected block. Re-draws the bars only, never the inputs, so typing keeps its focus. */
  function tfxPartInput() {
    const wrap = st.fxModal, fx = st.fx; if (!fx || fx.sel === null) return;
    const b = fx.blocks[fx.sel], ps = $('#tfxPs', wrap), pe = $('#tfxPe', wrap), msg = $('#tfxMsg', wrap);
    const s = Number(ps.value), e = Number(pe.value);
    const bad = isNaN(s) || isNaN(e) || s < b.s || e > b.e || s >= e;
    ps.classList.toggle('bad', bad); pe.classList.toggle('bad', bad);
    if (bad) { msg.textContent = `"from" must be before "to" (inside ${tfxFmt(b.s)}–${tfxFmt(b.e)}).`; return; }
    msg.textContent = ''; b.fs = s; b.fe = e;
    tfxRenderWeek();
    wrap.querySelectorAll('#tfxEd button[data-m]').forEach(x => x.setAttribute('aria-checked', x.dataset.m === tfxMode(b) ? 'true' : 'false'));
    tfxSum();
  }
  function tfxRender(withEditor) { tfxRenderWeek(); if (withEditor) tfxRenderEd(); tfxSum(); }
  function tfxBarHtml(i, k, ax) {
    const b = st.fx.blocks[i], mode = tfxMode(b);
    const left = ax.x(b.s), width = Math.max(0.6, ax.x(b.e) - left), span = b.e - b.s;
    const band = b.fs === null ? '' : `<i class="tfx-band" style="left:${((b.fs - b.s) / span * 100).toFixed(2)}%;width:${((b.fe - b.fs) / span * 100).toFixed(2)}%"><b>${tfxFmt(b.fs)}–${tfxFmt(b.fe)}</b></i>`;
    const tip = `${TCV2.SHORTDAY[b.day]} ${tfxFmt(b.s)}–${tfxFmt(b.e)} · ${TCV2.LABEL[b.role] || b.role}${b.fs !== null ? ` · fixed ${tfxFmt(b.fs)}–${tfxFmt(b.fe)}` : ' · flexible'}`;
    return `<span class="tfx-bk r-${esc(b.role)} ${mode}${st.fx.sel === i ? ' sel' : ''}" data-i="${i}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;top:${k * TFX.LANE}px"`
      + ` tabindex="0" role="button" aria-pressed="${b.fs !== null}" title="${esc(tip)}" aria-label="${esc(tip)}, press Enter to pin or unpin">`
      + `<span class="tfx-bt">${tfxFmt(b.s)}–${tfxFmt(b.e)}</span>${band}</span>`;
  }
  function tfxRenderWeek() {
    const wrap = st.fxModal, fx = st.fx; if (!fx) return;
    const ax = tfxAxis(fx.blocks), hs = tfxRulerHours(ax);
    const rul = `<div class="tfx-rul">${hs.map(m => `<span style="left:${ax.x(m).toFixed(2)}%">${pad(Math.floor(m / 60))}</span>`).join('')}</div>`;
    const vl = `<div class="tfx-vl">${hs.map(m => `<i style="left:${ax.x(m).toFixed(2)}%"></i>`).join('')}</div>`;
    const rows = TCV2.ORDER.filter(d => fx.blocks.some(b => b.day === d)).map(d => {
      const lanes = [], placed = [];
      fx.blocks.forEach((b, i) => {
        if (b.day !== d) return;
        let k = 0;
        while (lanes[k] && lanes[k].some(j => tfxOverlap(fx.blocks[j].s, fx.blocks[j].e, b.s, b.e))) k++;
        (lanes[k] = lanes[k] || []).push(i); placed.push([i, k]);
      });
      return `<div class="tfx-dr" style="--k:${lanes.length}"><span class="tfx-dl">${TCV2.SHORTDAY[d]}</span><div class="tfx-lane">${placed.map(([i, k]) => tfxBarHtml(i, k, ax)).join('')}</div></div>`;
    }).join('');
    $('#tfxWeek', wrap).innerHTML = rul + `<div class="tfx-grid">${vl}${rows}</div>`;
    tfxFit(wrap);
  }
  /* a time that does not fit in its bar is moved beside it; a band too narrow for its text keeps the pin only */
  function tfxFit(wrap) {
    wrap.querySelectorAll('.tfx-bk').forEach(bk => {
      const t = bk.querySelector('.tfx-bt'); if (!t) return;
      bk.classList.remove('out', 'out-l');
      if (bk.clientWidth < t.scrollWidth + 12) { bk.classList.add('out'); if (parseFloat(bk.style.left) > 50) bk.classList.add('out-l'); }
    });
    wrap.querySelectorAll('.tfx-band').forEach(bd => { bd.classList.toggle('nolbl', bd.clientWidth < 74); });
  }
  function tfxRenderEd() {
    const wrap = st.fxModal, fx = st.fx, ed = $('#tfxEd', wrap); if (!fx) return;
    if (fx.sel === null) { ed.innerHTML = '<span class="tfx-edhint"><i class="fa-regular fa-hand-pointer" aria-hidden="true"></i> Click a bar above to pin it, or to fix only part of it.</span>'; return; }
    const b = fx.blocks[fx.sel], mode = tfxMode(b);
    const ps = b.fs === null ? ((TFX.START > b.s && TFX.START < b.e) ? TFX.START : b.s) : b.fs;
    const pe = b.fe === null ? b.e : b.fe;
    ed.innerHTML = `<span class="tfx-edname"><b>${esc(tfxDayName(b.day))}</b> ${tfxFmt(b.s)}–${tfxFmt(b.e)} <span class="tcv2-badge r-${esc(b.role)}">${esc(TCV2.LABEL[b.role] || b.role)}</span></span>`
      + `<span class="tfx-seg" role="radiogroup" aria-label="Fixed">`
      + `<button type="button" role="radio" data-m="none" aria-checked="${mode === 'none'}">Not fixed</button>`
      + `<button type="button" role="radio" data-m="whole" aria-checked="${mode === 'whole'}">Whole block</button>`
      + `<button type="button" role="radio" data-m="part" aria-checked="${mode === 'part'}">Part of it</button></span>`
      + `<span class="tfx-part${mode === 'part' ? '' : ' hidden'}">from <select id="tfxPs" aria-label="Fixed from">${tfxOptions(b.s, b.e - 15, 15, ps)}</select> to <select id="tfxPe" aria-label="Fixed to">${tfxOptions(b.s + 15, b.e, 15, pe)}</select></span>`;
  }
  function tfxSum() {
    const fx = st.fx; if (!fx) return;
    const m = tfxStats(fx.blocks, fx.blocks.filter(b => b.fs !== null).map(b => ({ day: b.day, s: b.fs, e: b.fe })));
    const whole = fx.blocks.filter(b => tfxMode(b) === 'whole').length, part = fx.blocks.filter(b => tfxMode(b) === 'part').length;
    const none = fx.blocks.length - whole - part;
    const el = $('#tfxSum', st.fxModal);
    el.innerHTML = m.fixed
      ? `<b class="tfx-${m.tier}">Fixed ${m.pct}%</b> · ${tfxH(m.fixed)} of ${tfxH(m.free)} · ${m.days} of ${m.workDays} day${m.workDays === 1 ? '' : 's'} · ${whole} whole${part ? `, ${part} partly` : ''}, ${none} flexible`
      : `Nothing fixed · ${tfxH(m.free)} free on ${m.workDays} day${m.workDays === 1 ? '' : 's'}`;
  }
  async function tfxSave() {
    const fx = st.fx, wrap = st.fxModal; if (!fx) return;
    const msg = $('#tfxMsg', wrap), btn = $('#tfxSave', wrap);
    const list = tfxMerge(fx.blocks.filter(b => b.fs !== null && b.fe > b.fs).map(b => ({ day: b.day, s: b.fs, e: b.fe })));
    btn.disabled = true; msg.textContent = '';
    try {
      const j = await api('cal-fixed-ranges-save', { teacherEmail: fx.email, ranges: list.map(r => ({ day: r.day, start: tfxFmt(r.s), end: tfxFmt(r.e) })) });
      st.ranges.set(fx.email, tfxIndex(j.ranges || []).get(fx.email) || []);
      const want = list.length > 0;                                   // keep the old per-teacher flag in step
      if (want !== st.fixed.has(fx.email)) {
        try {
          const f = await api('cal-fixed-hours-set', { teacherEmail: fx.email, fixedHours: want });
          if (f && f.fixedHours) st.fixed.add(fx.email); else st.fixed.delete(fx.email);
        } catch (e) { console.warn('[tc-fixed] the per-teacher flag was not updated:', e.message || e); }
      }
      document.querySelectorAll('#tBoardContent .tcv2-card').forEach(card => {
        if (String(card.dataset.email || '').toLowerCase() === fx.email) pinCard(card, fx.email);
      });
      wrap.hidden = true; st.fx = null;
      toast(list.length ? `Fixed hours saved: ${list.length} range${list.length === 1 ? '' : 's'}.` : 'Fixed hours cleared.', 'ok');
    } catch (err) { msg.textContent = err.message || 'Save failed.'; }
    finally { btn.disabled = false; }
  }
  /* === tansinh fixed-blocks END === */

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
      openFixed(email, pin);                                             // tansinh fixed-blocks: the pin opens the popup
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
        try { client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { reset(); document.querySelectorAll('#tBoardContent .tc-strip, #tBoardContent .tc-pin, #tBoardContent .tc-hbadge, #tBoardContent .tfx-hb, #tBoardContent .tfx-bp').forEach(el => el.remove()); document.querySelectorAll('#tBoardContent .tcv2-bk.tfx').forEach(bk => { bk.classList.remove('tfx', 'tfx-all'); delete bk.dataset.tfx; }); /* tansinh fixed-blocks */ document.querySelectorAll('#tBoardContent .tcv2-card.tc-fixed').forEach(c => c.classList.remove('tc-fixed')); /* tansinh contract4 */ } }); } catch (e) { /* harmless */ }   // tansinh fixed-hours
      } else if (tries > 100) clearInterval(hook);                     // 20 s: give up quietly
    }, 200);
    startTicker();
    decorate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // for the console: tcContract.calc('2026-01-01','2026-12-31'), tcContract.reload()
  window.tcContract = { VERSION: TC.VERSION, calc, reload: () => { st.loaded = false; return load().then(decorate); }, state: st, setFixed: (email, on) => setFixed(String(email || '').toLowerCase(), !!on), openFixed: (email) => openFixed(String(email || '').toLowerCase(), null) };   // tansinh fixed-hours
})();
