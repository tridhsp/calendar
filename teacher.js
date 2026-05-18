/* ---------- Minimal shared bits ---------- */
let client;

const TEACHER_TABLE = 'teachers';
const TEACHER_AVAIL_TABLE = 'teacher_availability';

// NEW: email -> full_name map for display
window._tFullNameByEmail = new Map();
function teacherLabel(email) {
  return window._tFullNameByEmail.get(email) || email;
}


function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function dayCss(i) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][i] || 'sun'; }
function weekdayLong(i) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]; }
function timeToMinutes(t) { const [h = 0, m = 0] = String(t || '').split(':').map(Number); return h * 60 + m; }
function formatTime(t) {
  if (!t) return '';
  const [hh, mm] = String(t).split(':');
  const h = Number(hh) || 0;
  const m = Number(mm) || 0;
  // Always show 24-hour time like 08:00, 19:00
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


/* ---------- Auth/bootstrap ---------- */
async function initSupabase() {
  const msgEl = document.getElementById('message');
  try {
    const res = await fetch('/api/cal-supabase-credentials');
    if (!res.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();

    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
    });

    const { data: { session } } = await client.auth.getSession();
    session ? showApp() : showLogin();
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN') showApp();
      else if (event === 'SIGNED_OUT') showLogin();
      // Ignore TOKEN_REFRESHED / USER_UPDATED to avoid flicker
    });
  } catch (err) {
    console.error(err);
    msgEl.textContent = 'Không thể kết nối Supabase. Vui lòng thử lại sau.';
    showLogin();
  }
}

function setupPasswordToggle() {
  const t = document.getElementById('togglePwd');
  t?.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
  });
}
function setupLoginHandler() {
  const btn = document.getElementById('login'); if (!btn) return;
  const submit = async () => {
    const msgEl = document.getElementById('message'); msgEl.textContent = '';
    if (!client) { msgEl.textContent = 'Supabase đang khởi tạo, vui lòng đợi…'; return; }
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) { msgEl.textContent = 'Vui lòng điền đầy đủ thông tin.'; msgEl.className = 'error'; return; }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) { msgEl.textContent = error.message; msgEl.className = 'error'; }
  };
  btn.addEventListener('click', submit);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function showApp() {
  document.getElementById('loginCard').style.display = 'none';
  document.body.classList.add('app-mode');
  document.getElementById('teacherBoard').classList.remove('hidden');

  let btn = document.getElementById('logoutBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'logoutBtn'; btn.className = 'logout-icon';
    btn.title = 'Log out'; btn.setAttribute('aria-label', 'Log out');
    btn.innerHTML = '<i class="fa-solid fa-power-off" aria-hidden="true"></i>';
    btn.addEventListener('click', async () => { await client.auth.signOut(); });
    document.body.appendChild(btn);
  }

  renderTeacherBoard(false); // use cache if present; no "Loading…" flash


}
function showLogin() {
  document.getElementById('loginCard').style.display = 'block';
  document.getElementById('teacherBoard').classList.add('hidden');
  document.body.classList.remove('app-mode');
  document.getElementById('logoutBtn')?.remove();
  document.getElementById('email')?.focus();
}

/* ---------- Teacher calendar editor (same as your index) ---------- */
function setupTeacherCalendarUI() {
  const fab = document.getElementById('openTeacherCalBtn');
  fab?.addEventListener('click', openTeacherModal);

  const modal = document.getElementById('teacherCalendarModal');
  const closeBtn = document.getElementById('teacherCalCloseBtn');
  const cancelBtn = document.getElementById('teacherCalCancelBtn');
  const addRowBtn = document.getElementById('addTeacherRowBtn');
  const saveBtn = document.getElementById('teacherCalSaveBtn');

  closeBtn?.addEventListener('click', closeTeacherModal);
  cancelBtn?.addEventListener('click', closeTeacherModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeTeacherModal(); });

  addRowBtn?.addEventListener('click', () => addTeacherRow());
  saveBtn?.addEventListener('click', saveTeacherSchedule);

  setupTeacherTypeahead();
}

let teacherTypeTimer;
function setupTeacherTypeahead() {
  const input = document.getElementById('teacherNameInput');
  const list = document.getElementById('teacherNameSuggestions');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    clearTimeout(teacherTypeTimer);
    const q = input.value.trim();
    delete input.dataset.userRoleUid;
    if (q.length < 4) { list.classList.add('hidden'); list.innerHTML = ''; return; }

    teacherTypeTimer = setTimeout(async () => {
  try {
    const res = await fetch('/api/cal-search-teachers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q })
    });
    
    if (!res.ok) throw new Error('Search failed');
    
    const { ok, rows } = await res.json();
    
    if (!ok) throw new Error('Search returned error');
    
    list.innerHTML = (rows?.length ? rows : []).map(r => `
  <button type="button" class="suggestion"
          data-uid="${r.uid}"
          data-email="${escapeHtml(r.email)}"
          data-name="${escapeHtml(r.full_name)}">
    ${escapeHtml(r.email)} <small>${escapeHtml(r.full_name || '')}</small>
  </button>
`).join('') || '<div class="empty">No matches</div>';

    list.classList.remove('hidden');
  } catch (e) { 
    console.error('Teacher typeahead error:', e);
    list.innerHTML = '<div class="empty">Search failed</div>';
  }
}, 1000);
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button.suggestion'); if (!btn) return;
    input.value = btn.dataset.email;                 // show EMAIL
    input.dataset.userRoleUid = btn.dataset.uid;
    input.dataset.userRoleEmail = btn.dataset.email; // save EMAIL for later
    list.classList.add('hidden'); list.innerHTML = '';

  });

  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) list.classList.add('hidden');
  }, { capture: true });
}

function openTeacherModal() { const m = document.getElementById('teacherCalendarModal'); m.hidden = false; resetTeacherRows(); addTeacherRow(); }
function closeTeacherModal() { const m = document.getElementById('teacherCalendarModal'); m.hidden = true; const l = document.getElementById('teacherNameSuggestions'); if (l) { l.classList.add('hidden'); l.innerHTML = ''; } }
function resetTeacherRows() { document.getElementById('teacherScheduleRows').innerHTML = ''; }
function addTeacherRow(values = {}) {
  const wrap = document.getElementById('teacherScheduleRows');
  const row = document.createElement('div'); row.className = 'range-row';
  const day = document.createElement('select'); day.className = 'day';
  const days = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']];
  day.innerHTML = days.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (values.day_of_week != null) day.value = String(values.day_of_week);

  const start = document.createElement('input'); start.className = 'start'; start.type = 'time'; start.step = 60; if (values.time_start) start.value = values.time_start;
  const end = document.createElement('input'); end.className = 'end'; end.type = 'time'; end.step = 60; if (values.time_end) end.value = values.time_end;

  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.title = 'Remove';
  remove.innerHTML = '<i class="fa-solid fa-trash"></i>'; remove.addEventListener('click', () => row.remove());

  row.append(day, start, end, remove); wrap.appendChild(row);
}

async function saveTeacherSchedule() {
  const nameInput = document.getElementById('teacherNameInput');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';

  // Resolve the teacher's EMAIL from the input/dataset
  let teacherEmail = (nameInput?.dataset?.userRoleEmail || nameInput?.value || '').trim();

  // Fallback: if only uid is stored, fetch email from user_roles
// Fallback: if only uid is stored, fetch email via Netlify function
if (!teacherEmail && nameInput?.dataset?.userRoleUid) {
  const res = await fetch(`/api/get-user-email?uid=${encodeURIComponent(nameInput.dataset.userRoleUid)}`);
  if (res.ok) {
    const { email } = await res.json();
    teacherEmail = email || '';
  }
}

  if (!teacherEmail) {
    alert('Please pick a teacher by email from the suggestions.');
    return;
  }

  // Collect ranges from the modal
  const rows = Array.from(document.querySelectorAll('#teacherScheduleRows .range-row')).map(r => {
    const day = r.querySelector('.day').value;
    const start = r.querySelector('.start').value;
    const end = r.querySelector('.end').value;
    return { day_of_week: parseInt(day, 10), time_start: start, time_end: end, timezone: tz };
  }).filter(r => r.time_start && r.time_end);

  if (!rows.length) { alert('Please add at least one time range.'); return; }

  try {
    // Send to Netlify Function (also sends your access token so server knows who you are)
    const { data: { session } } = await client.auth.getSession();
    const userToken = session?.access_token || null;

    console.log('POST → save-teacher-schedule', { teacherEmail, rowsCount: rows.length });


    const res = await fetch('/api/save-teacher-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teacherEmail, rows, userToken })
    });

    console.log('← save-teacher-schedule status', res.status);

    if (!res.ok) throw new Error(await res.text());
    const { inserted } = await res.json();

    // reassign any students no longer covered
    const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(teacherEmail);

    alert(
      `Teacher schedule saved (${inserted} shift(s))!\n` +
      `Reassigned ${changed} session(s)` +
      (unmapped ? `; ${unmapped} had no available teacher` : ``)
    );

    closeTeacherModal();
    renderTeacherBoard(true);
  } catch (e) {
    alert('Save failed. Check console.');
    console.error(e);
  }
}


/* ---------- Board: load & render ---------- */
let tBoardCache = null;
let tBoardView = 'teacher'; // 'teacher' | 'day'
let tBoardHtml = { teacher: '', day: '' }; // cache per tab


function setupTeacherBoardUI() {
  document.getElementById('tViewByTeacher')?.addEventListener('click', () => {
    tBoardView = 'teacher';
    document.getElementById('tViewByTeacher')?.classList.add('active');
    document.getElementById('tViewByDay')?.classList.remove('active');

    const c = document.getElementById('tBoardContent');
    if (tBoardHtml.teacher) c.innerHTML = tBoardHtml.teacher;
    else renderTeacherBoard(false);
  });

  document.getElementById('tViewByDay')?.addEventListener('click', () => {
    tBoardView = 'day';
    document.getElementById('tViewByDay')?.classList.add('active');
    document.getElementById('tViewByTeacher')?.classList.remove('active');

    const c = document.getElementById('tBoardContent');
    if (tBoardHtml.day) c.innerHTML = tBoardHtml.day;
    else renderTeacherBoard(false);
  });

  document.getElementById('tRefreshBoard')?.addEventListener('click', () => renderTeacherBoard(true));

  // ONE async handler for all buttons/pills on the board
  const tContainer = document.getElementById('tBoardContent');
  tContainer?.addEventListener('click', async (e) => {
    // Trash button on the card header
   // Trash button on the card header
const delBtn = e.target.closest('.t-del');
if (delBtn) {
  const email = delBtn.dataset.teacherEmail;
  const name = delBtn.dataset.teacherName || email;
  const sure = confirm(
    `Delete all availability for "${name}"?\nAny assigned student sessions will be reassigned if possible, or unassigned.`
  );
  if (!sure) return;

  try {
    // First reassign students
    const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(email);

    // Then delete teacher via Netlify function
    const res = await fetch('/api/delete-teacher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teacherEmail: email })
    });

    if (!res.ok) throw new Error(await res.text());

    alert(
      `Deleted "${name}".\n` +
      `Reassigned ${changed} session(s)` +
      (unmapped ? `; ${unmapped} had no available teacher` : ``)
    );
    renderTeacherBoard(true);
  } catch (err) {
    console.error(err);
    alert('Delete failed. Check console.');
  }
  return;
}


    // Pencil button on the card header
    const editBtn = e.target.closest('.t-edit');
    if (editBtn) {
      const email = editBtn.dataset.teacherEmail;
      const name = editBtn.dataset.teacherName || email;
      openTeacherEditorByEmail(email, name);
      return;
    }


    // Click a shift “pill” to inline edit that one range
    const pill = e.target.closest('.duo-chip');
    if (!pill || !pill.dataset.availId) return;
    openAvailEditor(pill);
  });
}


async function renderTeacherBoard(force = false) {
  const container = document.getElementById('tBoardContent');
  if (!container || !client) return;

  if (force || !tBoardCache) {
    container.innerHTML = 'Loading…';
    try {
      tBoardCache = await loadTeacherAvailability();
    } catch (e) {
      console.error('Board load failed:', e);
      container.innerHTML = `<div class="tip" style="color:#d52731">Cannot load schedules. ${escapeHtml(e.message || '')}</div>`;
      return;
    }
  }

  // (Re)build cached HTML only when forced or not yet built
  if (force || !tBoardHtml.teacher || !tBoardHtml.day) {
    tBoardHtml.teacher = renderTByTeacher(tBoardCache);
    tBoardHtml.day = renderTByDay(tBoardCache);
  }

  // Show from cache (no re-render when switching tabs)
  container.innerHTML = tBoardView === 'day' ? tBoardHtml.day : tBoardHtml.teacher;

}

async function loadTeacherAvailability() {
  try {
    const res = await fetch('/api/get-teacher-board');
    if (!res.ok) throw new Error('Failed to load teacher board');
    
    const data = await res.json();
    
    // Update the full name map
    if (data.fullNames) {
      window._tFullNameByEmail = new Map(Object.entries(data.fullNames));
    }
    
    return {
      teachers: data.teachers || [],
      ranges: data.ranges || [],
      statuses: data.statuses || [],
      schedules: data.schedules || []
    };
  } catch (error) {
    console.error('Error loading teacher availability:', error);
    return { teachers: [], ranges: [], statuses: [], schedules: [] };
  }
}

/* find the next upcoming range for highlight */
function nextRange(ranges = []) {
  if (!ranges.length) return null;
  const now = new Date(); const today = now.getDay(); // 0-6
  let best = null, bestDelta = Infinity;

  for (const r of ranges) {
    const [sh, sm] = (r.time_start || '00:00').split(':').map(Number);
    const dOffset = (r.day_of_week - today + 7) % 7;
    const start = new Date(now); start.setHours(sh || 0, sm || 0, 0, 0); start.setDate(now.getDate() + dOffset);

    let delta = start - now;
    if (delta < 0) { start.setDate(start.getDate() + 7); delta = start - now; }
    if (delta < bestDelta) { bestDelta = delta; best = r; }
  }
  return best;
}

async function reassignAfterTeacherScheduleChangeByEmail(teacherEmail) {
  const res = await fetch('/api/reassign-teacher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teacherEmail })
  });
  if (!res.ok) {
    console.error('Reassign failed:', await res.text());
    return { changed: 0, unmapped: 0 };
  }
  return await res.json(); // { changed, unmapped }
}



/* ----- Render: by teacher (cards) ----- */
function renderTByTeacher({ teachers, ranges, statuses, schedules }) {
  // Map: teacher -> their ranges
  const map = new Map(teachers.map(t => [t.name, { ...t, slots: [] }])); // key = email
  for (const r of ranges) { const t = map.get(r.teacher_email); if (t) t.slots.push(r); }

  for (const t of map.values()) {
    t.slots.sort((a, b) => (a.day_of_week - b.day_of_week) || (timeToMinutes(a.time_start) - timeToMinutes(b.time_start)));
  }

  // student email -> status minutes
  const statusByEmail = new Map((statuses || []).map(s => [s.email, Number(s.status || 0)]));


  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const dayLabel = d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d];

  const cards = Array.from(map.values()).map(t => {
    const byDay = new Map(dayOrder.map(d => [d, []]));
    for (const r of t.slots) { if (byDay.has(r.day_of_week)) byDay.get(r.day_of_week).push(r); }
    const next = nextRange(t.slots);

    const dayCells = dayOrder.map(d => {
      const items = byDay.get(d) || [];

      const pills = items.map(r => {
        const isNext = next && d === next.day_of_week && r.time_start === next.time_start && r.time_end === next.time_end;

        // shift length in minutes
        const startMin = timeToMinutes(r.time_start);
        const endMin = timeToMinutes(r.time_end);
        const total = Math.max(0, endMin - startMin);

        // how many minutes do assigned students take within this shift?
        let used = 0;
        for (const sc of (schedules || [])) {
          if (sc.teacher_email !== t.name) continue; // t.name is the email
          if (sc.day_of_week !== d) continue;
          const sMin = timeToMinutes(sc.time_local);
          if (sMin >= startMin && sMin < endMin) {
            used += Number(statusByEmail.get(sc.student_email) || 0);
          }
        }

        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;

        return `
  <span class="duo-chip ${dayCss(d)}${isNext ? ' next' : ''}"
        title="Click to edit/delete"
        data-avail-id="${r.id}"
        data-day="${r.day_of_week}"
        data-start="${r.time_start}"
        data-end="${r.time_end}"
       data-teacher-email="${escapeHtml(t.name)}">

    <span class="day">${dayLabel(d)}</span>
    <span class="time">
      <span class="t-start">${formatTime(r.time_start)}</span>
      <span class="t-sep" aria-hidden="true"></span>
      <span class="t-end">${formatTime(r.time_end)}</span>
    </span>
  </span>
  <div class="usage">
    <div class="usage-bar"><div class="usage-fill" style="width:${pct}%"></div></div>
    <div class="usage-label">${used} / ${total} min (${pct}%)</div>
  </div>
`;

      }).join('');

      const cellCls = items.length ? 'day-cell has-pill' : 'day-cell';
      return `<div class="${cellCls}" data-label="${dayLabel(d)}">${pills}</div>`;
    }).join('');

    return `
      <div class="student-card">
        <div class="student-week">
<div class="student-name">
<span class="name-txt">${escapeHtml(teacherLabel(t.name))}</span>
</div>

<div class="card-actions">
  <button
    class="card-action t-edit"
    title="Edit this teacher's calendar"
    data-teacher-email="${escapeHtml(t.name)}"
    data-teacher-name="${escapeHtml(teacherLabel(t.name))}">
    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
  </button>

  <button
    class="card-action t-del"
    title="Delete this teacher and availability"
    data-teacher-email="${escapeHtml(t.name)}"
    data-teacher-name="${escapeHtml(teacherLabel(t.name))}">
    <i class="fa-solid fa-trash" aria-hidden="true"></i>
  </button>
</div>




          ${dayCells}
        </div>
      </div>`;
  }).join('');

  return `<div class="student-grid">${cards}</div>`;
}


/* ----- Render: by day (columns) ----- */
function renderTByDay({ teachers, ranges }) {
  const names = new Map(teachers.map(t => [t.name, teacherLabel(t.name)]));

  const days = Array.from({ length: 7 }, () => []);
  for (const r of ranges) {
    days[r.day_of_week]?.push({
      name: names.get(r.teacher_email) || (r.teacher_email || 'Unknown'),
      start: r.time_start, end: r.time_end, tz: r.timezone || ''
    });
  }

  for (const arr of days) { arr.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)); }

  const cols = days.map((arr, i) => `
    <div class="day-col">
      <h4>${weekdayLong(i)}</h4>
      ${arr.length ? arr.map(x => `
          <div class="day-item">
            <span class="who">${escapeHtml(x.name)}</span>
<span class="when">
  <span class="t-start">${formatTime(x.start)}</span>
  <span class="t-sep" aria-hidden="true"></span>
  <span class="t-end">${formatTime(x.end)}</span>
</span>
          </div>`).join('')
      : '<div class="tip">No availability</div>'
    }
    </div>
  `).join('');

  return `<div class="day-grid">${cols}</div>`;
}

// Open the Teacher Calendar modal prefilled for an existing teacher
async function openTeacherEditorByEmail(teacherEmail, teacherName = '') {
  try {
    // Show modal
    const modal = document.getElementById('teacherCalendarModal');
    modal.hidden = false;

    // Prefill teacher input + store email so Save knows who it is
    const input = document.getElementById('teacherNameInput');
    if (input) {
      input.value = teacherName;
      delete input.dataset.userRoleUid;
      input.dataset.userRoleEmail = teacherEmail;
    }

    // Prefill ranges from Netlify function
    resetTeacherRows();
    const res = await fetch(`/api/cal-get-teacher-ranges?teacherEmail=${encodeURIComponent(teacherEmail)}`);
    
    if (!res.ok) throw new Error('Failed to load teacher ranges');
    
    const { ranges } = await res.json();
    
    if (ranges?.length) {
      for (const r of ranges) addTeacherRow(r);
    } else {
      addTeacherRow();
    }
  } catch (e) {
    console.error(e);
    alert('Could not open editor. Check console.');
  }
}

// Inline editor for a single availability range (shift)
function openAvailEditor(anchorEl) {
  // remove previous editor if any
  document.getElementById('availEditCard')?.remove();

  const rect = anchorEl.getBoundingClientRect();
  const card = document.createElement('div');
  card.id = 'availEditCard';
  card.className = 'avail-editor';
  card.style.top = `${rect.bottom + 8}px`;
  card.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 320))}px`;

  const availId = anchorEl.dataset.availId;
  const start = anchorEl.dataset.start || '08:00';
  const end = anchorEl.dataset.end || '12:00';

  card.innerHTML = `
    <div class="ae-row">
      <label>Start</label>
      <input id="aeStart" type="time" step="60" value="${start}">
    </div>
    <div class="ae-row">
      <label>End</label>
      <input id="aeEnd" type="time" step="60" value="${end}">
    </div>
    <div class="ae-actions">
      <button id="aeDelete" class="btn-sm danger" type="button">Delete</button>
      <div class="spacer"></div>
      <button id="aeCancel" class="btn-sm" type="button">Cancel</button>
      <button id="aeSave" class="btn-sm primary" type="button">Save</button>
    </div>
  `;
  document.body.appendChild(card);

  const close = () => {
    document.removeEventListener('click', onDoc, { capture: true });
    document.removeEventListener('keydown', onKey);
    card.remove();
  };
  const onDoc = (ev) => { if (!card.contains(ev.target) && ev.target !== anchorEl) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => document.addEventListener('click', onDoc, { capture: true }), 0);
  document.addEventListener('keydown', onKey);

  document.getElementById('aeCancel').addEventListener('click', close);

  document.getElementById('aeSave').addEventListener('click', async () => {
    const newStart = document.getElementById('aeStart').value;
    const newEnd = document.getElementById('aeEnd').value;
    if (!newStart || !newEnd) { alert('Please set both start and end.'); return; }
    if (timeToMinutes(newStart) >= timeToMinutes(newEnd)) {
      alert('End time must be after start time.');
      return;
    }
    try {
      const res = await fetch('/api/update-teacher-shift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'update',
          availId: availId,
          timeStart: newStart,
          timeEnd: newEnd
        })
      });

      if (!res.ok) throw new Error(await res.text());

      const teacherEmail = anchorEl.dataset.teacherEmail;
      const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(teacherEmail);

      alert(
        `Shift updated.\n` +
        `Reassigned ${changed} session(s)` +
        (unmapped ? `; ${unmapped} had no available teacher` : ``)
      );

      close();
      renderTeacherBoard(true);

    } catch (e) {
      console.error(e);
      alert('Update failed. Check console.');
    }
  });

  document.getElementById('aeDelete').addEventListener('click', async () => {
    if (!confirm('Delete this working shift?')) return;
    try {
      const res = await fetch('/api/update-teacher-shift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'delete',
          availId: availId
        })
      });

      if (!res.ok) throw new Error(await res.text());

      const teacherEmail = anchorEl.dataset.teacherEmail;
      const { changed, unmapped } = await reassignAfterTeacherScheduleChangeByEmail(teacherEmail);

      alert(
        `Shift deleted.\n` +
        `Reassigned ${changed} session(s)` +
        (unmapped ? `; ${unmapped} had no available teacher` : ``)
      );

      close();
      renderTeacherBoard(true);

    } catch (e) {
      console.error(e);
      alert('Delete failed. Check console.');
    }
  });
}

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  setupPasswordToggle();
  setupLoginHandler();
  setupTeacherCalendarUI(); // allow editing from this page
  setupTeacherBoardUI();    // toggles + refresh
});