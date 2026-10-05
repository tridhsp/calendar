/* teachercalendar-v2.js — 5 Oct 2026
   Teacher calendar v2: free hours carry a ROLE (breakout | ttkb | supporter | mix).

   This file loads AFTER teacher.js and replaces six of its functions simply by
   declaring them again (later classic scripts win):
       openTeacherModal          the add-free-hours modal, week-aware, with roles
       openTeacherEditorByEmail  the pencil on a teacher row -> same modal, prefilled
       saveTeacherSchedule       sends every kept range with its role
       openAvailEditor           the small inline editor gains a role row
       renderTByTeacher          the By teacher view: one row per teacher, 7 strips
       renderTByDay              the By day view: one day on a timeline
   teacher.js itself is NOT edited. Remove this file's <script> tag (and the
   modal body it expects in teachercalendar.html) and the page is the old one.

   Needs: teacher_availability.role (added 5 Oct 2026) and the four patched
   routes (save-teacher-schedule, get-teacher-board, cal-get-teacher-ranges,
   update-teacher-shift). It uses these globals from teacher.js: client,
   teacherLabel, escapeHtml, timeToMinutes, weekdayLong, closeTeacherModal,
   renderTeacherBoard, reassignAfterTeacherScheduleChangeByEmail, tBoardHtml. */

const TCV2 = {
  VERSION: '20261005a',
  ROLES: ['breakout', 'ttkb', 'supporter', 'mix'],
  LABEL: { breakout: 'Breakout', ttkb: 'TTKB', supporter: 'Supporter', mix: 'Mix', none: 'No role' },
  ICON: { breakout: 'fa-table-cells-large', ttkb: 'fa-clipboard-check', supporter: 'fa-life-ring', mix: 'fa-shuffle' },
  HINT: {
    breakout: 'You run the breakout rooms for this shift.',
    ttkb: 'You take the TTKB slot for this shift.',
    supporter: 'You support the main teacher.',
    mix: 'Any role; the admin decides when assigning.'
  },
  AXIS_START: 8 * 60,       // the strips and the timeline run 08:00 -> 22:00
  AXIS_END: 22 * 60,
  PRESETS: [['09:00', '11:00'], ['15:00', '18:00'], ['18:00', '21:00'], ['18:30', '22:00']],
  ORDER: [1, 2, 3, 4, 5, 6, 0],                                   // Mon .. Sun, the board's order
  SHORTDAY: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
};

let tcv2 = {
  email: null, name: '', items: [], sel: null,
  days: new Set(), role: 'breakout',
  day: new Date().getDay(), lastData: null, freeAt: null,
  bound: false, boardBound: false
};

/* ---------- small helpers ---------- */
function tcv2Role(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return TCV2.ROLES.includes(s) ? s : 'none'; }
function tcv2HM(t) { return String(t || '').slice(0, 5); }                                  // "18:00:00" -> "18:00"
function tcv2Fmt(min) { const h = Math.floor(min / 60), m = min % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
function tcv2Short(t) { const [h, m] = tcv2HM(t).split(':'); return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`; }   // "18:30" -> "18:30", "18:00" -> "18"
function tcv2Hours(min) { const h = Math.round(min / 6) / 10; return `${Number.isInteger(h) ? h : h.toFixed(1)} h`; }
function tcv2Pct(min) { const a = TCV2.AXIS_START, b = TCV2.AXIS_END; return Math.max(0, Math.min(100, (min - a) / (b - a) * 100)); }
function tcv2Initials(name) {
  const parts = String(name || '').replace(/@.*$/, '').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function tcv2E(s) { return escapeHtml(String(s == null ? '' : s)); }
function tcv2Today() { return new Date().getDay(); }
function tcv2NowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function tcv2Overlap(aS, aE, bS, bE) { return aS < bE && bS < aE; }

/* booked minutes inside one range, same rule as the old board: every student
   session that starts inside the range counts its status minutes.
   Also returns the booked intervals, clipped to the range, so they can be
   drawn where they really are and used by the "free at" finder. */
function tcv2Used(email, day, startMin, endMin, statusByEmail, schedules) {
  let used = 0; const iv = [];
  for (const sc of schedules) {
    if (sc.teacher_email !== email || sc.day_of_week !== day) continue;
    const sMin = timeToMinutes(tcv2HM(sc.time_local));
    if (sMin >= startMin && sMin < endMin) {
      const len = Number(statusByEmail.get(sc.student_email) || 0);
      used += len;
      if (len > 0) iv.push([sMin, Math.min(endMin, sMin + len)]);
    }
  }
  iv.sort((a, b) => a[0] - b[0]);
  return { used, iv };
}
/* minutes of a range that are NOT booked, inside [a, b) */
function tcv2FreeIn(r, a, b) {
  let s = Math.max(a, r.startMin), e = Math.min(b, r.endMin);
  if (e <= s) return 0;
  let free = e - s;
  for (const [x, y] of r.booked) { const o = Math.min(e, y) - Math.max(s, x); if (o > 0) free -= o; }
  return Math.max(0, free);
}

/* =====================================================================
   THE ADD MODAL
   ===================================================================== */
function openTeacherModal() {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.hidden = false;
  tcv2PrepModal();
  tcv2SessionTeacher().then(({ email, name }) => tcv2LoadTeacher(email, name, true));
}

async function openTeacherEditorByEmail(teacherEmail, teacherName = '') {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.hidden = false;
  tcv2PrepModal();
  const me = await tcv2SessionTeacher();
  await tcv2LoadTeacher(teacherEmail, teacherName || teacherLabel(teacherEmail), me.email === teacherEmail);
}

async function tcv2SessionTeacher() {
  try {
    const { data: { session } } = await client.auth.getSession();
    const email = session?.user?.email || '';
    return { email, name: teacherLabel(email) };
  } catch (e) { return { email: '', name: '' }; }
}

function tcv2PrepModal() {
  if (!document.getElementById('tcv2Bulk')) {
    const wk = document.getElementById('tcv2Week');
    if (wk) { const b = document.createElement('div'); b.id = 'tcv2Bulk'; b.className = 'tcv2-bulk'; wk.parentNode.insertBefore(b, wk.nextSibling); }
  }
  const title = document.getElementById('teacherCalTitle');
  if (title) title.innerHTML = '<i class="fa-solid fa-chalkboard-user"></i> Add free hours';
  tcv2.items = []; tcv2.sel = null; tcv2.days = new Set(); tcv2.role = 'breakout';
  tcv2BuildComposer();
  const chg = document.getElementById('tcv2Change'); if (chg) chg.classList.add('hidden');
  const inp = document.getElementById('teacherNameInput'); if (inp) { inp.value = ''; delete inp.dataset.userRoleUid; delete inp.dataset.userRoleEmail; }
  tcv2SetMsg('');
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
  if (!tcv2.bound) { tcv2BindModal(); tcv2.bound = true; }
}

function tcv2BuildComposer() {
  const days = document.getElementById('tcv2Days');
  if (days) {
    days.innerHTML = TCV2.ORDER.map(d => `<span class="tcv2-dc" data-d="${d}">${TCV2.SHORTDAY[d]}</span>`).join('')
      + `<span class="tcv2-ql"><button type="button" class="tcv2-link" data-q="wd">Weekdays</button><button type="button" class="tcv2-link" data-q="we">Weekend</button><button type="button" class="tcv2-link" data-q="all">Every day</button></span>`;
  }
  const time = document.getElementById('tcv2Time');
  if (time) {
    time.innerHTML = TCV2.PRESETS.map(([s, e], i) => `<span class="tcv2-pc${i === 2 ? ' on' : ''}" data-s="${s}" data-e="${e}">${s}–${e}</span>`).join('')
      + `<input id="tcv2Ts" type="time" step="60" value="18:00"><span class="to">to</span><input id="tcv2Te" type="time" step="60" value="21:00">`;
  }
  const tiles = document.getElementById('tcv2Tiles');
  if (tiles) {
    tiles.innerHTML = TCV2.ROLES.map(r => `<div class="tcv2-tile${r === tcv2.role ? ' r-' + r : ''}" data-r="${r}"><i class="fa-solid ${TCV2.ICON[r]}" aria-hidden="true"></i>${TCV2.LABEL[r]}</div>`).join('');
  }
  const hint = document.getElementById('tcv2Hint'); if (hint) hint.textContent = TCV2.HINT[tcv2.role];
}

async function tcv2LoadTeacher(email, name, isSelf) {
  tcv2.email = (email || '').trim(); tcv2.name = name || tcv2.email; tcv2.items = []; tcv2.sel = null;
  const who = document.getElementById('tcv2Who'); if (who) who.textContent = tcv2.email ? (tcv2.name + (isSelf ? ' · you' : '')) : 'nobody picked yet';
  const av = document.getElementById('tcv2Av'); if (av) av.textContent = tcv2.email ? tcv2Initials(tcv2.name) : '?';
  const pop = document.getElementById('tcv2Pop'); if (pop) pop.classList.add('hidden');
  if (!tcv2.email) { tcv2SetMsg('Could not tell who you are. Use Change teacher to pick one.', 'warn'); tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave(); return; }
  try {
    const res = await fetch(`/api/cal-get-teacher-ranges?teacherEmail=${encodeURIComponent(tcv2.email)}`);
    if (!res.ok) throw new Error('Failed to load saved hours');
    const { ranges } = await res.json();
    tcv2.items = (ranges || []).map(r => ({
      id: r.id || null, day: Number(r.day_of_week), start: tcv2HM(r.time_start), end: tcv2HM(r.time_end),
      role: tcv2Role(r.role), orig: tcv2Role(r.role), saved: true, del: false
    }));
    const noRole = tcv2.items.filter(it => it.role === 'none').length;
    tcv2SetMsg(noRole ? `${noRole} saved range(s) have no role yet. Click a grey block to set one.` : '', 'warn');
  } catch (e) {
    console.error(e);
    tcv2SetMsg('Could not load the saved hours. Check console.', 'err');
  }
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
}

function tcv2RenderWeek() {
  const wrap = document.getElementById('tcv2Week'); if (!wrap) return;
  const today = tcv2Today();
  wrap.innerHTML = TCV2.ORDER.map(d => {
    const chips = tcv2.items
      .map((it, k) => ({ it, k }))
      .filter(x => x.it.day === d)
      .sort((a, b) => timeToMinutes(a.it.start) - timeToMinutes(b.it.start))
      .map(({ it, k }) => `<span class="tcv2-chip r-${it.role}${it.saved ? '' : ' new'}${it.del ? ' del' : ''}${tcv2.sel === k ? ' sel' : ''}" data-k="${k}" title="${tcv2E(TCV2.LABEL[it.role])}${it.saved ? '' : ' · not saved yet'}${it.del ? ' · will be removed' : ''}">${tcv2Short(it.start)}–${tcv2Short(it.end)}</span>`)
      .join('');
    return `<div class="tcv2-col${d === today ? ' today' : ''}" data-d="${d}"><h5>${TCV2.SHORTDAY[d]}</h5>${chips}</div>`;
  }).join('');
  const total = tcv2.items.filter(it => !it.del).reduce((a, it) => a + (timeToMinutes(it.end) - timeToMinutes(it.start)), 0);
  const note = document.getElementById('tcv2WkNote');
  if (note) note.textContent = `${tcv2Hours(total)} this week · solid = saved · dashed = adding now · click a block to change its role or remove it`;
  const bulk = document.getElementById('tcv2Bulk');
  if (bulk) {
    const live = tcv2.items.filter(it => !it.del);
    bulk.innerHTML = live.length ? `<span class="lbl">Set every range to</span>${TCV2.ROLES.map(r => `<button type="button" data-bulk="${r}" class="r-${r}">${TCV2.LABEL[r]}</button>`).join('')}` : '';
  }
}

function tcv2RenderPop() {
  const pop = document.getElementById('tcv2Pop'); if (!pop) return;
  const it = tcv2.sel == null ? null : tcv2.items[tcv2.sel];
  if (!it) { pop.classList.add('hidden'); pop.innerHTML = ''; return; }
  pop.classList.remove('hidden');
  pop.innerHTML = `<b>${weekdayLong(it.day)} ${tcv2HM(it.start)}–${tcv2HM(it.end)}</b>`
    + `<span class="tcv2-roleset">${TCV2.ROLES.map(r => `<button type="button" data-pr="${r}" class="${it.role === r ? 'on r-' + r : ''}">${TCV2.LABEL[r]}</button>`).join('')}</span>`
    + `<span class="spacer"></span>`
    + (it.saved
      ? `<button type="button" class="tcv2-link" data-pa="toggle">${it.del ? 'Keep it' : 'Remove'}</button>`
      : `<button type="button" class="tcv2-link" data-pa="drop">Remove</button>`)
    + `<button type="button" class="tcv2-link" data-pa="done">Done</button>`;
}

function tcv2SetMsg(text, kind) {
  const el = document.getElementById('tcv2Msg'); if (!el) return;
  el.textContent = text || '';
  el.className = 'tcv2-msg' + (kind === 'warn' ? ' warn' : kind === 'ok' ? ' ok' : '');
}

function tcv2Composer() {
  const ts = document.getElementById('tcv2Ts'), te = document.getElementById('tcv2Te');
  const a = timeToMinutes(ts?.value || '0:0'), b = timeToMinutes(te?.value || '0:0');
  return { start: ts?.value || '', end: te?.value || '', a, b, days: [...tcv2.days].sort((x, y) => TCV2.ORDER.indexOf(x) - TCV2.ORDER.indexOf(y)) };
}

function tcv2Clashes(days, a, b) {
  const hit = [];
  for (const d of days) {
    const clash = tcv2.items.some(it => it.day === d && !it.del && tcv2Overlap(a, b, timeToMinutes(it.start), timeToMinutes(it.end)));
    if (clash) hit.push(weekdayLong(d));
  }
  return hit;
}

function tcv2UpdateSum() {
  const el = document.getElementById('tcv2Sum'); if (!el) return;
  const c = tcv2Composer();
  const h = Math.max(0, c.b - c.a);
  const daysTxt = c.days.length ? c.days.map(d => TCV2.SHORTDAY[d]).join(', ') : 'No day picked';
  el.textContent = `${daysTxt} · ${c.start || '--:--'}–${c.end || '--:--'} · ${TCV2.LABEL[tcv2.role]} · ${tcv2Hours(h * c.days.length)}`;
  const clash = c.days.length && c.b > c.a ? tcv2Clashes(c.days, c.a, c.b) : [];
  if (clash.length) tcv2SetMsg(`Overlaps what is already there on ${clash.join(', ')}.`, 'warn');
}

function tcv2UpdateSave() {
  const btn = document.getElementById('teacherCalSaveBtn'); if (!btn) return;
  const fresh = tcv2.items.filter(it => !it.saved && !it.del).length;
  const gone = tcv2.items.filter(it => it.saved && it.del).length;
  const changed = tcv2.items.filter(it => it.saved && !it.del && it.role !== it.orig).length;
  btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save' + (fresh ? ` · ${fresh} new` : '') + (changed ? ` · ${changed} changed` : '') + (gone ? ` · ${gone} removed` : '');
}

function tcv2AddToWeek() {
  const c = tcv2Composer();
  if (!c.days.length) { tcv2SetMsg('Pick at least one day first.', 'err'); return; }
  if (!c.start || !c.end) { tcv2SetMsg('Set both a start and an end time.', 'err'); return; }
  if (c.b <= c.a) { tcv2SetMsg('End time must be after start time.', 'err'); return; }
  const clash = tcv2Clashes(c.days, c.a, c.b);
  if (clash.length) { tcv2SetMsg(`${clash.join(', ')} already ${clash.length === 1 ? 'has' : 'have'} hours in that time. Unselect ${clash.length === 1 ? 'it' : 'them'} or change the time.`, 'err'); return; }
  for (const d of c.days) tcv2.items.push({ id: null, day: d, start: tcv2HM(c.start), end: tcv2HM(c.end), role: tcv2.role, saved: false, del: false });
  tcv2.days = new Set();
  document.querySelectorAll('#tcv2Days .tcv2-dc').forEach(x => x.classList.remove('on'));
  tcv2.sel = null; tcv2RenderPop();
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
  tcv2SetMsg(`Added ${c.days.length} range(s). They are kept once you press Save.`, 'ok');
}

function tcv2BindModal() {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.addEventListener('click', (e) => {
    const dc = e.target.closest('.tcv2-dc');
    if (dc) { const d = Number(dc.dataset.d); if (tcv2.days.has(d)) tcv2.days.delete(d); else tcv2.days.add(d); dc.classList.toggle('on', tcv2.days.has(d)); tcv2SetMsg(''); tcv2UpdateSum(); return; }
    const ql = e.target.closest('.tcv2-ql [data-q]');
    if (ql) {
      const q = ql.dataset.q; tcv2.days = new Set();
      TCV2.ORDER.forEach((d, i) => { if (q === 'all' || (q === 'wd' && i < 5) || (q === 'we' && i >= 5)) tcv2.days.add(d); });
      document.querySelectorAll('#tcv2Days .tcv2-dc').forEach(x => x.classList.toggle('on', tcv2.days.has(Number(x.dataset.d))));
      tcv2SetMsg(''); tcv2UpdateSum(); return;
    }
    const pc = e.target.closest('.tcv2-pc');
    if (pc) {
      document.querySelectorAll('#tcv2Time .tcv2-pc').forEach(x => x.classList.remove('on')); pc.classList.add('on');
      const ts = document.getElementById('tcv2Ts'), te = document.getElementById('tcv2Te');
      if (ts) ts.value = pc.dataset.s; if (te) te.value = pc.dataset.e;
      tcv2SetMsg(''); tcv2UpdateSum(); return;
    }
    const tile = e.target.closest('.tcv2-tile');
    if (tile) {
      tcv2.role = tcv2Role(tile.dataset.r);
      document.querySelectorAll('#tcv2Tiles .tcv2-tile').forEach(x => { x.className = 'tcv2-tile' + (x.dataset.r === tcv2.role ? ' r-' + tcv2.role : ''); });
      const hint = document.getElementById('tcv2Hint'); if (hint) hint.textContent = TCV2.HINT[tcv2.role];
      tcv2UpdateSum(); return;
    }
    if (e.target.closest('#tcv2AddBtn')) { tcv2AddToWeek(); return; }
    if (e.target.closest('#tcv2ChangeBtn')) {
      const chg = document.getElementById('tcv2Change'); if (chg) { chg.classList.toggle('hidden'); if (!chg.classList.contains('hidden')) document.getElementById('teacherNameInput')?.focus(); }
      return;
    }
    const sug = e.target.closest('#teacherNameSuggestions button.suggestion');
    if (sug) { tcv2LoadTeacher(sug.dataset.email, sug.dataset.name || sug.dataset.email, false); return; }
    const bulk = e.target.closest('#tcv2Bulk [data-bulk]');
    if (bulk) {
      const r = tcv2Role(bulk.dataset.bulk);
      tcv2.items.forEach(it => { if (!it.del) it.role = r; });
      tcv2RenderWeek(); tcv2RenderPop(); tcv2UpdateSave();
      tcv2SetMsg(`Every range is now ${TCV2.LABEL[r]}. Press Save to keep it.`, 'ok'); return;
    }
    const chip = e.target.closest('.tcv2-chip');
    if (chip) { const k = Number(chip.dataset.k); tcv2.sel = (tcv2.sel === k ? null : k); tcv2RenderWeek(); tcv2RenderPop(); return; }
    const pr = e.target.closest('#tcv2Pop [data-pr]');
    if (pr && tcv2.sel != null) { tcv2.items[tcv2.sel].role = tcv2Role(pr.dataset.pr); tcv2RenderWeek(); tcv2RenderPop(); tcv2UpdateSave(); return; }
    const pa = e.target.closest('#tcv2Pop [data-pa]');
    if (pa && tcv2.sel != null) {
      const it = tcv2.items[tcv2.sel];
      if (pa.dataset.pa === 'toggle') { it.del = !it.del; }
      else if (pa.dataset.pa === 'drop') { tcv2.items.splice(tcv2.sel, 1); tcv2.sel = null; }
      else { tcv2.sel = null; }
      tcv2RenderWeek(); tcv2RenderPop(); tcv2UpdateSum(); tcv2UpdateSave(); return;
    }
  });
  m.addEventListener('input', (e) => {
    if (e.target.id === 'tcv2Ts' || e.target.id === 'tcv2Te') {
      document.querySelectorAll('#tcv2Time .tcv2-pc').forEach(x => x.classList.remove('on'));
      tcv2SetMsg(''); tcv2UpdateSum();
    }
  });
}

async function saveTeacherSchedule() {
  const teacherEmail = (tcv2.email || '').trim();
  if (!teacherEmail) { alert('Pick a teacher first: press Change teacher and choose one from the suggestions.'); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  const kept = tcv2.items.filter(it => !it.del);
  if (!kept.length) { alert('Nothing would be left to save. To delete every free hour of a teacher, use the trash button on the board instead.'); return; }
  const noRole = kept.filter(it => it.role === 'none').length;
  if (noRole && !confirm(`${noRole} range(s) still have no role. Save anyway?`)) return;
  const rows = kept.map(it => ({ day_of_week: it.day, time_start: it.start, time_end: it.end, timezone: tz, role: it.role === 'none' ? null : it.role }));
  const btn = document.getElementById('teacherCalSaveBtn'); if (btn) btn.disabled = true;
  try {
    const { data: { session } } = await client.auth.getSession();
    const userToken = session?.access_token || null;
    const res = await fetch('/api/save-teacher-schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teacherEmail, rows, userToken })
    });
    if (!res.ok) throw new Error(await res.text());
    const { inserted } = await res.json();
    const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(teacherEmail);
    alert(`Saved ${inserted} free-hour range(s) for ${tcv2.name}.\nReassigned ${changed} session(s)` + (unmapped ? `; ${unmapped} had no available teacher` : ''));
    closeTeacherModal();
    renderTeacherBoard(true);
  } catch (e) {
    console.error(e);
    alert('Save failed. Check console.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =====================================================================
   BY TEACHER: one row per teacher, seven strips
   ===================================================================== */
function tcv2Prep({ teachers, ranges, statuses, schedules }) {
  const statusByEmail = new Map((statuses || []).map(s => [s.email, Number(s.status || 0)]));
  const scheds = schedules || [];
  const byTeacher = new Map();
  for (const t of (teachers || [])) byTeacher.set(t.name, { email: t.name, ranges: [] });
  for (const r of (ranges || [])) {
    let t = byTeacher.get(r.teacher_email);
    if (!t) { t = { email: r.teacher_email || 'unknown', ranges: [] }; byTeacher.set(t.email, t); }
    const startMin = timeToMinutes(tcv2HM(r.time_start)), endMin = timeToMinutes(tcv2HM(r.time_end));
    const u = tcv2Used(t.email, Number(r.day_of_week), startMin, endMin, statusByEmail, scheds);
    t.ranges.push({
      id: r.id, day: Number(r.day_of_week), start: tcv2HM(r.time_start), end: tcv2HM(r.time_end),
      startMin, endMin, total: Math.max(0, endMin - startMin), role: tcv2Role(r.role),
      used: u.used, booked: u.iv
    });
  }
  const list = [...byTeacher.values()].map(t => {
    t.name = teacherLabel(t.email);
    t.free = t.ranges.reduce((a, r) => a + r.total, 0);
    t.booked = t.ranges.reduce((a, r) => a + Math.min(r.used, r.total), 0);
    t.byRole = {};
    for (const r of t.ranges) t.byRole[r.role] = (t.byRole[r.role] || 0) + r.total;
    return t;
  });
  list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return list;
}

function tcv2Block(r, extra) {
  const a = Math.max(r.startMin, TCV2.AXIS_START), b = Math.min(r.endMin, TCV2.AXIS_END);
  if (b <= a) return '';
  const left = tcv2Pct(a), width = Math.max(1.2, tcv2Pct(b) - left);
  const pct = r.total ? Math.max(0, Math.min(100, Math.round(r.used / r.total * 100))) : 0;
  const cut = r.startMin < TCV2.AXIS_START || r.endMin > TCV2.AXIS_END ? ' cut' : '';
  const span = b - a;
  const stripes = r.booked.map(([x, y]) => {
    const xs = Math.max(a, x), ye = Math.min(b, y); if (ye <= xs) return '';
    return `<i class="tcv2-fl" style="left:${((xs - a) / span * 100).toFixed(2)}%;width:${((ye - xs) / span * 100).toFixed(2)}%" title="booked ${tcv2Fmt(xs)}–${tcv2Fmt(ye)}"></i>`;
  }).join('');
  const bk = r.booked.map(([x, y]) => `${x}-${y}`).join(',');
  return `<span class="tcv2-bk r-${r.role}${cut}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"`
    + ` data-avail-id="${tcv2E(r.id)}" data-day="${r.day}" data-start="${r.start}" data-end="${r.end}" data-role="${r.role}" data-teacher-email="${tcv2E(extra.email)}" data-s="${r.startMin}" data-e="${r.endMin}" data-b="${bk}"`
    + ` title="${TCV2.SHORTDAY[r.day]} ${r.start}–${r.end} · ${TCV2.LABEL[r.role]} · ${r.used} / ${r.total} min booked (${pct}%)${r.booked.length ? ' · booked ' + r.booked.map(([x, y]) => tcv2Fmt(x) + '–' + tcv2Fmt(y)).join(', ') : ''}">`
    + `${stripes}${extra.text ? `<span>${extra.text}</span>` : ''}</span>`;
}

function renderTByTeacher(data) {
  tcv2.freeAt = null;
  const list = tcv2Prep(data);
  if (!list.length) return '<div class="tcv2-empty">No free hours saved yet. Press the calendar button at the bottom left to add some.</div>';
  const today = tcv2Today(), nowMin = tcv2NowMin();
  const nowPct = nowMin >= TCV2.AXIS_START && nowMin <= TCV2.AXIS_END ? tcv2Pct(nowMin) : -10;
  const anyNone = list.some(t => t.byRole.none);
  const totalFree = list.reduce((a, t) => a + t.free, 0), totalBooked = list.reduce((a, t) => a + t.booked, 0);

  const rows = list.map(t => {
    const badges = [...TCV2.ROLES, 'none'].filter(r => t.byRole[r]).map(r => `<span class="tcv2-badge r-${r}"><span class="tcv2-dot r-${r}"></span>${TCV2.LABEL[r]} ${tcv2Hours(t.byRole[r])}</span>`).join('');
    const cells = TCV2.ORDER.map(d => {
      const rs = t.ranges.filter(r => r.day === d).sort((x, y) => x.startMin - y.startMin);
      const blocks = rs.map(r => tcv2Block(r, { email: t.email })).join('');
      const cap = rs.map(r => `${tcv2Short(r.start)}–${tcv2Short(r.end)}`).join(', ');
      const isToday = d === today;
      return `<div><div class="tcv2-tr${isToday ? ' today' : ''}" data-day="${d}"${isToday ? ` style="--now:${nowPct.toFixed(2)}%"` : ''}>${blocks}</div><p class="tcv2-cp">${cap}</p></div>`;
    }).join('');
    const roles = Object.keys(t.byRole).join(' ');
    return `<div class="tcv2-row" data-email="${tcv2E(t.email)}" data-n="${tcv2E(t.name.toLowerCase())}" data-r="${roles}" data-free="${t.free}" data-book="${t.booked}">`
      + `<div class="tcv2-rowhead"><span class="tcv2-av">${tcv2E(tcv2Initials(t.name))}</span><span class="tcv2-name">${tcv2E(t.name)}</span>${badges}`
      + `<span class="tcv2-tot">${tcv2Hours(t.free)} free · ${tcv2Hours(t.booked)} booked</span></div>`
      + `<div class="tcv2-acts">`
      + `<button class="card-action t-edit" title="Edit this teacher's free hours" data-teacher-email="${tcv2E(t.email)}" data-teacher-name="${tcv2E(t.name)}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>`
      + `<button class="card-action t-del" title="Delete this teacher and all free hours" data-teacher-email="${tcv2E(t.email)}" data-teacher-name="${tcv2E(t.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`
      + `</div><div class="tcv2-g7">${cells}</div></div>`;
  }).join('');

  const flt = ['all', ...TCV2.ROLES, ...(anyNone ? ['none'] : [])].map(r =>
    `<span class="tcv2-tb-flt${r === 'all' ? ' on' : ''}" data-r="${r}">${r === 'all' ? '' : `<span class="tcv2-dot r-${r}"></span>`}${r === 'all' ? 'All' : TCV2.LABEL[r]}</span>`).join('');
  const dh = TCV2.ORDER.map(d => `<div class="tcv2-dh${d === today ? ' today' : ''}">${TCV2.SHORTDAY[d]}${d === today ? ' · today' : ''}</div>`).join('');
  const hrs = [8, 10, 12, 14, 16, 18, 20, 22];
  const ax = TCV2.ORDER.map(() => `<div class="tcv2-ax">${hrs.map((h, i) => `<span class="${i % 2 ? 'odd' : ''}" style="left:${tcv2Pct(h * 60).toFixed(2)}%">${String(h).padStart(2, '0')}</span>`).join('')}</div>`).join('');
  const faDay = TCV2.ORDER.map(d => `<option value="${d}"${d === today ? ' selected' : ''}>${TCV2.SHORTDAY[d]}</option>`).join('');
  const faTime = tcv2Fmt(Math.min(TCV2.AXIS_END - 60, Math.max(TCV2.AXIS_START, Math.ceil(nowMin / 60) * 60)));

  return `<div class="tcv2-view">`
    + `<div class="tcv2-tb"><input type="search" class="tcv2-q" placeholder="Find a teacher">${flt}`
    + `<span class="count" id="tcv2Count">${list.length} teachers · ${tcv2Hours(totalFree)} free · ${tcv2Hours(totalBooked)} booked</span>`
    + `<button type="button" class="tcv2-sort" data-mode="0"><i class="fa-solid fa-arrow-down-a-z" aria-hidden="true"></i> Sort: name</button></div>`
    + `<div class="tcv2-tb tcv2-fa"><span class="lbl">Who is free at</span><select class="tcv2-fa-day">${faDay}</select><input type="time" class="tcv2-fa-time" step="900" value="${faTime}">`
    + `<button type="button" class="tcv2-fa-go"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Show</button><button type="button" class="tcv2-fa-clear">Show everyone</button><span class="count tcv2-fa-out"></span></div>`
    + `<p class="tcv2-legend">Solid colour = free. Striped = a student is already booked there. Blue line = now. Hover a block for the minutes, click it to edit.</p>`
    + `<div class="tcv2-head"><div class="tcv2-g7">${dh}</div><div class="tcv2-g7">${ax}</div></div>`
    + `<div class="tcv2-rows">${rows}</div></div>`;
}

/* =====================================================================
   BY DAY: one day on a timeline
   ===================================================================== */
function renderTByDay(data) {
  tcv2.lastData = data;
  const list = tcv2Prep(data);
  const d = tcv2.day, today = tcv2Today(), nowMin = tcv2NowMin();
  const tabs = TCV2.ORDER.map(x => `<span class="tcv2-daytab${x === d ? ' on' : ''}" data-d="${x}">${TCV2.SHORTDAY[x]}${x === today ? '<small>today</small>' : ''}</span>`).join('');
  const people = list.map(t => ({ t, rs: t.ranges.filter(r => r.day === d).sort((a, b) => a.startMin - b.startMin) }))
    .filter(x => x.rs.length)
    .sort((a, b) => a.rs[0].startMin - b.rs[0].startMin || a.t.name.localeCompare(b.t.name, 'vi'));
  const free = people.reduce((a, x) => a + x.rs.reduce((s, r) => s + r.total, 0), 0);
  const booked = people.reduce((a, x) => a + x.rs.reduce((s, r) => s + Math.min(r.used, r.total), 0), 0);

  const hours = []; for (let h = 8; h <= 22; h++) hours.push(h);
  const hx = hours.map(h => `<span style="left:${tcv2Pct(h * 60).toFixed(2)}%">${String(h).padStart(2, '0')}</span>`).join('');
  const gl = hours.map(h => `<i style="left:${tcv2Pct(h * 60).toFixed(2)}%"></i>`).join('')
    + (d === today && nowMin >= TCV2.AXIS_START && nowMin <= TCV2.AXIS_END ? `<i class="now" style="left:${tcv2Pct(nowMin).toFixed(2)}%"></i>` : '');

  const lines = people.map(({ t, rs }) => {
    const blocks = rs.map(r => tcv2Block(r, { email: t.email, text: `${tcv2Short(r.start)}–${tcv2Short(r.end)} · ${TCV2.LABEL[r.role]}` })).join('');
    const sub = `${tcv2Hours(rs.reduce((s, r) => s + r.total, 0))} free`;
    return `<div class="tcv2-ln item"><span class="tcv2-nm">${tcv2E(t.name)}<small>${sub}</small></span><div class="tcv2-trk">${blocks}</div></div>`;
  }).join('');

  const heat = [];
  for (let h = 8; h < 22; h++) {
    const n = people.filter(x => x.rs.some(r => tcv2FreeIn(r, h * 60, h * 60 + 60) > 0)).length;
    heat.push(`<span class="${n >= 3 ? 'b' : n ? 'a' : ''}" title="${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00: ${n} teacher(s) with free minutes">${n}</span>`);
  }

  return `<div class="tcv2-view">`
    + `<div class="tcv2-daytabs">${tabs}</div>`
    + `<div class="tcv2-dayhead"><b>${weekdayLong(d)}</b><span>${people.length} teacher${people.length === 1 ? '' : 's'} free · ${tcv2Hours(free)} free · ${tcv2Hours(booked)} booked</span>`
    + `<span style="margin-left:auto">${d === today ? 'blue line = now · ' : ''}solid = free, striped = booked · click a block to edit</span></div>`
    + (people.length
      ? `<div class="tcv2-tl"><div class="tcv2-ln hdr"><span></span><div class="tcv2-hx">${hx}</div></div>`
        + `<div class="tcv2-body"><div class="tcv2-gl">${gl}</div>${lines}</div>`
        + `<div class="tcv2-ln" style="margin-top:12px"><span class="tcv2-nm" style="font-weight:600;color:#64748b;font-size:12px">Free per hour</span><div class="tcv2-heat">${heat.join('')}</div></div></div>`
      : `<div class="tcv2-empty">Nobody has free hours on ${weekdayLong(d)} yet.</div>`)
    + `</div>`;
}

/* =====================================================================
   BOARD INTERACTIONS: filter, search, sort, day tabs, block click
   ===================================================================== */
/* is this block free at minute m? (inside the range and not inside a booked patch) */
function tcv2BlockFreeAt(bk, m) {
  if (m < Number(bk.dataset.s) || m >= Number(bk.dataset.e)) return false;
  const b = bk.dataset.b ? bk.dataset.b.split(',') : [];
  return !b.some(p => { const [x, y] = p.split('-').map(Number); return m >= x && m < y; });
}

function tcv2ApplyFilter(root) {
  const q = (root.querySelector('.tcv2-q')?.value || '').trim().toLowerCase();
  const role = root.querySelector('.tcv2-tb-flt.on')?.dataset.r || 'all';
  const fa = tcv2.freeAt;   // null, or { day, min }
  let n = 0, free = 0, booked = 0;
  root.querySelectorAll('.tcv2-bk.hit').forEach(x => x.classList.remove('hit'));
  root.querySelectorAll('.tcv2-tr.at').forEach(x => { x.classList.remove('at'); x.style.removeProperty('--at'); });
  root.querySelectorAll('.tcv2-row').forEach(row => {
    let ok = (role === 'all' || (' ' + row.dataset.r + ' ').includes(' ' + role + ' ')) && (!q || row.dataset.n.includes(q));
    if (ok && fa) {
      const hits = [...row.querySelectorAll(`.tcv2-bk[data-day="${fa.day}"]`)].filter(bk => tcv2BlockFreeAt(bk, fa.min));
      ok = hits.length > 0;
      hits.forEach(bk => bk.classList.add('hit'));
    }
    if (fa) row.querySelectorAll(`.tcv2-tr[data-day="${fa.day}"]`).forEach(tr => { tr.classList.add('at'); tr.style.setProperty('--at', tcv2Pct(fa.min).toFixed(2) + '%'); });
    row.classList.toggle('hide', !ok);
    if (ok) { n++; free += Number(row.dataset.free); booked += Number(row.dataset.book); }
  });
  const c = root.querySelector('#tcv2Count'); if (c) c.textContent = `${n} teacher${n === 1 ? '' : 's'} · ${tcv2Hours(free)} free · ${tcv2Hours(booked)} booked`;
  const out = root.querySelector('.tcv2-fa-out');
  if (out) out.textContent = fa ? `${n} teacher${n === 1 ? '' : 's'} free ${TCV2.SHORTDAY[fa.day]} ${tcv2Fmt(fa.min)}` : '';
}

function tcv2BindBoard() {
  const c = document.getElementById('tBoardContent'); if (!c || tcv2.boardBound) return;
  tcv2.boardBound = true;
  c.addEventListener('click', (e) => {
    const bk = e.target.closest('.tcv2-bk[data-avail-id]');
    if (bk) { openAvailEditor(bk); return; }
    const f = e.target.closest('.tcv2-tb-flt');
    if (f) { c.querySelectorAll('.tcv2-tb-flt').forEach(x => x.classList.remove('on')); f.classList.add('on'); tcv2ApplyFilter(c); return; }
    if (e.target.closest('.tcv2-fa-go')) {
      const day = Number(c.querySelector('.tcv2-fa-day')?.value), t = c.querySelector('.tcv2-fa-time')?.value;
      if (!t) return;
      tcv2.freeAt = { day, min: timeToMinutes(t) };
      tcv2ApplyFilter(c); return;
    }
    if (e.target.closest('.tcv2-fa-clear')) { tcv2.freeAt = null; tcv2ApplyFilter(c); return; }
    const s = e.target.closest('.tcv2-sort');
    if (s) {
      const mode = (Number(s.dataset.mode || 0) + 1) % 3; s.dataset.mode = mode;
      const labels = ['Sort: name', 'Sort: most free', 'Sort: most booked'];
      const icons = ['fa-arrow-down-a-z', 'fa-arrow-down-wide-short', 'fa-arrow-down-wide-short'];
      s.innerHTML = `<i class="fa-solid ${icons[mode]}" aria-hidden="true"></i> ${labels[mode]}`;
      const wrap = c.querySelector('.tcv2-rows'); if (!wrap) return;
      const rows = [...wrap.querySelectorAll('.tcv2-row')];
      rows.sort((a, b) => mode === 0 ? a.dataset.n.localeCompare(b.dataset.n, 'vi')
        : mode === 1 ? Number(b.dataset.free) - Number(a.dataset.free)
          : Number(b.dataset.book) - Number(a.dataset.book));
      rows.forEach(r => wrap.appendChild(r));
      return;
    }
    const tab = e.target.closest('.tcv2-daytab');
    if (tab && tcv2.lastData) {
      tcv2.day = Number(tab.dataset.d);
      const html = renderTByDay(tcv2.lastData);
      c.innerHTML = html;
      try { tBoardHtml.day = html; } catch (err) { /* cache in teacher.js not reachable, harmless */ }
      return;
    }
  });
  c.addEventListener('input', (e) => { if (e.target.classList.contains('tcv2-q')) tcv2ApplyFilter(c); });
}

/* =====================================================================
   INLINE EDITOR: start, end, role, delete
   ===================================================================== */
function openAvailEditor(anchorEl) {
  document.getElementById('availEditCard')?.remove();
  const rect = anchorEl.getBoundingClientRect();
  const card = document.createElement('div');
  card.id = 'availEditCard';
  card.className = 'avail-editor tcv2-ae';
  card.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 240))}px`;
  card.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 360))}px`;

  const availId = anchorEl.dataset.availId;
  const start = tcv2HM(anchorEl.dataset.start || '08:00');
  const end = tcv2HM(anchorEl.dataset.end || '12:00');
  let role = tcv2Role(anchorEl.dataset.role);

  card.innerHTML = `
    <div class="ae-row"><label>Start</label><input id="aeStart" type="time" step="60" value="${start}"></div>
    <div class="ae-row"><label>End</label><input id="aeEnd" type="time" step="60" value="${end}"></div>
    <div class="ae-row"><label>Role</label><div class="tcv2-roleset" id="aeRoles">${TCV2.ROLES.map(r => `<button type="button" data-r="${r}" class="${r === role ? 'on r-' + r : ''}">${TCV2.LABEL[r]}</button>`).join('')}</div></div>
    <div class="ae-actions">
      <button id="aeDelete" class="btn-sm danger" type="button">Delete</button>
      <div class="spacer"></div>
      <button id="aeCancel" class="btn-sm" type="button">Cancel</button>
      <button id="aeSave" class="btn-sm primary" type="button">Save</button>
    </div>`;
  document.body.appendChild(card);

  const close = () => { document.removeEventListener('click', onDoc, { capture: true }); document.removeEventListener('keydown', onKey); card.remove(); };
  const onDoc = (ev) => { if (!card.contains(ev.target) && ev.target !== anchorEl) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => document.addEventListener('click', onDoc, { capture: true }), 0);
  document.addEventListener('keydown', onKey);

  card.querySelector('#aeRoles').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-r]'); if (!b) return;
    role = tcv2Role(b.dataset.r);
    card.querySelectorAll('#aeRoles button').forEach(x => { x.className = x.dataset.r === role ? 'on r-' + role : ''; });
  });
  card.querySelector('#aeCancel').addEventListener('click', close);

  card.querySelector('#aeSave').addEventListener('click', async () => {
    const newStart = card.querySelector('#aeStart').value, newEnd = card.querySelector('#aeEnd').value;
    if (!newStart || !newEnd) { alert('Please set both start and end.'); return; }
    if (timeToMinutes(newStart) >= timeToMinutes(newEnd)) { alert('End time must be after start time.'); return; }
    try {
      const res = await fetch('/api/update-teacher-shift', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', availId, timeStart: newStart, timeEnd: newEnd, role: role === 'none' ? null : role })
      });
      if (!res.ok) throw new Error(await res.text());
      const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(anchorEl.dataset.teacherEmail);
      alert(`Shift updated.\nReassigned ${changed} session(s)` + (unmapped ? `; ${unmapped} had no available teacher` : ''));
      close(); renderTeacherBoard(true);
    } catch (e) { console.error(e); alert('Update failed. Check console.'); }
  });

  card.querySelector('#aeDelete').addEventListener('click', async () => {
    if (!confirm('Delete this free-hour range?')) return;
    try {
      const res = await fetch('/api/update-teacher-shift', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', availId })
      });
      if (!res.ok) throw new Error(await res.text());
      const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(anchorEl.dataset.teacherEmail);
      alert(`Shift deleted.\nReassigned ${changed} session(s)` + (unmapped ? `; ${unmapped} had no available teacher` : ''));
      close(); renderTeacherBoard(true);
    } catch (e) { console.error(e); alert('Delete failed. Check console.'); }
  });
}

/* ---------- boot: runs after teacher.js's own DOMContentLoaded handler ---------- */
document.addEventListener('DOMContentLoaded', () => { tcv2BindBoard(); });
