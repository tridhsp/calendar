/* teachercalendar-v2.js — 5 Oct 2026
   Teacher calendar v2: free hours carry a ROLE (breakout | ttkb | supporter | mix).

   This file loads AFTER teacher.js and replaces six of its functions simply by
   declaring them again (later classic scripts win):
       openTeacherModal          the add-free-hours modal, week-aware, with roles
       openTeacherEditorByEmail  the pencil on a teacher row -> same modal, prefilled
       saveTeacherSchedule       sends every kept range with its role
       openAvailEditor           the small inline editor gains a role row
       renderTByTeacher          the By teacher view: one CARD per teacher, a row per working day (cards, 6 Oct 2026)
       renderTByDay              the By day view: one day on a timeline
   teacher.js itself is NOT edited. Remove this file's <script> tag (and the
   modal body it expects in teachercalendar.html) and the page is the old one.

   Needs: teacher_availability.role (added 5 Oct 2026) and the four patched
   routes (save-teacher-schedule, get-teacher-board, cal-get-teacher-ranges,
   update-teacher-shift). It uses these globals from teacher.js: client,
   teacherLabel, escapeHtml, timeToMinutes, weekdayLong, closeTeacherModal,
   renderTeacherBoard, reassignAfterTeacherScheduleChangeByEmail, tBoardHtml. */

const TCV2 = {
  VERSION: '20261006_wizard1',
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
/* tcv2 cards (6 Oct 2026): today and now are VIETNAM time (UTC+7, no daylight saving), whatever the
   browser's zone. Teachers' hours are stored in Vietnam time, so the blue line and the "today" row must be too. */
function tcv2VnNow() { const d = new Date(Date.now() + 7 * 3600 * 1000); return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
function tcv2Today() { return tcv2VnNow().day; }
function tcv2NowMin() { return tcv2VnNow().min; }
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
/* === tcv2 pick BEGIN (8 Oct 2026) ===
   Who may add free hours for ANOTHER teacher: only the roles in TCV2_PICK.ROLES (user_roles.role).
   Everyone else edits their own week only: "Change teacher" is hidden, and a pencil on someone
   else's card opens their own week with a note. THIS IS THE PAGE ONLY. The real lock belongs in
   /api/save-teacher-schedule. To let every role pick, add 'teacher' to ROLES. */
const TCV2_PICK = { ROLES: ['admin', 'super admin'] };     // lower case, compared trimmed + lower-cased
let tcv2Me = null;                                         // { email, name, role, canPick } for the signed-in email

async function tcv2WhoAmI() {
  const s = await tcv2SessionTeacher();
  if (tcv2Me && tcv2Me.email === s.email) return tcv2Me;
  let role = '';
  try {
    const { data: { session } } = await client.auth.getSession();
    const uid = session?.user?.id;
    if (uid) {
      const { data: ur, error } = await client.from('user_roles').select('role').eq('uid', uid).maybeSingle();
      if (error) throw error;
      role = String(ur?.role || '').trim();
    }
  } catch (e) {
    console.warn('[tcv2 pick] could not read your role; Change teacher stays hidden this time', e);
    return { email: s.email, name: s.name, role: '', canPick: false };   // not cached: the next open asks again
  }
  tcv2Me = { email: s.email, name: s.name, role, canPick: TCV2_PICK.ROLES.includes(role.toLowerCase()) };
  return tcv2Me;
}

function tcv2ApplyPick(canPick) {
  const btn = document.getElementById('tcv2ChangeBtn'); if (btn) btn.style.display = canPick ? '' : 'none';
  if (!canPick) { const chg = document.getElementById('tcv2Change'); if (chg) chg.classList.add('hidden'); }
}

function tcv2SameEmail(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

function tcv2Dirty() { return tcv2.items.some(it => (!it.saved && !it.del) || (it.saved && it.del) || (it.saved && !it.del && it.role !== it.orig)); }

async function tcv2PickTeacher(email, name) {
  email = String(email || '').trim(); if (!email) return;
  const me = await tcv2WhoAmI();
  if (!me.canPick) { tcv2ApplyPick(false); tcv2SetMsg('Only an Admin or Super Admin can add hours for another teacher.', 'err', 'week'); return; }
  const chg = document.getElementById('tcv2Change');
  const inp = document.getElementById('teacherNameInput');
  const tidy = () => { if (chg) chg.classList.add('hidden'); if (inp) { inp.value = ''; delete inp.dataset.userRoleUid; delete inp.dataset.userRoleEmail; } };
  if (tcv2SameEmail(email, tcv2.email)) { tidy(); return; }
  if (tcv2Dirty() && !(await uiConfirm(`Your unsaved changes for ${tcv2.name} will be dropped. Switch to ${name || email}?`, { title: 'Switch teacher?', okLabel: 'Switch', danger: true }))) return;
  tidy();
  await tcv2LoadTeacher(email, name || teacherLabel(email), tcv2SameEmail(email, me.email));
}

function openTeacherModal() {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.hidden = false;
  tcv2PrepModal(); tcv2ApplyPick(false);
  tcv2WhoAmI().then(me => { tcv2ApplyPick(me.canPick); return tcv2LoadTeacher(me.email, me.name, true); });
}

async function openTeacherEditorByEmail(teacherEmail, teacherName = '') {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.hidden = false;
  tcv2PrepModal(); tcv2ApplyPick(false);
  const me = await tcv2WhoAmI();
  tcv2ApplyPick(me.canPick);
  if (!me.canPick && !tcv2SameEmail(me.email, teacherEmail)) {
    await tcv2LoadTeacher(me.email, me.name, true);
    tcv2SetMsg(`Only an Admin or Super Admin can change ${teacherName || teacherLabel(teacherEmail)}'s hours. This is your own week.`, 'warn', 'week');
    return;
  }
  await tcv2LoadTeacher(teacherEmail, teacherName || teacherLabel(teacherEmail), tcv2SameEmail(me.email, teacherEmail));
}
/* === tcv2 pick END === */

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
  if (title) title.innerHTML = '<i class="fa-solid fa-chalkboard-user"></i> Free hours';
  tcv2.items = []; tcv2.sel = null; tcv2.days = new Set(); tcv2.role = null;   // tcv2 steps: no role is pre-chosen, the teacher picks one
  tcv2.step = 1; tcv2.lastAdd = null;                                            // tcv2 wizard: back to question 1, nothing to undo
  const doneBand = document.getElementById('tcv2Done'); if (doneBand) { doneBand.classList.add('hidden'); doneBand.innerHTML = ''; }
  const addTitle = document.getElementById('tcv2AddTitle'); if (addTitle) addTitle.textContent = 'Add free hours';
  tcv2BuildComposer();
  const chg = document.getElementById('tcv2Change'); if (chg) chg.classList.add('hidden');
  const inp = document.getElementById('teacherNameInput'); if (inp) { inp.value = ''; delete inp.dataset.userRoleUid; delete inp.dataset.userRoleEmail; }
  tcv2SetMsg(''); tcv2SetMsg('', '', 'week');
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
  if (!tcv2.bound) { tcv2BindModal(); tcv2.bound = true; }
}

function tcv2BuildComposer() {
  const days = document.getElementById('tcv2Days');
  if (days) {
    days.innerHTML = TCV2.ORDER.map(d => `<button type="button" class="tcv2-dc" data-d="${d}">${TCV2.SHORTDAY[d]}</button>`).join('')
      + `<span class="tcv2-ql"><button type="button" class="tcv2-link" data-q="wd">Weekdays</button><button type="button" class="tcv2-link" data-q="we">Weekend</button><button type="button" class="tcv2-link" data-q="all">Every day</button></span>`;
  }
  const time = document.getElementById('tcv2Time');
  if (time) {
    time.innerHTML = `<div class="tcv2-presets">${TCV2.PRESETS.map(([s, e], i) => `<button type="button" class="tcv2-pc${i === 2 ? ' on' : ''}" data-s="${s}" data-e="${e}">${s}–${e}</button>`).join('')}</div>`
      + `<div class="tcv2-custom"><label for="tcv2Ts">or from</label><input id="tcv2Ts" type="time" step="60" value="18:00"><label for="tcv2Te">to</label><input id="tcv2Te" type="time" step="60" value="21:00"></div>`;
  }
  const tiles = document.getElementById('tcv2Tiles');
  if (tiles) {
    tiles.innerHTML = TCV2.ROLES.map(r => `<button type="button" class="tcv2-tile${r === tcv2.role ? ' r-' + r : ''}" data-r="${r}"><span class="tcv2-tile-t"><i class="fa-solid ${TCV2.ICON[r]}" aria-hidden="true"></i>${TCV2.LABEL[r]}</span><small class="tcv2-tile-d">${TCV2.HINT[r]}</small></button>`).join('');
  }
  const hint = document.getElementById('tcv2Hint'); if (hint) hint.textContent = TCV2.HINT[tcv2.role] || '';
}

async function tcv2LoadTeacher(email, name, isSelf) {
  tcv2.email = (email || '').trim(); tcv2.name = name || tcv2.email; tcv2.items = []; tcv2.sel = null;
  const who = document.getElementById('tcv2Who'); if (who) who.textContent = tcv2.email ? (tcv2.name + (isSelf ? ' · you' : '')) : 'nobody picked yet';
  const wkT = document.querySelector('#tcv2WkCard .tcv2-wktitle b'); if (wkT) wkT.textContent = (!tcv2.email || isSelf) ? 'Your week' : `${tcv2.name}'s week`;   // tcv2 pick (8 Oct 2026)
  const av = document.getElementById('tcv2Av'); if (av) av.textContent = tcv2.email ? tcv2Initials(tcv2.name) : '?';
  const pop = document.getElementById('tcv2Pop'); if (pop) pop.classList.add('hidden');
  if (!tcv2.email) { tcv2SetMsg('Could not tell who you are. Use Change teacher to pick one.', 'warn', 'week'); tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave(); return; }
  try {
    const res = await fetch(`/api/cal-get-teacher-ranges?teacherEmail=${encodeURIComponent(tcv2.email)}`);
    if (!res.ok) throw new Error('Failed to load saved hours');
    const { ranges } = await res.json();
    tcv2.items = (ranges || []).map(r => ({
      id: r.id || null, day: Number(r.day_of_week), start: tcv2HM(r.time_start), end: tcv2HM(r.time_end),
      role: tcv2Role(r.role), orig: tcv2Role(r.role), saved: true, del: false
    }));
    const noRole = tcv2.items.filter(it => it.role === 'none').length;
    tcv2SetMsg(noRole ? `${noRole} saved range(s) have no role yet. Click a grey entry to set one.` : '', 'warn', 'week');
  } catch (e) {
    console.error(e);
    tcv2SetMsg('Could not load the saved hours. Check console.', 'err', 'week');
  }
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
}

function tcv2RenderWeek() {
  const wrap = document.getElementById('tcv2Week'); if (!wrap) return;
  const today = tcv2Today();
  wrap.innerHTML = TCV2.ORDER.map(d => {
    const rows = tcv2.items
      .map((it, k) => ({ it, k }))
      .filter(x => x.it.day === d)
      .sort((a, b) => timeToMinutes(a.it.start) - timeToMinutes(b.it.start))
      .map(({ it, k }) => `<button type="button" class="tcv2-chip r-${it.role}${it.saved ? '' : ' new'}${it.del ? ' del' : ''}${tcv2.sel === k ? ' sel' : ''}" data-k="${k}" title="${tcv2E(TCV2.LABEL[it.role])}${it.saved ? '' : ' · not saved yet'}${it.del ? ' · will be removed' : ''}">`
        + `<span class="tcv2-ct">${it.saved ? '' : '+ '}${tcv2HM(it.start)}–${tcv2HM(it.end)}</span>`
        + `<span class="tcv2-cr">${tcv2E(TCV2.LABEL[it.role])}${it.del ? '<i class="tcv2-tag del">removing</i>' : it.saved ? '' : '<i class="tcv2-tag">new</i>'}</span>`
        + `</button>`)
      .join('');
    return `<div class="tcv2-col${d === today ? ' today' : ''}${tcv2.days.has(d) ? ' picked' : ''}" data-d="${d}"><h5>${TCV2.SHORTDAY[d]}</h5>${rows || '<span class="tcv2-none">no hours</span>'}</div>`;
  }).join('');
  /* tcv2 wizard (6 Oct 2026): the header says how much is SAVED and what is still pending */
  const live = tcv2.items.filter(it => !it.del);
  const mins = arr => arr.reduce((a, it) => a + (timeToMinutes(it.end) - timeToMinutes(it.start)), 0);
  const savedLive = live.filter(it => it.saved);
  const freshItems = live.filter(it => !it.saved);
  const gone = tcv2.items.filter(it => it.saved && it.del).length;
  const changed = savedLive.filter(it => it.role !== it.orig).length;
  const tot = document.getElementById('tcv2WkTotal');
  if (tot) tot.textContent = savedLive.length ? `${tcv2Hours(mins(savedLive))} saved` : 'nothing saved yet';
  const pend = document.getElementById('tcv2Pending');
  if (pend) {
    const parts = [];
    if (freshItems.length) parts.push(`+ ${tcv2Hours(mins(freshItems))} new`);
    if (changed) parts.push(`${changed} changed`);
    if (gone) parts.push(`${gone} removed`);
    pend.textContent = parts.length ? `${parts.join(', ')} — not saved yet` : '';
    pend.classList.toggle('hidden', !parts.length);
  }
  const note = document.getElementById('tcv2WkNote');
  if (note) note.textContent = tcv2.items.length ? 'Click an entry to change its role or remove it.' : 'No hours saved yet. Add some below; they show here as dashed entries until you press Save.';
  const bulk = document.getElementById('tcv2Bulk');
  if (bulk) {
    /* the bulk row exists for one job — giving old ranges a role — so it only appears while one still has none */
    const noRole = live.some(it => it.role === 'none');
    bulk.innerHTML = noRole ? `<span class="lbl">Set every range to</span>${TCV2.ROLES.map(r => `<button type="button" data-bulk="${r}" class="r-${r}">${TCV2.LABEL[r]}</button>`).join('')}` : '';
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

function tcv2SetMsg(text, kind, where) {
  const el = document.getElementById(where === 'week' ? 'tcv2WkMsg' : 'tcv2Msg'); if (!el) return;   // tcv2 steps: 'week' = under the week card
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

function tcv2UpdateSum() {   // kept under its old name: every handler already calls it
  const c = tcv2Composer();
  tcv2Wizard(c);
  const clash = c.days.length && c.b > c.a ? tcv2Clashes(c.days, c.a, c.b) : [];
  if (clash.length) tcv2SetMsg(`Overlaps what is already there on ${clash.join(', ')}.`, 'warn');
}

/* === tcv2 wizard BEGIN (6 Oct 2026) ===
   Design B: the composer asks ONE question per screen. tcv2.step is 1 (days), 2 (time) or 3
   (role). Everything the three screens share — the progress bars, the "So far" chips, Back /
   Next / Add and the one-line note beside them — is redrawn here from the current answers on
   every change. tcv2UpdateSum calls it, and every handler already calls tcv2UpdateSum. */
function tcv2DaysShort(days) {
  if (days.length === 7) return 'every day';
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'weekdays';
  if (key === '0,6') return 'the weekend';
  return days.map(d => TCV2.SHORTDAY[d]).join(', ');
}
function tcv2DaysLong(days) {
  if (days.length === 7) return 'every day';
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'weekdays';
  if (key === '0,6') return 'the weekend';
  return days.map(d => weekdayLong(d)).join(', ');
}
function tcv2Wizard(c) {
  c = c || tcv2Composer();
  const dayOk = c.days.length > 0;
  const timeOk = !!(c.start && c.end && c.b > c.a);
  const roleOk = !!tcv2.role;
  if (tcv2.step > 1 && !dayOk) tcv2.step = 1;          // every day was unpicked from a later screen: start again
  const s = tcv2.step;
  [1, 2, 3].forEach(n => { const el = document.getElementById('tcv2Stp' + n); if (el) el.classList.toggle('tcv2-locked', n !== s); });
  document.querySelectorAll('#tcv2Prog span').forEach(sp => { const n = Number(sp.dataset.s); sp.classList.toggle('cur', n === s); sp.classList.toggle('done', n < s); });
  const timeTxt = `${c.start || '--:--'}–${c.end || '--:--'}`;
  const cr = document.getElementById('tcv2Crumbs');
  if (cr) {
    const parts = [];
    if (s >= 2) parts.push(`<span class="tcv2-crumb"><i class="fa-solid fa-check" aria-hidden="true"></i>${tcv2E(tcv2DaysLong(c.days))}<button type="button" class="tcv2-chg" data-go="1">change</button></span>`);
    if (s >= 3) parts.push(`<span class="tcv2-crumb"><i class="fa-solid fa-check" aria-hidden="true"></i>${tcv2E(timeTxt)} · ${tcv2Hours(Math.max(0, c.b - c.a))}<button type="button" class="tcv2-chg" data-go="2">change</button></span>`);
    cr.innerHTML = parts.length ? `<span class="lbl">So far:</span>${parts.join('')}` : '';
    cr.classList.toggle('hidden', !parts.length);
  }
  const done = document.getElementById('tcv2Done'); if (done) done.classList.toggle('hidden', s !== 1 || !done.innerHTML);
  const back = document.getElementById('tcv2BackBtn'); if (back) back.classList.toggle('hidden', s === 1);
  const next = document.getElementById('tcv2NextBtn');
  if (next) {
    next.classList.toggle('hidden', s === 3);
    next.disabled = (s === 1 && !dayOk) || (s === 2 && !timeOk);
    next.innerHTML = (s === 1 ? 'Next: choose the time' : 'Next: choose the role') + ' <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
  }
  const add = document.getElementById('tcv2AddBtn');
  if (add) {
    add.classList.toggle('hidden', s !== 3);
    add.disabled = !(dayOk && timeOk && roleOk);
    const lbl = document.getElementById('tcv2AddLbl'); if (lbl) lbl.textContent = `Add ${tcv2DaysShort(c.days)} ${timeTxt} to the week`;
  }
  const note = document.getElementById('tcv2Sum');
  if (note) note.textContent =
    s === 1 ? (dayOk ? `${c.days.length} day${c.days.length > 1 ? 's' : ''} picked: ${tcv2DaysShort(c.days)}` : 'No day picked yet.')
    : s === 2 ? ((!c.start || !c.end) ? 'Set a start and an end.' : timeOk ? `${timeTxt} · ${tcv2Hours(c.b - c.a)} on each day` : 'The end must be after the start.')
    : (roleOk ? `${tcv2DaysShort(c.days)} · ${timeTxt} · ${TCV2.LABEL[tcv2.role]} · ${tcv2Hours((c.b - c.a) * c.days.length)} in total` : 'Choose a role to continue.');
  document.querySelectorAll('#tcv2Week .tcv2-col').forEach(col => col.classList.toggle('picked', tcv2.days.has(Number(col.dataset.d))));
}
/* === tcv2 wizard END === */

function tcv2UpdateSave() {
  const btn = document.getElementById('teacherCalSaveBtn'); if (!btn) return;
  const fresh = tcv2.items.filter(it => !it.saved && !it.del).length;
  const gone = tcv2.items.filter(it => it.saved && it.del).length;
  const changed = tcv2.items.filter(it => it.saved && !it.del && it.role !== it.orig).length;
  btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save' + (fresh ? ` · ${fresh} new` : '') + (changed ? ` · ${changed} changed` : '') + (gone ? ` · ${gone} removed` : '');
  /* tcv2 steps (6 Oct 2026): Save appears only once there is something to save. style.display, not
     the hidden attribute — .btn-primary sets display:inline-flex and would override [hidden]. */
  const dirty = fresh + changed + gone > 0;
  btn.style.display = dirty ? '' : 'none';
  const note = document.getElementById('tcv2FootNote');
  if (note) {   /* tcv2 wizard: the note stays while dirty and turns amber, so the footer always says where you stand */
    const parts = []; if (fresh) parts.push(`${fresh} new`); if (changed) parts.push(`${changed} changed`); if (gone) parts.push(`${gone} removed`);
    note.textContent = dirty ? `${parts.join(', ')} — waiting to be saved.` : 'Nothing to save yet. The Save button appears here after your first Add.';
    note.classList.toggle('warn', dirty); note.classList.remove('hidden');
  }
}

function tcv2AddToWeek() {
  const c = tcv2Composer();
  /* on a refusal: jump to the screen that needs fixing, REDRAW, and only then write the message —
     tcv2UpdateSum writes its own overlap warning and would overwrite ours */
  if (!c.days.length) { tcv2.step = 1; tcv2UpdateSum(); tcv2SetMsg('Pick at least one day first.', 'err'); return; }
  if (!c.start || !c.end) { tcv2.step = 2; tcv2UpdateSum(); tcv2SetMsg('Set both a start and an end time.', 'err'); return; }
  if (c.b <= c.a) { tcv2.step = 2; tcv2UpdateSum(); tcv2SetMsg('End time must be after start time.', 'err'); return; }
  if (!tcv2.role) { tcv2.step = 3; tcv2UpdateSum(); tcv2SetMsg('Choose what you will do in this shift first.', 'err'); return; }
  const clash = tcv2Clashes(c.days, c.a, c.b);
  if (clash.length) { tcv2.step = 1; tcv2UpdateSum(); tcv2SetMsg(`${clash.join(', ')} already ${clash.length === 1 ? 'has' : 'have'} hours in that time. Unpick ${clash.length === 1 ? 'it' : 'them'} or change the time.`, 'err'); return; }
  const added = c.days.map(d => ({ id: null, day: d, start: tcv2HM(c.start), end: tcv2HM(c.end), role: tcv2.role, saved: false, del: false }));
  const k0 = tcv2.items.length;   // everything from this index on is what this click added
  tcv2.items.push(...added);
  tcv2.lastAdd = added;           // tcv2 wizard: what Undo takes back out
  tcv2.days = new Set();
  document.querySelectorAll('#tcv2Days .tcv2-dc').forEach(x => x.classList.remove('on'));
  tcv2.sel = null; tcv2.step = 1; tcv2RenderPop();
  const done = document.getElementById('tcv2Done');
  if (done) done.innerHTML = `<i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>Added <b>${tcv2E(tcv2DaysLong(c.days))} ${tcv2E(c.start)}–${tcv2E(c.end)}</b> as <b>${tcv2E(TCV2.LABEL[tcv2.role])}</b>. Add another day below, or press Save.</span><button type="button" data-undo="1">Undo</button>`;
  const title = document.getElementById('tcv2AddTitle'); if (title) title.textContent = 'Add more free hours';
  tcv2SetMsg('');
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
  document.querySelectorAll('#tcv2Week .tcv2-chip').forEach(x => { if (Number(x.dataset.k) >= k0) x.classList.add('just'); });
  document.getElementById('tcv2WkCard')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* tcv2 wizard (6 Oct 2026): Undo takes the LAST Add back out, by object identity, so a range the
   teacher has since re-coloured in the week card still comes out. Saved ranges are never touched. */
function tcv2UndoAdd() {
  if (!tcv2.lastAdd || !tcv2.lastAdd.length) return;
  const n = tcv2.lastAdd.length;
  tcv2.items = tcv2.items.filter(it => !tcv2.lastAdd.includes(it));
  tcv2.lastAdd = null; tcv2.sel = null; tcv2RenderPop();
  const done = document.getElementById('tcv2Done'); if (done) { done.innerHTML = ''; done.classList.add('hidden'); }
  tcv2RenderWeek(); tcv2UpdateSum(); tcv2UpdateSave();
  tcv2SetMsg(`Undone. The ${n} range${n > 1 ? 's' : ''} came back out of the week.`, 'ok');
}

function tcv2BindModal() {
  const m = document.getElementById('teacherCalendarModal'); if (!m) return;
  m.addEventListener('click', (e) => {
    /* tcv2 wizard (6 Oct 2026): Back, Next, the "change" chips, and Undo */
    const go = e.target.closest('#tcv2NextBtn, #tcv2BackBtn, .tcv2-chg');
    if (go) {
      if (go.id === 'tcv2NextBtn') tcv2.step = Math.min(3, tcv2.step + 1);
      else if (go.id === 'tcv2BackBtn') tcv2.step = Math.max(1, tcv2.step - 1);
      else tcv2.step = Number(go.dataset.go) || 1;
      tcv2SetMsg(''); tcv2UpdateSum(); return;
    }
    if (e.target.closest('#tcv2Done [data-undo]')) { tcv2UndoAdd(); return; }
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
    /* tcv2 pick (8 Oct 2026): teacher.js empties #teacherNameSuggestions BEFORE this runs, so the clicked
       button is already detached and an '#teacherNameSuggestions ...' selector never matched. Match the button. */
    const sug = e.target.closest('button.suggestion');
    if (sug) { tcv2PickTeacher(sug.dataset.email, sug.dataset.name || ''); return; }
    const bulk = e.target.closest('#tcv2Bulk [data-bulk]');
    if (bulk) {
      const r = tcv2Role(bulk.dataset.bulk);
      tcv2.items.forEach(it => { if (!it.del) it.role = r; });
      tcv2RenderWeek(); tcv2RenderPop(); tcv2UpdateSave();
      tcv2SetMsg(`Every range is now ${TCV2.LABEL[r]}. Press Save to keep it.`, 'ok', 'week'); return;
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
  if (noRole && !(await uiConfirm(`${noRole} range(s) still have no role. Save anyway?`, { title: 'Some ranges have no role', okLabel: 'Save anyway' }))) return;
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

/* === tcv2 cards BEGIN (6 Oct 2026) ===
   The By teacher view, redesigned: ONE CARD PER TEACHER.
   - a row per WORKING day only, on a 08:00-22:00 ruler that widens only for a
     teacher whose own hours fall outside that window
   - solid bars in the role colour at the real position, the time written on
     the bar; a time that does not fit is printed beside the bar instead
     (tcv2FitBars measures after render, so it also follows window resizes)
   - alternating faint LANES so the eye cannot slip a row on the way from the
     day label to a bar far to the right, and the day name ECHOED small and
     muted at the right edge of every row for the same reason
   - today's row is tinted blue and carries a NOW line; a teacher whose hours
     contain this minute gets an "On now" badge, and the toolbar switch
     "Working now" filters to those teachers
   - two ranges that overlap on one day are STACKED (solid + outlined) and
     named in the footer, instead of being drawn on top of each other
   - a teacher with nothing stored gets a short card with an Add button
   Nothing about bookings is shown: this page stores available hours only.
   Clicking a bar still opens the inline editor (tcv2BindBoard, .tcv2-bk).
   The pencil and trash buttons still go through teacher.js (.t-edit, .t-del). */
function tcv2Axis(list) {
  let a = TCV2.AXIS_START, b = TCV2.AXIS_END;
  for (const t of list) for (const r of t.ranges) {
    if (r.startMin < a) a = Math.floor(r.startMin / 60) * 60;
    if (r.endMin > b) b = Math.ceil(r.endMin / 60) * 60;
  }
  a = Math.max(0, a); b = Math.min(24 * 60, Math.max(b, a + 60));
  return { a, b, x: (m) => Math.max(0, Math.min(100, (m - a) / (b - a) * 100)) };
}
/* ruler marks: the start, every EVEN hour, the end; never two marks closer than 90 min */
function tcv2RulerHours(ax) {
  const hs = [ax.a];
  for (let m = Math.ceil(ax.a / 120) * 120; m < ax.b; m += 120) if (m - ax.a >= 90 && ax.b - m >= 90) hs.push(m);
  hs.push(ax.b);
  return hs;
}
function tcv2OnNow(t, today, now) { return t.ranges.some(r => r.day === today && now >= r.startMin && now < r.endMin); }
/* a stable colour per TEACHER, for the avatar and the card's edge stripe (identity pass, 6 Oct 2026).
   Hashed from the email, so a teacher keeps the same colour from one visit to the next. Seven
   hues, none of them a role hue: purple stays Breakout, teal TTKB, coral Supporter, rose Mix. */
const TCV2_ACC = ['#1D4ED8', '#0E7490', '#15803D', '#4D7C0F', '#B91C1C', '#A21CAF', '#854F0B'];
function tcv2Accent(email) { let h = 5381; for (const ch of String(email || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return TCV2_ACC[h % TCV2_ACC.length]; }
/* give each range of one day a sub-lane: the first free one it does not overlap.
   Sub-lane 0 is drawn solid, the rest outlined. Also lists what overlaps what. */
function tcv2DayLanes(rs) {
  const lanes = [], placed = [], over = [];
  for (const r of rs) {
    let k = 0;
    while (lanes[k] && lanes[k].some(o => tcv2Overlap(o.startMin, o.endMin, r.startMin, r.endMin))) k++;
    if (k > 0) { const o = lanes[0].find(o => tcv2Overlap(o.startMin, o.endMin, r.startMin, r.endMin)); if (o) over.push([r, o]); }
    (lanes[k] = lanes[k] || []).push(r);
    placed.push({ r, k });
  }
  return { placed, k: lanes.length, over };
}
function tcv2Bar(r, email, ax, k) {
  const a = Math.max(r.startMin, ax.a), b = Math.min(r.endMin, ax.b);
  if (b <= a) return '';
  const left = ax.x(a), width = Math.max(0.6, ax.x(b) - left);
  const label = `${r.start}–${r.end}`;
  const tip = `${TCV2.SHORTDAY[r.day]} · ${label} · ${TCV2.LABEL[r.role]}`;
  return `<span class="tcv2-bk r-${r.role}${k ? ' o' : ''}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;top:${k * 24}px" tabindex="0" role="button"`
    + ` data-avail-id="${tcv2E(r.id)}" data-day="${r.day}" data-start="${r.start}" data-end="${r.end}" data-role="${r.role}" data-teacher-email="${tcv2E(email)}" data-s="${r.startMin}" data-e="${r.endMin}"`
    + ` data-tip="${tcv2E(tip)}" aria-label="${tcv2E(tip)}, press Enter to edit"><span class="tcv2-bt">${label}</span></span>`;
}
function tcv2Card(t, ax, today, now) {
  const roles = [...TCV2.ROLES, 'none'].filter(r => t.byRole[r]);
  const onNow = tcv2OnNow(t, today, now);
  const head = `<div class="tcv2-chd"><span class="tcv2-av">${tcv2E(tcv2Initials(t.name))}</span><span class="tcv2-name">${tcv2E(t.name)}</span>`
    + roles.map(r => `<span class="tcv2-badge r-${r}">${TCV2.LABEL[r]}</span>`).join('')
    + (onNow ? '<span class="tcv2-onnow">On now</span>' : '') + '</div>';
  const acts = `<div class="tcv2-acts">`
    + `<button class="card-action t-edit" title="Edit this teacher's free hours" data-teacher-email="${tcv2E(t.email)}" data-teacher-name="${tcv2E(t.name)}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>`
    + `<button class="card-action t-del" title="Delete this teacher and all free hours" data-teacher-email="${tcv2E(t.email)}" data-teacher-name="${tcv2E(t.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`
    + `</div>`;
  let body;
  if (!t.ranges.length) {
    body = `<div class="tcv2-cempty">No hours stored yet.<button type="button" class="tcv2-addbtn t-edit" data-teacher-email="${tcv2E(t.email)}" data-teacher-name="${tcv2E(t.name)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add hours</button></div>`;
  } else {
    const hs = tcv2RulerHours(ax);
    const rul = `<div class="tcv2-rul">${hs.map((m, i) => `<span class="${i % 2 ? 'odd' : ''}" style="left:${ax.x(m).toFixed(2)}%">${String(Math.floor(m / 60)).padStart(2, '0')}</span>`).join('')}</div>`;
    const vl = `<div class="tcv2-vl">${hs.map(m => `<i style="left:${ax.x(m).toFixed(2)}%"></i>`).join('')}</div>`;
    const warns = []; let zi = 0;
    const rows = TCV2.ORDER.map(d => {
      const rs = t.ranges.filter(r => r.day === d).sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin);
      if (!rs.length) return '';
      const { placed, k, over } = tcv2DayLanes(rs);
      over.forEach(([r, o]) => warns.push(`${TCV2.SHORTDAY[d]}: ${r.start}–${r.end} overlaps ${o.start}–${o.end}`));
      const isToday = d === today, z = zi++ % 2 === 1, we = d === 0 || d === 6;
      const nowl = isToday && now >= ax.a && now <= ax.b ? `<i class="tcv2-nowl" style="--x:${(ax.x(now) / 100).toFixed(4)}"></i>` : '';
      return `<div class="tcv2-dr${isToday ? ' td' : z ? ' z' : ''}" style="--k:${k}" data-day="${d}">`
        + `<span class="tcv2-dl${we ? ' we' : ''}">${TCV2.SHORTDAY[d]}${over.length ? '<i class="fa-solid fa-triangle-exclamation tcv2-wi" aria-hidden="true"></i>' : ''}</span>`
        + `<div class="tcv2-lane">${placed.map(p => tcv2Bar(p.r, t.email, ax, p.k)).join('')}</div>`
        + `<span class="tcv2-de">${TCV2.SHORTDAY[d]}</span>${nowl}</div>`;
    }).join('');
    const off = TCV2.ORDER.filter(d => !t.ranges.some(r => r.day === d));
    const foot = `<div class="tcv2-off">${off.length ? 'Off' + off.map(d => `<span>${TCV2.SHORTDAY[d]}</span>`).join('') : 'Works every day'}`
      + (warns.length ? `<span class="tcv2-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${warns.map(tcv2E).join(' · ')}</span>` : '') + `</div>`;
    body = rul + `<div class="tcv2-grid">${vl}${rows}</div>` + foot;
  }
  return `<div class="tcv2-card" style="--acc:${tcv2Accent(t.email)}" data-email="${tcv2E(t.email)}" data-n="${tcv2E((t.name + ' ' + t.email).toLowerCase())}" data-r="${roles.join(' ')}" data-now="${onNow ? 1 : 0}">${head}${acts}${body}</div>`;
}

function renderTByTeacher(data) {
  tcv2.freeAt = null;
  const list = tcv2Prep(data);
  if (!list.length) return '<div class="tcv2-empty">No free hours saved yet. Press the calendar button at the bottom left to add some.</div>';
  const { day: today, min: now } = tcv2VnNow();
  const anyNone = list.some(t => t.byRole.none);
  const nowCount = list.filter(t => tcv2OnNow(t, today, now)).length;
  const flt = ['all', ...TCV2.ROLES, ...(anyNone ? ['none'] : [])].filter(r => r === 'all' || list.some(t => t.byRole[r])).map(r => {
    const n = r === 'all' ? list.length : list.filter(t => t.byRole[r]).length;
    return `<span class="tcv2-tb-flt${r === 'all' ? ' on' : ''}" data-r="${r}">${r === 'all' ? '' : `<span class="tcv2-dot r-${r}"></span>`}${r === 'all' ? 'All' : TCV2.LABEL[r]}<i>${n}</i></span>`;
  }).join('');
  return `<div class="tcv2-view tcv2-cv">`
    + `<div class="tcv2-tb tcv2-ctb"><input type="search" class="tcv2-q" placeholder="Find a teacher">${flt}`
    + `<span class="count" id="tcv2Count">${list.length} teacher${list.length === 1 ? '' : 's'}</span>`
    + `<label class="tcv2-nowlab"><input type="checkbox" class="tcv2-nowtg"><span class="tcv2-sw" aria-hidden="true"></span>Working now · <b>${nowCount}</b></label></div>`
    + `<div class="tcv2-cards">${list.map(t => tcv2Card(t, tcv2Axis([t]), today, now)).join('')}</div></div>`;
}

/* a time that does not fit inside its bar is moved beside the bar: to the right,
   or to the left when the bar sits in the right half, so it never falls off the card.
   Runs after every render (MutationObserver) and after a resize. */
function tcv2FitBars(root) {
  root.querySelectorAll('.tcv2-lane .tcv2-bk').forEach(bk => {
    const t = bk.querySelector('.tcv2-bt'); if (!t) return;
    bk.classList.remove('out', 'out-l');
    if (bk.clientWidth < t.scrollWidth + 12) {
      bk.classList.add('out');
      if (parseFloat(bk.style.left) > 50) bk.classList.add('out-l');
    }
  });
}
/* tooltip on hover and keyboard focus, Enter or Space opens the editor, and the text fitting above */
function tcv2BindCards() {
  const c = document.getElementById('tBoardContent'); if (!c || tcv2.cardsBound) return;
  tcv2.cardsBound = true;
  let tip = null;
  const show = (bk) => {
    if (!bk.dataset.tip) return;
    if (!tip) { tip = document.createElement('div'); tip.className = 'tcv2-tip'; document.body.appendChild(tip); }
    tip.textContent = bk.dataset.tip + ' · click to edit';
    const r = bk.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2 + window.scrollX}px`;
    tip.style.top = `${r.top + window.scrollY - 8}px`;
    tip.classList.add('on');
  };
  const hide = () => { if (tip) tip.classList.remove('on'); };
  const barOf = (e) => e.target.closest ? e.target.closest('.tcv2-lane .tcv2-bk') : null;
  c.addEventListener('mouseover', (e) => { const bk = barOf(e); if (bk) show(bk); });
  c.addEventListener('mouseout', (e) => { if (barOf(e)) hide(); });
  c.addEventListener('focusin', (e) => { const bk = barOf(e); if (bk) show(bk); });
  c.addEventListener('focusout', (e) => { if (barOf(e)) hide(); });
  c.addEventListener('keydown', (e) => {
    const bk = barOf(e); if (!bk) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hide(); openAvailEditor(bk); }
  });
  const fit = () => tcv2FitBars(c);
  new MutationObserver(() => requestAnimationFrame(fit)).observe(c, { childList: true });
  window.addEventListener('resize', () => { clearTimeout(tcv2.fitT); tcv2.fitT = setTimeout(fit, 120); });
  fit();
}
/* === tcv2 cards END === */

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

/* === tcv2 cards filter BEGIN (6 Oct 2026) ===
   Hides cards that do not match the search box, the role chip and the
   Working-now switch. The count is a number of teachers and nothing else:
   this page does not know about bookings. */
function tcv2ApplyFilter(root) {
  const q = (root.querySelector('.tcv2-q')?.value || '').trim().toLowerCase();
  const role = root.querySelector('.tcv2-tb-flt.on')?.dataset.r || 'all';
  const onlyNow = !!root.querySelector('.tcv2-nowtg')?.checked;
  let n = 0;
  root.querySelectorAll('.tcv2-card').forEach(card => {
    const ok = (role === 'all' || (' ' + card.dataset.r + ' ').includes(' ' + role + ' '))
      && (!q || card.dataset.n.includes(q))
      && (!onlyNow || card.dataset.now === '1');
    card.classList.toggle('hide', !ok);
    if (ok) n++;
  });
  const c = root.querySelector('#tcv2Count'); if (c) c.textContent = `${n} teacher${n === 1 ? '' : 's'}`;
}
/* === tcv2 cards filter END === */

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
  c.addEventListener('input', (e) => { if (e.target.classList.contains('tcv2-q') || e.target.classList.contains('tcv2-nowtg')) tcv2ApplyFilter(c); });   // tcv2 cards (6 Oct 2026): the Working-now switch filters too
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
    if (!(await uiConfirm('Delete this free-hour range?', { title: 'Delete this range?', okLabel: 'Delete', danger: true }))) return;
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
document.addEventListener('DOMContentLoaded', () => { tcv2BindBoard(); tcv2BindCards(); });   // tcv2 cards (6 Oct 2026): tooltips, keyboard, text fitting
