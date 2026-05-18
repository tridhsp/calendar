/* teachercalendar.js — Teacher availability + work shifts + gap analysis viewer for managehvgv */

let client;
let refreshTimer = null;
let tcData = null;
let tcWorktimeData = null; // from wts-get-worktime-data
let tcSelectedDow = -1; // -1 = auto (today)
let tcViewMode = 'day'; // 'day' or 'teacher'
let tcExpandedTeachers = new Set(); // track expanded detail panels

/* ========== Auth (same pattern as slhvvagv) ========== */

function scheduleProactiveRefresh(session) {
  if (!session || !session.expires_at || !client) return;
  clearTimeout(refreshTimer);
  const delay = Math.max(0, session.expires_at * 1000 - Date.now() - 2 * 60 * 1000);
  refreshTimer = setTimeout(async () => {
    try {
      const { data, error } = await client.auth.refreshSession();
      if (!error && data?.session) scheduleProactiveRefresh(data.session);
    } catch (err) { console.error('Refresh error:', err); }
  }, delay);
}

function handleSession(session) {
  if (session) { scheduleProactiveRefresh(session); showApp(); }
  else { clearTimeout(refreshTimer); showLogin(); }
}

async function initSupabase() {
  const msgEl = document.getElementById('message');
  try {
    const res = await fetch('/api/wts-supabase-credentials');
    if (!res.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await res.json();

    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
    });

    const { data: { session } } = await client.auth.getSession();
    handleSession(session);
    client.auth.onAuthStateChange((_event, session) => handleSession(session));
  } catch (err) {
    console.error(err);
    if (msgEl) { msgEl.textContent = 'Không thể kết nối Supabase.'; msgEl.className = 'error'; }
    showLogin();
  }
}

function setupPasswordToggle() {
  const t = document.getElementById('togglePwd');
  t?.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    if (pwd) pwd.type = pwd.type === 'password' ? 'text' : 'password';
  });
}

function setupLoginHandler() {
  const btn = document.getElementById('login');
  if (!btn) return;
  const submit = async () => {
    const msgEl = document.getElementById('message');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = ''; }
    if (!client) { if (msgEl) { msgEl.textContent = 'Đang kết nối…'; msgEl.className = 'error'; } return; }
    const email = document.getElementById('email')?.value.trim();
    const password = document.getElementById('password')?.value ?? '';
    if (!email || !password) { if (msgEl) { msgEl.textContent = 'Vui lòng điền đầy đủ thông tin.'; msgEl.className = 'error'; } return; }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error && msgEl) { msgEl.textContent = error.message; msgEl.className = 'error'; }
  };
  btn.addEventListener('click', submit);
  document.getElementById('loginCard')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function showApp() {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('tcApp').style.display = 'block';
  document.body.classList.add('has-sidebar');
  populateSidebarUser();

  const sidebarLogout = document.getElementById('sidebarLogout');
  if (sidebarLogout && !sidebarLogout._bound) {
    sidebarLogout._bound = true;
    sidebarLogout.addEventListener('click', async (e) => {
      e.preventDefault();
      if (client) await client.auth.signOut();
    });
  }

  if (!tcData) loadData();
}

async function populateSidebarUser() {
  if (!client) return;
  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return;
    const email = user.email || '';
    const rawName = user.user_metadata?.full_name || user.user_metadata?.name || '';
    const name = rawName || email.split('@')[0] || 'User';
    const initial = (name || email || '?').charAt(0).toUpperCase();

    const avatarEl = document.getElementById('sidebarUserAvatar');
    const nameEl = document.getElementById('sidebarUserName');
    const emailEl = document.getElementById('sidebarUserEmail');
    if (avatarEl) avatarEl.textContent = initial;
    if (nameEl) nameEl.textContent = name;
    if (emailEl) emailEl.textContent = email;
  } catch (e) { console.error(e); }
}

function showLogin() {
  document.getElementById('loginCard').style.display = 'block';
  document.getElementById('tcApp').style.display = 'none';
  document.body.classList.remove('has-sidebar');
  document.getElementById('sidebarNav')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('open');
  document.getElementById('email')?.focus();
}

/* ========== Auth Fetch ========== */

async function authFetch(url, options = {}) {
  const { data: { session: s } } = await client.auth.getSession();
  const headers = { ...(options.headers || {}) };
  if (s?.access_token) headers['Authorization'] = `Bearer ${s.access_token}`;
  return fetch(url, { ...options, headers });
}

/* ========== Helpers ========== */

const DOW_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const DOW_LONG = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun display order

function escHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function timeToMin(t) {
  const [h = 0, m = 0] = String(t || '').split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function fmtTime(t) {
  if (!t) return '';
  const parts = String(t).split(':');
  return `${String(parts[0]||0).padStart(2,'0')}:${String(parts[1]||0).padStart(2,'0')}`;
}

function fmtDuration(mins) {
  if (mins <= 0) return '0p';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h${m}p`;
  if (h > 0) return `${h}h`;
  return `${m}p`;
}

function getTodayDow() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getUTCDay();
}

function getWeekDates() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const todayStr = now.toISOString().slice(0, 10);
  const todayDate = new Date(todayStr + 'T00:00:00Z');
  const dow = todayDate.getUTCDay();
  const daysFromMon = (dow + 6) % 7;
  const monday = new Date(todayDate);
  monday.setUTCDate(todayDate.getUTCDate() - daysFromMon);

  const dates = {};
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + offset);
    const dayDow = d.getUTCDay();
    dates[dayDow] = d.toISOString().slice(5, 10).replace('-', '/');
  }
  return dates;
}

/* Department display colors */
const DEPT_COLORS = {
  'ttkb':      { bg: '#dbeafe', text: '#1d4ed8', label: 'TTKB', barBg: '#3b82f6' },
  'breakout':  { bg: '#dcfce7', text: '#15803d', label: 'Breakout', barBg: '#22c55e' },
  'bm':        { bg: '#fef3c7', text: '#92400e', label: 'BM', barBg: '#f59e0b' },
  'supporter': { bg: '#ede9fe', text: '#6d28d9', label: 'Supporter', barBg: '#8b5cf6' },
  'mix':       { bg: '#fce7f3', text: '#be185d', label: 'Mix', barBg: '#ec4899' },
};

function deptStyle(dept) {
  return DEPT_COLORS[(dept || '').toLowerCase()] || { bg: '#f1f5f9', text: '#475569', label: dept || '?', barBg: '#94a3b8' };
}

/* Color palette for teachers (used in By Teacher view) */
const TEACHER_COLORS = [
  { bg: '#dbeafe', text: '#1d4ed8', border: '#93c5fd', bar: '#3b82f6' },
  { bg: '#dcfce7', text: '#15803d', border: '#86efac', bar: '#22c55e' },
  { bg: '#fef3c7', text: '#92400e', border: '#fcd34d', bar: '#f59e0b' },
  { bg: '#ede9fe', text: '#6d28d9', border: '#c4b5fd', bar: '#8b5cf6' },
  { bg: '#fce7f3', text: '#be185d', border: '#f9a8d4', bar: '#ec4899' },
  { bg: '#ccfbf1', text: '#0f766e', border: '#5eead4', bar: '#14b8a6' },
  { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', bar: '#ef4444' },
  { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc', bar: '#0ea5e9' },
  { bg: '#fef9c3', text: '#854d0e', border: '#fde047', bar: '#eab308' },
  { bg: '#f3e8ff', text: '#7e22ce', border: '#d8b4fe', bar: '#a855f7' },
];

function teacherColor(index) {
  return TEACHER_COLORS[index % TEACHER_COLORS.length];
}

/* ========== Data Loading ========== */

async function loadData() {
  const el = document.getElementById('tcContent');
  el.innerHTML = `<div class="tc-loading"><div class="tc-spinner"></div><div>Đang tải dữ liệu…</div></div>`;

  try {
    // Fetch both teacher board and worktime data in parallel
    const [boardRes, worktimeRes] = await Promise.all([
      fetch('/api/get-teacher-board'),
      authFetch('/api/wts-get-worktime-data')
    ]);

    if (!boardRes.ok) throw new Error('HTTP ' + boardRes.status);
    tcData = await boardRes.json();

    if (worktimeRes.ok) {
      tcWorktimeData = await worktimeRes.json();
    } else {
      console.warn('Could not load worktime data:', worktimeRes.status);
      tcWorktimeData = null;
    }

    render();
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="tc-loading" style="color:#dc2626;">Lỗi tải dữ liệu: ${escHtml(err.message)}</div>`;
  }
}

/* ========== Build shift lookup from worktime data ========== */

function buildShiftLookup() {
  const map = {};
  if (!tcWorktimeData?.teachersByDay) return map;

  for (let dow = 0; dow <= 6; dow++) {
    const teachers = tcWorktimeData.teachersByDay[dow] || [];
    for (const t of teachers) {
      const key = `${(t.teacher_email || '').toLowerCase()}|${dow}`;
      map[key] = {
        shifts: t.shifts || [],
        departments: t.departments || [],
        total_work_minutes: t.total_work_minutes || 0,
        ttkb_count: (t.ttkb_students || []).length,
        breakout_count: (t.breakout_students || []).length,
        total_students: (t.ttkb_students || []).length + (t.breakout_students || []).length,
        ttkb_occupied: t.ttkb_occupied_minutes || 0,
        breakout_occupied: t.breakout_occupied_minutes || 0,
        free_minutes: t.free_minutes || 0,
        ttkb_students: t.ttkb_students || [],
        breakout_students: t.breakout_students || [],
        off_ttkb_students: t.off_ttkb_students || [],
        off_breakout_students: t.off_breakout_students || [],
        off_ttkb_occupied: t.off_ttkb_occupied_minutes || 0,
        off_breakout_occupied: t.off_breakout_occupied_minutes || 0,
      };
    }
  }
  return map;
}

/* ========== Get worktime teacher object ========== */

function getWorktimeTeacher(dow, email) {
  if (!tcWorktimeData?.teachersByDay?.[dow]) return null;
  const emailLower = (email || '').toLowerCase();
  return tcWorktimeData.teachersByDay[dow].find(t =>
    (t.teacher_email || '').toLowerCase() === emailLower
  ) || null;
}

/* ========== Gap Analysis for TTKB teachers ========== */

function computeTTKBGaps(shifts, ttkbStudents) {
  // For TTKB: students are sequential (1-on-1). When multiple students share the same
  // scheduled time_local, they are taught back-to-back, not simultaneously.
  // Each student's actual start = max(their scheduled time, end of previous student).
  const gaps = [];
  if (!shifts || !shifts.length) return gaps;

  for (const shift of shifts) {
    const shiftStart = timeToMin(shift.start_time);
    const shiftEnd = timeToMin(shift.end_time);

    // Get TTKB students that fall within this shift
    const studentsInShift = (ttkbStudents || [])
      .map(s => ({
        scheduledStart: timeToMin(s.time_local),
        duration: Number(s.session_minutes) || 25,
        name: s.student_name || s.student_email || '?'
      }))
      .filter(s => s.scheduledStart >= shiftStart && s.scheduledStart < shiftEnd)
      .sort((a, b) => a.scheduledStart - b.scheduledStart);

    let cursor = shiftStart;
    for (const s of studentsInShift) {
      // Sequential: actual start is the later of scheduled time or when the previous student ends
      const actualStart = Math.max(s.scheduledStart, cursor);
      const actualEnd = actualStart + s.duration;
      if (actualStart > cursor) {
        gaps.push({ start: cursor, end: actualStart, minutes: actualStart - cursor });
      }
      cursor = actualEnd;
    }
    if (cursor < shiftEnd) {
      gaps.push({ start: cursor, end: shiftEnd, minutes: shiftEnd - cursor });
    }
  }
  return gaps;
}

/* ========== Low density analysis for Breakout teachers ========== */

function computeBreakoutDensity(shifts, breakoutStudents) {
  // For Breakout: multiple students at once. Find windows with 0 or few students.
  const windows = [];
  if (!shifts || !shifts.length) return windows;

  for (const shift of shifts) {
    const shiftStart = timeToMin(shift.start_time);
    const shiftEnd = timeToMin(shift.end_time);

    // Build student intervals within this shift
    const intervals = (breakoutStudents || [])
      .map(s => ({
        start: timeToMin(s.time_local),
        end: timeToMin(s.time_local) + (Number(s.session_minutes) || 25),
        name: s.student_name || s.student_email || '?'
      }))
      .filter(s => s.end > shiftStart && s.start < shiftEnd);

    // Walk minute-by-minute in 5-min steps and count concurrent students
    let currentCount = -1;
    let windowStart = shiftStart;

    for (let m = shiftStart; m <= shiftEnd; m += 5) {
      let count = 0;
      for (const iv of intervals) {
        if (m >= iv.start && m < iv.end) count++;
      }

      if (count !== currentCount) {
        if (currentCount >= 0 && currentCount <= 1 && m > windowStart) {
          windows.push({ start: windowStart, end: m, count: currentCount, minutes: m - windowStart });
        }
        currentCount = count;
        windowStart = m;
      }
    }
    // Close last window
    if (currentCount >= 0 && currentCount <= 1 && shiftEnd > windowStart) {
      windows.push({ start: windowStart, end: shiftEnd, count: currentCount, minutes: shiftEnd - windowStart });
    }
  }

  // Merge adjacent windows of same count
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && last.end === w.start && last.count === w.count) {
      last.end = w.end;
      last.minutes = last.end - last.start;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/* ========== Rendering ========== */

function render() {
  if (!tcData) return;
  const el = document.getElementById('tcContent');
  const todayDow = getTodayDow();
  if (tcSelectedDow === -1) tcSelectedDow = todayDow;

  // Process data
  const { ranges, fullNames, schedules } = tcData;

  // Build shift lookup from worktime data
  const shiftLookup = buildShiftLookup();

  // Group ranges by teacher email
  const teacherMap = {};
  for (const r of (ranges || [])) {
    const email = r.teacher_email;
    if (!email) continue;
    if (!teacherMap[email]) {
      teacherMap[email] = {
        email,
        name: (fullNames && fullNames[email]) || r.teacher_name || email,
        ranges: []
      };
    }
    teacherMap[email].ranges.push(r);
  }

  // Count assigned students per teacher per day (from student_schedule / get-teacher-board)
  const studentCountMap = {};
  for (const s of (schedules || [])) {
    if (!s.teacher_email) continue;
    const key = `${s.teacher_email}|${s.day_of_week}`;
    studentCountMap[key] = (studentCountMap[key] || 0) + 1;
  }

  const teacherList = Object.values(teacherMap).sort((a, b) =>
    a.name.localeCompare(b.name, 'vi')
  );

  // Stats
  const totalTeachers = teacherList.length;
  const teachersOnDay = teacherList.filter(t =>
    t.ranges.some(r => Number(r.day_of_week) === tcSelectedDow)
  ).length;

  // Count teachers with working shifts on selected day
  let teachersWithShift = 0;
  const emailsSeen = new Set();
  for (const t of teacherList) {
    const sk = `${t.email.toLowerCase()}|${tcSelectedDow}`;
    if (shiftLookup[sk]) { teachersWithShift++; emailsSeen.add(t.email.toLowerCase()); }
  }
  // Also count teachers with shifts but no availability
  if (tcWorktimeData?.teachersByDay?.[tcSelectedDow]) {
    for (const wt of tcWorktimeData.teachersByDay[tcSelectedDow]) {
      if (!emailsSeen.has(wt.teacher_email)) teachersWithShift++;
    }
  }

  // Build HTML
  let html = '';

  // View toggle
  html += `<div class="tc-view-toggle">
    <button class="tc-view-btn ${tcViewMode==='day'?'active':''}" onclick="tcViewMode='day';render();">
      <i class="fa-solid fa-calendar-day"></i> Theo ngày
    </button>
    <button class="tc-view-btn ${tcViewMode==='teacher'?'active':''}" onclick="tcViewMode='teacher';render();">
      <i class="fa-solid fa-user-tie"></i> Theo GV
    </button>
  </div>`;

  // Day picker
  const weekDates = getWeekDates();
  html += `<div class="tc-day-picker">`;
  for (const dow of DOW_ORDER) {
    const isToday = dow === todayDow;
    const isActive = dow === tcSelectedDow;
    const count = teacherList.filter(t => t.ranges.some(r => Number(r.day_of_week) === dow)).length;
    html += `<button class="tc-day-btn ${isActive ? 'active' : ''} ${isToday ? 'today' : ''}"
      onclick="tcSelectedDow=${dow};render();">
      ${isToday ? '<span class="tc-today-dot"></span>' : ''}
      <span class="tc-day-name">${DOW_NAMES[dow]}</span>
      <span class="tc-day-date">${weekDates[dow] || ''}</span>
      <span class="tc-day-count">${count}</span>
      <span class="tc-day-label">GV</span>
    </button>`;
  }
  html += `</div>`;

  // Stats bar
  html += `<div class="tc-stats-bar">
    <div class="tc-stat"><i class="fa-solid fa-users"></i> <strong>${totalTeachers}</strong> GV tổng cộng</div>
    <div class="tc-stat-sep">·</div>
    <div class="tc-stat"><i class="fa-solid fa-calendar-check"></i> <strong>${teachersOnDay}</strong> GV khả dụng ${DOW_LONG[tcSelectedDow]}</div>
    ${tcWorktimeData ? `<div class="tc-stat-sep">·</div>
    <div class="tc-stat"><i class="fa-solid fa-briefcase"></i> <strong>${teachersWithShift}</strong> GV có ca làm</div>` : ''}
  </div>`;

  if (tcViewMode === 'day') {
    html += renderByDay(teacherList, studentCountMap, shiftLookup);
  } else {
    html += renderByTeacher(teacherList, studentCountMap, weekDates, shiftLookup);
  }

  el.innerHTML = html;
}

/* ========== Toggle detail panel ========== */

function toggleTeacherDetail(email) {
  if (tcExpandedTeachers.has(email)) {
    tcExpandedTeachers.delete(email);
  } else {
    tcExpandedTeachers.add(email);
  }
  render();
}

/* ========== NEW: Render By Day (multi-layer timeline) ========== */

function renderByDay(teacherList, studentCountMap, shiftLookup) {
  const dow = tcSelectedDow;

  // Build combined teacher list: those with availability AND/OR work shifts
  const combinedMap = {};

  // From teacherList (availability)
  for (const t of teacherList) {
    const dayRanges = t.ranges
      .filter(r => Number(r.day_of_week) === dow)
      .sort((a, b) => timeToMin(a.time_start) - timeToMin(b.time_start));

    const emailLower = t.email.toLowerCase();
    const sk = `${emailLower}|${dow}`;
    const shiftInfo = shiftLookup[sk] || null;

    combinedMap[emailLower] = {
      email: t.email,
      emailLower,
      name: t.name,
      dayRanges,
      shiftInfo,
      hasAvailability: dayRanges.length > 0,
      hasShift: !!shiftInfo,
    };
  }

  // Add teachers with shifts but no availability registered
  if (tcWorktimeData?.teachersByDay?.[dow]) {
    for (const wt of tcWorktimeData.teachersByDay[dow]) {
      const emailLower = (wt.teacher_email || '').toLowerCase();
      if (!combinedMap[emailLower]) {
        const sk = `${emailLower}|${dow}`;
        combinedMap[emailLower] = {
          email: wt.teacher_email,
          emailLower,
          name: wt.teacher_name || wt.teacher_email,
          dayRanges: [],
          shiftInfo: shiftLookup[sk] || null,
          hasAvailability: false,
          hasShift: true,
        };
      }
    }
  }

  const combined = Object.values(combinedMap);

  // Sort: teachers with shifts first, then by earliest time
  combined.sort((a, b) => {
    // Both have shifts → sort by first shift start
    if (a.hasShift && b.hasShift) {
      const aStart = (a.shiftInfo?.shifts?.[0]?.start_time) || '99:99';
      const bStart = (b.shiftInfo?.shifts?.[0]?.start_time) || '99:99';
      const cmp = timeToMin(aStart) - timeToMin(bStart);
      if (cmp !== 0) return cmp;
      return a.name.localeCompare(b.name, 'vi');
    }
    // One has shift, other doesn't
    if (a.hasShift && !b.hasShift) return -1;
    if (!a.hasShift && b.hasShift) return 1;
    // Neither has shift → sort by availability start
    const aStart = a.dayRanges[0] ? timeToMin(a.dayRanges[0].time_start) : 9999;
    const bStart = b.dayRanges[0] ? timeToMin(b.dayRanges[0].time_start) : 9999;
    return aStart - bStart || a.name.localeCompare(b.name, 'vi');
  });

  if (!combined.length) {
    return `<div class="tc-empty"><i class="fa-solid fa-calendar-xmark"></i> Không có GV nào ${DOW_LONG[tcSelectedDow]}</div>`;
  }

  // Find overall time range for the visual bar (from both availability and shifts)
  let minTime = 24 * 60, maxTime = 0;
  for (const t of combined) {
    for (const r of t.dayRanges) {
      minTime = Math.min(minTime, timeToMin(r.time_start));
      maxTime = Math.max(maxTime, timeToMin(r.time_end));
    }
    if (t.shiftInfo) {
      for (const s of t.shiftInfo.shifts) {
        minTime = Math.min(minTime, timeToMin(s.start_time));
        maxTime = Math.max(maxTime, timeToMin(s.end_time));
      }
    }
  }
  minTime = Math.max(0, Math.floor(minTime / 60) * 60);
  maxTime = Math.min(24 * 60, Math.ceil(maxTime / 60) * 60);
  const totalRange = maxTime - minTime || 1;

  // Time axis labels
  let timeLabels = '';
  for (let m = minTime; m <= maxTime; m += 60) {
    const pct = ((m - minTime) / totalRange) * 100;
    timeLabels += `<span class="tc-time-label" style="left:${pct}%">${String(Math.floor(m/60)).padStart(2,'0')}:00</span>`;
  }

  // Count teachers with shifts vs only-availability
  const withShiftCount = combined.filter(t => t.hasShift).length;
  const availOnlyCount = combined.filter(t => t.hasAvailability && !t.hasShift).length;

  let html = '';

  // === Section: Teachers with work shifts ===
  if (withShiftCount > 0) {
    html += `<div class="tc-section">
      <div class="tc-section-title">
        <i class="fa-solid fa-briefcase"></i> GV có ca làm — ${DOW_LONG[dow]}
        <span class="tc-section-count">${withShiftCount} GV</span>
      </div>`;

    for (const t of combined.filter(x => x.hasShift)) {
      html += renderTeacherRow(t, minTime, totalRange);
    }
    html += `</div>`;
  }

  // === Section: Teachers with availability only (no shift) ===
  if (availOnlyCount > 0) {
    html += `<div class="tc-section tc-section-dimmed">
      <div class="tc-section-title">
        <i class="fa-solid fa-clock" style="color:#f59e0b;"></i> Khả dụng nhưng không có ca — ${DOW_LONG[dow]}
        <span class="tc-section-count">${availOnlyCount} GV</span>
      </div>`;

    for (const t of combined.filter(x => x.hasAvailability && !x.hasShift)) {
      html += renderAvailOnlyRow(t, minTime, totalRange);
    }
    html += `</div>`;
  }

  return html;
}

/* ========== Render a teacher row with multi-layer timeline ========== */

function renderTeacherRow(t, minTime, totalRange) {
  const si = t.shiftInfo;
  const isExpanded = tcExpandedTeachers.has(t.emailLower);

  // Determine primary department for avatar color
  const primaryDept = (si.departments && si.departments[0]) || '';
  const ds = deptStyle(primaryDept);

  const initial = (t.name || '?').charAt(0).toUpperCase();

  // Compute availability total minutes for this day
  const availMins = t.dayRanges.reduce((s, r) => s + timeToMin(r.time_end) - timeToMin(r.time_start), 0);
  const shiftMins = si.total_work_minutes || 0;
  const ttkbStudents = si.ttkb_students || [];
  const breakoutStudents = si.breakout_students || [];
  const occupiedMins = (si.ttkb_occupied || 0) + (si.breakout_occupied || 0);
  const freeMins = si.free_minutes || 0;

  // Department labels (bigger pills for the By Day card)
  const deptLabels = (si.departments || []).map(d => {
    const style = deptStyle(d);
    return `<span class="tc-dept-badge-lg" style="background:${style.bg};color:${style.text};border:1px solid ${style.border || 'transparent'};">${escHtml(style.label)}</span>`;
  }).join('');

  // Compute gaps for TTKB or low-density for Breakout
  const isTTKB = (si.departments || []).some(d => d.toLowerCase() === 'ttkb' || d.toLowerCase() === 'mix');
  const isBreakout = (si.departments || []).some(d => d.toLowerCase() === 'breakout');

  let gapData = [];
  let lowDensityData = [];
  if (isTTKB && ttkbStudents.length > 0) {
    gapData = computeTTKBGaps(si.shifts, ttkbStudents);
  }
  if (isBreakout && breakoutStudents.length > 0) {
    lowDensityData = computeBreakoutDensity(si.shifts, breakoutStudents);
  }

  const totalGapMins = gapData.reduce((s, g) => s + g.minutes, 0);
  const totalLowDensityMins = lowDensityData.reduce((s, g) => s + g.minutes, 0);

  // Availability vs shift comparison
  let comparisonHtml = '';
  if (t.hasAvailability && availMins > 0) {
    const diff = availMins - shiftMins;
    if (diff === 0) {
      comparisonHtml = `<span class="tc-compare-pill tc-compare-match" title="Ca làm khớp với khả dụng"><i class="fa-solid fa-check"></i> Khớp</span>`;
    }
  } else if (!t.hasAvailability) {
    comparisonHtml = `<span class="tc-compare-pill tc-compare-warn" title="GV có ca nhưng chưa đăng ký khả dụng"><i class="fa-solid fa-circle-question"></i> Chưa đăng ký KD</span>`;
  }

  // ===== Compute "can take more work" intervals (avail minus shifts) =====
  function _subIntervals(avails, shifts) {
    let rem = avails.map(r => [timeToMin(r.time_start), timeToMin(r.time_end)]).filter(p => p[1] > p[0]);
    const sh = (shifts || []).map(s => [timeToMin(s.start_time), timeToMin(s.end_time)])
      .filter(p => p[1] > p[0]).sort((a, b) => a[0] - b[0]);
    for (const [s, e] of sh) {
      const next = [];
      for (const [a, b] of rem) {
        if (e <= a || s >= b) { next.push([a, b]); continue; }
        if (s > a) next.push([a, s]);
        if (e < b) next.push([e, b]);
      }
      rem = next;
    }
    return rem.filter(([a, b]) => b > a);
  }
  const canMoreIntervals = _subIntervals(t.dayRanges || [], si.shifts || []);
  const canMoreTotalMin = canMoreIntervals.reduce((s, p) => s + (p[1] - p[0]), 0);

  // ===== Build chip rows =====
  // ROW 1: Availability chips
  let availRowHtml = '';
  for (const r of t.dayRanges) {
    availRowHtml += `<span class="tc-avail-chip" title="Khả dụng: ${fmtTime(r.time_start)}–${fmtTime(r.time_end)}">${fmtTime(r.time_start)}–${fmtTime(r.time_end)}</span>`;
  }
  if (!t.dayRanges.length) {
    availRowHtml = `<span class="tc-chip-row-empty">Chưa đăng ký khả dụng</span>`;
  }

  // ROW 2: Work shift chips (full info — never truncated)
  let shiftRowHtml = '';
  for (const s of (si.shifts || [])) {
    const start = timeToMin(s.start_time);
    const end = timeToMin(s.end_time);
    const dur = end - start;
    const shiftDept = deptStyle(s.department);
    shiftRowHtml += `<span class="tc-shift-chip" style="background:${shiftDept.barBg};" title="Ca ${shiftDept.label}: ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} (${fmtDuration(dur)})">${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · ${shiftDept.label} <span class="tc-shift-chip-dur">${fmtDuration(dur)}</span></span>`;
  }
  if (!si.shifts || !si.shifts.length) {
    shiftRowHtml = `<span class="tc-chip-row-empty">Không có ca làm</span>`;
  }

  // ROW 3: Free-time / off-hv / low-density built as SUB-SECTIONS nested inside the Ca làm column
  // (they all describe what's happening INSIDE the shift, so logically belong under Ca làm)
  let freetimeSubsectionHtml = '';
  let offhvSubsectionHtml = '';
  let lowdenSubsectionHtml = '';

  if (isTTKB && gapData.length > 0) {
    let pills = '';
    let freeTotalMin = 0;
    for (const g of gapData) {
      freeTotalMin += g.minutes;
      pills += `<span class="tc-freetime-pill" title="GV trống ${g.minutes} phút"><i class="fa-regular fa-clock"></i> ${minToTime(g.start)}–${minToTime(g.end)} <span class="tc-freetime-pill-dur">${g.minutes}p</span></span>`;
    }
    freetimeSubsectionHtml = `<div class="tc-wc-subsection tc-wc-sub-free">
      <div class="tc-wc-sub-head">
        <span class="tc-wc-sub-icon"><i class="fa-regular fa-clock"></i></span>
        <span class="tc-wc-sub-title">Trống HV trong ca</span>
        <span class="tc-wc-sub-total">${fmtDuration(freeTotalMin)}</span>
      </div>
      <div class="tc-wc-sub-body">${pills}</div>
    </div>`;
  } else if (isTTKB && ttkbStudents.length > 0 && si.shifts && si.shifts.length > 0) {
    freetimeSubsectionHtml = `<div class="tc-wc-subsection tc-wc-sub-free tc-wc-sub-done">
      <div class="tc-wc-sub-head">
        <span class="tc-wc-sub-icon"><i class="fa-solid fa-check-double"></i></span>
        <span class="tc-wc-sub-title">Trống HV trong ca</span>
        <span class="tc-wc-sub-total tc-wc-sub-total-zero">Kín lịch · 0p</span>
      </div>
    </div>`;
  }

  // Off-students sub-section
  const offTtkbStudents = si.off_ttkb_students || [];
  const offBreakoutStudents = si.off_breakout_students || [];
  const offTtkbTotal = si.off_ttkb_occupied || 0;
  const offBreakoutTotal = si.off_breakout_occupied || 0;
  const offTotalMin = offTtkbTotal + offBreakoutTotal;
  if (offTtkbStudents.length + offBreakoutStudents.length > 0) {
    let offPills = '';
    const allOff = [
      ...offTtkbStudents.map(s => ({ ...s, _kind: 'TTKB' })),
      ...offBreakoutStudents.map(s => ({ ...s, _kind: 'BR' }))
    ].sort((a, b) => (a.time_local || '').localeCompare(b.time_local || ''));
    for (const s of allOff) {
      const kindLabel = s._kind === 'TTKB' ? 'TTKB' : 'Breakout';
      offPills += `<span class="tc-offhv-pill" title="${escHtml(s.student_name)} (${kindLabel}) nghỉ — giải phóng ${s.session_minutes} phút"><i class="fa-solid fa-bed"></i> ${fmtTime(s.time_local)} · ${escHtml(s.student_name)} <span class="tc-offhv-pill-dur">${s.session_minutes}p</span></span>`;
    }
    offhvSubsectionHtml = `<div class="tc-wc-subsection tc-wc-sub-offhv">
      <div class="tc-wc-sub-head">
        <span class="tc-wc-sub-icon"><i class="fa-solid fa-bed"></i></span>
        <span class="tc-wc-sub-title">HV nghỉ trong ngày</span>
        <span class="tc-wc-sub-total">${fmtDuration(offTotalMin)}</span>
      </div>
      <div class="tc-wc-sub-body">${offPills}</div>
    </div>`;
  }

  // Breakout low density sub-section
  if (isBreakout && lowDensityData.length > 0) {
    let pills = '';
    let lowTotalMin = 0;
    for (const g of lowDensityData) {
      lowTotalMin += g.minutes;
      const label = g.count === 0 ? 'Không HV' : '1 HV';
      pills += `<span class="tc-lowden-pill" title="Khung ${label}: ${g.minutes} phút"><i class="fa-solid fa-user-minus"></i> ${minToTime(g.start)}–${minToTime(g.end)} <span class="tc-lowden-pill-dur">${g.minutes}p · ${label}</span></span>`;
    }
    lowdenSubsectionHtml = `<div class="tc-wc-subsection tc-wc-sub-lowden">
      <div class="tc-wc-sub-head">
        <span class="tc-wc-sub-icon"><i class="fa-solid fa-user-minus"></i></span>
        <span class="tc-wc-sub-title">Ít HV (Breakout)</span>
        <span class="tc-wc-sub-total">${fmtDuration(lowTotalMin)}</span>
      </div>
      <div class="tc-wc-sub-body">${pills}</div>
    </div>`;
  }

  // ===== Build unified work card — Ca làm + Có thể nhận thêm giờ làm =====
  const _hasAvail = (t.dayRanges || []).length > 0;
  const _hasShifts = (si.shifts || []).length > 0;

  // Shift body (uses existing tc-shift-chip styling)
  let _shiftBodyHtml = '';
  if (_hasShifts) {
    for (const s of si.shifts) {
      const dur = timeToMin(s.end_time) - timeToMin(s.start_time);
      const shiftDept = deptStyle(s.department);
      _shiftBodyHtml += `<span class="tc-shift-chip" style="background:${shiftDept.barBg};" title="Ca ${shiftDept.label}: ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} (${fmtDuration(dur)})">${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · ${shiftDept.label} <span class="tc-shift-chip-dur">${fmtDuration(dur)}</span></span>`;
    }
  } else {
    _shiftBodyHtml = `<span class="tc-wc-body-empty"><i class="fa-regular fa-circle"></i> Không có ca làm</span>`;
  }

  // Canmore body
  let _canmoreBodyHtml = '';
  if (_hasAvail && _hasShifts) {
    if (canMoreIntervals.length > 0) {
      for (const [s, e] of canMoreIntervals) {
        const dur = e - s;
        _canmoreBodyHtml += `<span class="tc-canmore-pill" title="Có thể nhận thêm việc: ${dur} phút"><i class="fa-solid fa-circle-plus"></i> ${minToTime(s)}–${minToTime(e)} <span class="tc-canmore-pill-dur">${fmtDuration(dur)}</span></span>`;
      }
    } else {
      _canmoreBodyHtml = `<span class="tc-wc-body-empty"><i class="fa-solid fa-check-double" style="color:#22c55e;"></i> Đã xếp đủ khả dụng</span>`;
    }
  } else if (!_hasAvail && _hasShifts) {
    _canmoreBodyHtml = `<span class="tc-wc-body-empty"><i class="fa-solid fa-circle-question"></i> GV chưa đăng ký khả dụng — không thể tính</span>`;
  }

  // Compose the work card
  // Only show the canmore sub-section when teacher has shifts (otherwise it would be weird)
  let workCardHtml = '';
  if (_hasShifts) {
    const _shiftTotalBadge = `<span class="tc-wc-total">${fmtDuration(shiftMins)}</span>`;
    const _canmoreTotalBadge = (_hasAvail) ? `<span class="tc-wc-total">${fmtDuration(canMoreTotalMin)}</span>` : '';

    // Collect ALL sub-sections (Trống HV trong ca / HV nghỉ trong ngày / Ít HV Breakout)
    // and render them as a FULL-WIDTH row spanning both columns
    const allSubsections = [];
    if (freetimeSubsectionHtml) allSubsections.push(freetimeSubsectionHtml);
    if (offhvSubsectionHtml) allSubsections.push(offhvSubsectionHtml);
    if (lowdenSubsectionHtml) allSubsections.push(lowdenSubsectionHtml);
    const subGridHtml = allSubsections.length > 0
      ? `<div class="tc-wc-sub-grid">${allSubsections.join('')}</div>`
      : '';

    const _workCardCls = _canmoreBodyHtml ? 'tc-work-card' : 'tc-work-card tc-work-card-no-canmore';

    workCardHtml = `<div class="tc-track-line tc-track-line-workcard">
      <div class="${_workCardCls}">
        <div class="tc-wc-sub tc-wc-shift">
          <div class="tc-wc-head">
            <span class="tc-wc-icon"><i class="fa-solid fa-briefcase"></i></span>
            <span class="tc-wc-title">Ca làm</span>
            ${_shiftTotalBadge}
          </div>
          <div class="tc-wc-body">${_shiftBodyHtml}</div>
        </div>
        ${_canmoreBodyHtml ? `<div class="tc-wc-sub tc-wc-canmore">
          <div class="tc-wc-head">
            <span class="tc-wc-icon"><i class="fa-solid fa-circle-plus"></i></span>
            <span class="tc-wc-title">Có thể nhận thêm giờ làm</span>
            ${_canmoreTotalBadge}
          </div>
          <div class="tc-wc-body">${_canmoreBodyHtml}</div>
        </div>` : ''}
      </div>
    </div>
    ${subGridHtml}`;
  }

  // Totals shown inside each track label so totals are visible at a glance
  const availTotalMin = t.dayRanges.reduce((s, r) => s + (timeToMin(r.time_end) - timeToMin(r.time_start)), 0);
  const shiftTotalMin = si.total_work_minutes || 0;
  const availTotalHtml = availTotalMin > 0
    ? `<span class="tc-track-label-total">${fmtDuration(availTotalMin)}</span>`
    : `<span class="tc-track-label-total-empty">—</span>`;
  const shiftTotalHtml = shiftTotalMin > 0
    ? `<span class="tc-track-label-total">${fmtDuration(shiftTotalMin)}</span>`
    : `<span class="tc-track-label-total-empty">—</span>`;

  const barsHtml = `
    <div class="tc-track-line">
      <span class="tc-track-label tc-track-label-avail">
        <span class="tc-track-label-name">Lịch GV cung cấp</span>
        ${availTotalHtml}
      </span>
      <div class="tc-chip-row">${availRowHtml}</div>
    </div>
    ${workCardHtml}
  `;

  // Detail panel (expandable)
  let detailHtml = '';
  if (isExpanded) {
    detailHtml = renderDetailPanel(t, si, gapData, lowDensityData, isTTKB, isBreakout);
  }

  return `<div class="tc-teacher-row-wrap ${isExpanded ? 'expanded' : ''}">
    <div class="tc-timeline-row" onclick="toggleTeacherDetail('${escHtml(t.emailLower)}')">
      <div class="tc-timeline-name-col">
        <div class="tc-teacher-avatar" style="background:${ds.barBg};">${escHtml(initial)}</div>
        <div class="tc-teacher-info">
          <div class="tc-teacher-name">${escHtml(t.name)}</div>
          <div class="tc-teacher-meta">
            ${deptLabels}
            ${ttkbStudents.length > 0 ? `<span class="tc-meta-pill-lg tc-meta-hv-lg" title="Số học viên TTKB"><i class="fa-solid fa-user-graduate"></i> <strong>${ttkbStudents.length}</strong> TTKB</span>` : ''}
            ${breakoutStudents.length > 0 ? `<span class="tc-meta-pill-lg tc-meta-bo-lg" title="Số học viên Breakout"><i class="fa-solid fa-users"></i> <strong>${breakoutStudents.length}</strong> Breakout</span>` : ''}
          </div>
          <div class="tc-teacher-status-row">
            ${comparisonHtml}
            ${isTTKB && totalGapMins === 0 && ttkbStudents.length > 0 ? `<span class="tc-compare-pill tc-compare-full"><i class="fa-solid fa-check-double"></i> Kín lịch</span>` : ''}
            ${isBreakout && totalLowDensityMins > 0 ? `<span class="tc-compare-pill tc-compare-lowden"><i class="fa-solid fa-user-minus"></i> Ít HV ${fmtDuration(totalLowDensityMins)}</span>` : ''}
          </div>
        </div>
        <div class="tc-row-expand-icon"><i class="fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}"></i></div>
      </div>
      <div class="tc-timeline-bar-col">
        <div class="tc-multi-track">
          ${barsHtml}
        </div>
      </div>
    </div>
    ${detailHtml}
  </div>`;
}

/* ========== Render availability-only row (no shift) ========== */

function renderAvailOnlyRow(t, minTime, totalRange) {
  const initial = (t.name || '?').charAt(0).toUpperCase();
  const availMins = t.dayRanges.reduce((s, r) => s + timeToMin(r.time_end) - timeToMin(r.time_start), 0);

  let availRowHtml = '';
  for (const r of t.dayRanges) {
    availRowHtml += `<span class="tc-avail-chip" title="Khả dụng: ${fmtTime(r.time_start)}–${fmtTime(r.time_end)}">${fmtTime(r.time_start)}–${fmtTime(r.time_end)}</span>`;
  }
  if (!t.dayRanges.length) {
    availRowHtml = `<span class="tc-chip-row-empty">Chưa đăng ký khả dụng</span>`;
  }

  // Totals for avail-only row labels
  const availTotalMin2 = t.dayRanges.reduce((s, r) => s + (timeToMin(r.time_end) - timeToMin(r.time_start)), 0);
  const availTotalHtml2 = availTotalMin2 > 0
    ? `<span class="tc-track-label-total">${fmtDuration(availTotalMin2)}</span>`
    : `<span class="tc-track-label-total-empty">—</span>`;

  const barsHtml = `
    <div class="tc-track-line">
      <span class="tc-track-label tc-track-label-avail">
        <span class="tc-track-label-name">Lịch GV cung cấp</span>
        ${availTotalHtml2}
      </span>
      <div class="tc-chip-row">${availRowHtml}</div>
    </div>
    <div class="tc-track-line">
      <span class="tc-track-label tc-track-label-shift tc-track-label-off">
        <span class="tc-track-label-name">Ca làm</span>
        <span class="tc-track-label-total-empty">—</span>
      </span>
      <div class="tc-chip-row"><span class="tc-chip-row-empty">Không có ca làm</span></div>
    </div>
  `;

  return `<div class="tc-timeline-row tc-row-dimmed">
    <div class="tc-timeline-name-col">
      <div class="tc-teacher-avatar" style="background:#94a3b8;">${escHtml(initial)}</div>
      <div class="tc-teacher-info">
        <div class="tc-teacher-name">${escHtml(t.name)}</div>
        <div class="tc-teacher-meta">
          <span class="tc-compare-pill tc-compare-none"><i class="fa-solid fa-moon"></i> Không có ca</span>
        </div>
      </div>
    </div>
    <div class="tc-timeline-bar-col">
      <div class="tc-multi-track">${barsHtml}</div>
    </div>
  </div>`;
}

/* ========== Render detail panel (expanded) ========== */

function renderDetailPanel(t, si, gapData, lowDensityData, isTTKB, isBreakout) {
  const ttkbStudents = si.ttkb_students || [];
  const breakoutStudents = si.breakout_students || [];
  const shifts = si.shifts || [];
  const availMins = t.dayRanges.reduce((s, r) => s + timeToMin(r.time_end) - timeToMin(r.time_start), 0);
  const shiftMins = si.total_work_minutes || 0;

  let html = `<div class="tc-detail-panel">`;

  // ===== Student lists only (summary + gap details are shown in the top cards) =====

  // Student list — TTKB
  if (ttkbStudents.length > 0) {
    const ttkbTotalMin = ttkbStudents.reduce((s, x) => s + (x.session_minutes || 0), 0);
    html += `<div class="tc-dsc tc-dsc-ttkb">
      <div class="tc-dsc-header">
        <div class="tc-dsc-icon"><i class="fa-solid fa-chalkboard-user"></i></div>
        <div class="tc-dsc-title">Học viên TTKB</div>
        <div class="tc-dsc-count">${ttkbStudents.length} HV • ${fmtDuration(ttkbTotalMin)}</div>
      </div>
      <div class="tc-dsc-body">
        <div class="tc-detail-student-list">`;
    const sortedTtkb = [...ttkbStudents].sort((a, b) => timeToMin(a.time_local) - timeToMin(b.time_local));
    for (const s of sortedTtkb) {
      html += `<div class="tc-detail-student">
        <span class="tc-detail-student-time">${fmtTime(s.time_local)}</span>
        <span class="tc-detail-student-name">${escHtml(s.student_name)}</span>
        <span class="tc-detail-student-dur">${s.session_minutes}p</span>
        ${s.level ? `<span class="tc-detail-student-level">${escHtml(s.level)}</span>` : ''}
        ${s.buoi_phu ? `<span class="tc-detail-student-bp">Phụ</span>` : ''}
      </div>`;
    }
    html += `</div></div></div>`;
  }

  if (breakoutStudents.length > 0) {
    const boTotalMin = breakoutStudents.reduce((s, x) => s + (x.session_minutes || 0), 0);
    html += `<div class="tc-dsc tc-dsc-breakout">
      <div class="tc-dsc-header">
        <div class="tc-dsc-icon"><i class="fa-solid fa-users"></i></div>
        <div class="tc-dsc-title">Học viên Breakout</div>
        <div class="tc-dsc-count">${breakoutStudents.length} HV • ${fmtDuration(boTotalMin)}</div>
      </div>
      <div class="tc-dsc-body">
        <div class="tc-detail-student-list">`;
    const sortedBo = [...breakoutStudents].sort((a, b) => timeToMin(a.time_local) - timeToMin(b.time_local));
    for (const s of sortedBo) {
      html += `<div class="tc-detail-student">
        <span class="tc-detail-student-time">${fmtTime(s.time_local)}</span>
        <span class="tc-detail-student-name">${escHtml(s.student_name)}</span>
        <span class="tc-detail-student-dur">${s.session_minutes}p</span>
        ${s.level ? `<span class="tc-detail-student-level">${escHtml(s.level)}</span>` : ''}
        ${s.buoi_phu ? `<span class="tc-detail-student-bp">Phụ</span>` : ''}
      </div>`;
    }
    html += `</div></div></div>`;
  }

  // No students
  if (ttkbStudents.length === 0 && breakoutStudents.length === 0) {
    html += `<div class="tc-dsc tc-dsc-empty">
      <div class="tc-dsc-header">
        <div class="tc-dsc-icon"><i class="fa-solid fa-ghost"></i></div>
        <div class="tc-dsc-title">Không có học viên nào trong ca làm này</div>
      </div>
    </div>`;
  }

  html += `</div>`; // end detail-panel
  return html;
}

/* ========== Shift badge HTML helper (used by By Teacher view) ========== */

function renderShiftBadge(shiftInfo) {
  if (!shiftInfo) {
    return `<span class="tc-shift-badge tc-shift-none"><i class="fa-solid fa-moon"></i> Không có ca</span>`;
  }

  const { shifts, departments, total_work_minutes, ttkb_count, breakout_count, total_students } = shiftInfo;

  let html = '';
  for (const dept of departments) {
    const ds = deptStyle(dept);
    html += `<span class="tc-dept-badge" style="background:${ds.bg};color:${ds.text};">${escHtml(ds.label)}</span>`;
  }
  for (const s of shifts) {
    html += `<span class="tc-shift-time">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</span>`;
  }
  if (total_students > 0) {
    let studentParts = [];
    if (ttkb_count > 0) studentParts.push(`${ttkb_count} TTKB`);
    if (breakout_count > 0) studentParts.push(`${breakout_count} BO`);
    html += `<span class="tc-shift-students"><i class="fa-solid fa-user-graduate"></i> ${total_students} HV${studentParts.length > 1 ? ` (${studentParts.join(', ')})` : ''}</span>`;
  }

  return html;
}

/* ========== Compact shift indicator for By Teacher view ========== */

function renderShiftIndicator(shiftInfo) {
  if (!shiftInfo) {
    return `<span class="tc-shift-badge tc-shift-none"><i class="fa-solid fa-moon"></i> Không có ca</span>`;
  }

  const { departments, total_students, ttkb_count, breakout_count } = shiftInfo;

  let html = `<span class="tc-shift-badge tc-shift-active"><i class="fa-solid fa-briefcase"></i> Ca làm</span>`;

  for (const dept of departments) {
    const ds = deptStyle(dept);
    html += `<span class="tc-dept-badge" style="background:${ds.bg};color:${ds.text};">${escHtml(ds.label)}</span>`;
  }

  if (total_students > 0) {
    let studentParts = [];
    if (ttkb_count > 0) studentParts.push(`${ttkb_count} TTKB`);
    if (breakout_count > 0) studentParts.push(`${breakout_count} BO`);
    html += `<span class="tc-shift-students"><i class="fa-solid fa-user-graduate"></i> ${total_students} HV${studentParts.length > 1 ? ` (${studentParts.join(', ')})` : ''}</span>`;
  }

  return html;
}

/* ========== By Teacher view (kept from original, with shift integration) ========== */

function renderByTeacher(teacherList, studentCountMap, weekDates, shiftLookup) {
  if (!teacherList.length) {
    return `<div class="tc-empty"><i class="fa-solid fa-user-xmark"></i> Không có giáo viên nào</div>`;
  }

  let html = '';
  teacherList.forEach((t, idx) => {
    const color = teacherColor(idx);
    const initial = (t.name || '?').charAt(0).toUpperCase();

    const totalMins = t.ranges.reduce((s, r) => s + timeToMin(r.time_end) - timeToMin(r.time_start), 0);
    const totalStudents = DOW_ORDER.reduce((s, d) => s + (studentCountMap[`${t.email}|${d}`] || 0), 0);
    const totalHours = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    const durStr = totalHours > 0 ? `${totalHours}h${remMins > 0 ? remMins + 'p' : ''}` : `${remMins}p`;

    let totalWorktimeStudents = 0;
    for (const dow of DOW_ORDER) {
      const sk = `${t.email.toLowerCase()}|${dow}`;
      if (shiftLookup[sk]) totalWorktimeStudents += shiftLookup[sk].total_students;
    }

    let dayGrid = '';
    for (const dow of DOW_ORDER) {
      const dayRanges = t.ranges
        .filter(r => Number(r.day_of_week) === dow)
        .sort((a, b) => timeToMin(a.time_start) - timeToMin(b.time_start));

      const isSelected = dow === tcSelectedDow;
      const isToday = dow === getTodayDow();
      const studentCount = studentCountMap[`${t.email}|${dow}`] || 0;
      const shiftInfo = shiftLookup[`${t.email.toLowerCase()}|${dow}`] || null;

      if (dayRanges.length) {
        const dayMins = dayRanges.reduce((s, r) => s + timeToMin(r.time_end) - timeToMin(r.time_start), 0);
        const dH = Math.floor(dayMins / 60);
        const dM = dayMins % 60;
        const dStr = dH > 0 ? `${dH}h${dM > 0 ? dM : ''}` : `${dM}p`;

        dayGrid += `<div class="tc-week-cell has-data ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" onclick="tcSelectedDow=${dow};render();">
          <div class="tc-week-day">${DOW_NAMES[dow]}</div>
          <div class="tc-week-ranges">`;

        for (const r of dayRanges) {
          dayGrid += `<div class="tc-week-range" style="background:${color.bg};color:${color.text};border-color:${color.border};">
            ${fmtTime(r.time_start)}–${fmtTime(r.time_end)}
          </div>`;
        }

        dayGrid += `</div>`;

        if (tcWorktimeData) {
          if (shiftInfo) {
            const deptLabels = (shiftInfo.departments || []).map(d => deptStyle(d).label).join(', ');
            dayGrid += `<div class="tc-week-shift-info">`;
            dayGrid += `<span class="tc-week-shift-on" title="${escHtml(deptLabels)}"><i class="fa-solid fa-briefcase"></i> ${escHtml(deptLabels || 'Ca làm')}</span>`;
            if (shiftInfo.total_students > 0) {
              dayGrid += `<span class="tc-week-hv-shift">${shiftInfo.total_students} HV</span>`;
            }
            dayGrid += `</div>`;
          } else {
            dayGrid += `<div class="tc-week-shift-info"><span class="tc-week-shift-off"><i class="fa-solid fa-moon"></i></span></div>`;
          }
        }

        dayGrid += `<div class="tc-week-footer">
            <span class="tc-week-dur">${dStr}</span>
            ${studentCount > 0 ? `<span class="tc-week-hv">${studentCount} HV</span>` : ''}
          </div>
        </div>`;
      } else {
        let shiftCell = '';
        if (tcWorktimeData && shiftInfo) {
          const deptLabels = (shiftInfo.departments || []).map(d => deptStyle(d).label).join(', ');
          shiftCell = `<div class="tc-week-shift-info">
            <span class="tc-week-shift-on" title="${escHtml(deptLabels)}"><i class="fa-solid fa-briefcase"></i> ${escHtml(deptLabels || 'Ca')}</span>
            ${shiftInfo.total_students > 0 ? `<span class="tc-week-hv-shift">${shiftInfo.total_students} HV</span>` : ''}
          </div>`;
        }
        dayGrid += `<div class="tc-week-cell empty ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" onclick="tcSelectedDow=${dow};render();">
          <div class="tc-week-day">${DOW_NAMES[dow]}</div>
          <div class="tc-week-off">—</div>
          ${shiftCell}
        </div>`;
      }
    }

    html += `<div class="tc-teacher-card">
      <div class="tc-card-header">
        <div class="tc-teacher-avatar" style="background:${color.bar};">${escHtml(initial)}</div>
        <div class="tc-card-header-info">
          <div class="tc-teacher-name">${escHtml(t.name)}</div>
          <div class="tc-card-header-email">${escHtml(t.email)}</div>
        </div>
        <div class="tc-card-header-stats">
          <span class="tc-meta-pill" style="background:${color.bg};color:${color.text};border-color:${color.border};">
            <i class="fa-solid fa-clock"></i> ${durStr}/tuần
          </span>
          ${totalStudents > 0 ? `<span class="tc-meta-pill tc-meta-students"><i class="fa-solid fa-user-graduate"></i> ${totalStudents} HV</span>` : ''}
          ${tcWorktimeData && totalWorktimeStudents > 0 ? `<span class="tc-meta-pill tc-meta-shift-total"><i class="fa-solid fa-briefcase"></i> ${totalWorktimeStudents} HV/tuần</span>` : ''}
        </div>
      </div>
      <div class="tc-week-grid">${dayGrid}</div>
    </div>`;
  });

  return html;
}

/* ========== Boot ========== */

document.addEventListener('DOMContentLoaded', () => {
  // Restore collapsed state
  if (localStorage.getItem('tansinh-sidebar-collapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
  }

  // Sidebar toggle (mobile)
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebarNav')?.classList.toggle('open');
    document.getElementById('sidebarOverlay')?.classList.toggle('open');
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebarNav')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('open');
  });

  // Sidebar collapse (desktop)
  document.getElementById('sidebarCollapseBtn')?.addEventListener('click', () => {
    const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('tansinh-sidebar-collapsed', isCollapsed ? '1' : '0');
  });

  // Fast session check
  const sbUrl = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  if (sbUrl && localStorage.getItem(sbUrl)) {
    document.body.classList.add('has-sidebar');
    const app = document.getElementById('tcApp');
    if (app) app.style.display = 'block';
  }

  initSupabase();
  setupPasswordToggle();
  setupLoginHandler();
});
