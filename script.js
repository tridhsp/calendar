/* -----------------------------------------------------------
   Supabase auth with session persistence across page refresh
   ----------------------------------------------------------- */

let client;

let appStarted = false; // guard so showApp runs once

// Store for level assignments (teacher -> allowed levels)
let levelAssignmentsCache = null;


// use the real table name
const STUDENT_TABLE = 'students';
const TEACHER_TABLE = 'teachers';
const TEACHER_AVAIL_TABLE = 'teacher_availability';

async function initSupabase() {
  const msgEl = document.getElementById('message');

  try {
    // Get credentials from your Netlify function (keeps service key server-only)
    const res = await fetch('/api/cal-supabase-credentials');
    if (!res.ok) throw new Error('Failed to load credentials');
    const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();

    client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: window.localStorage,
        detectSessionInUrl: true
      }
    });

    const { data: { session } } = await client.auth.getSession();
    if (session) {
      showApp(session);
    } else {
      showLogin();
    }

    client.auth.onAuthStateChange((_event, session) => {
      if (session) showApp(session);
      else showLogin();
    });
  } catch (err) {
    console.error(err);
    msgEl.textContent = 'Không thể kết nối Supabase. Vui lòng thử lại sau.';
    showLogin();
  }
}

/* --------------- Toggle password visibility --------------- */
function setupPasswordToggle() {
  const toggle = document.getElementById('togglePwd');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const pwd = document.getElementById('password');
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
  });
}

/* ---------------- Login handler ---------------- */
function setupLoginHandler() {
  const btn = document.getElementById('login');
  if (!btn) return;

  const submit = async () => {
    const msgEl = document.getElementById('message');
    msgEl.textContent = '';

    if (!client) {
      msgEl.textContent = 'Đang kết nối, vui lòng đợi…';
      const _tsWaitStart = Date.now();
      while (!client && Date.now() - _tsWaitStart < 5000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!client) {
        msgEl.textContent = 'Không kết nối được máy chủ, vui lòng tải lại trang.';
        return;
      }
      msgEl.textContent = '';
    }

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      msgEl.textContent = 'Vui lòng điền đầy đủ thông tin.';
      msgEl.className = 'error';
      return;
    }

    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      msgEl.textContent = error.message;
      msgEl.className = 'error';
    } else {
      msgEl.textContent = '';
    }
  };

  btn.addEventListener('click', submit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

/* ---------------- UI helpers ---------------- */
function showApp() {

  if (appStarted) return;
  appStarted = true;

  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'none';

  // App layout + show board
  document.body.classList.add('app-mode');
  document.getElementById('calendarBoard')?.classList.remove('hidden');

  // Render board
  renderCalendarBoard();

  // Ensure logout icon exists
  let btn = document.getElementById('logoutBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'logoutBtn';
    btn.className = 'logout-icon';
    btn.addEventListener('click', async () => {
      await client.auth.signOut();
    });
    btn.innerHTML = '<i class="fa-solid fa-power-off" aria-hidden="true"></i>';
    btn.title = 'Log out';
    btn.setAttribute('aria-label', 'Log out');
    document.body.appendChild(btn);
  }
}

function showLogin() {

  appStarted = false; // allow showApp again after logout

  const card = document.getElementById('loginCard');
  if (card) card.style.display = 'block';

  document.getElementById('calendarBoard')?.classList.add('hidden');
  document.body.classList.remove('app-mode');

  const btn = document.getElementById('logoutBtn');
  if (btn) btn.remove();

  const email = document.getElementById('email');
  if (email) email.focus();
}




/* ---------------- Calendar popup & scheduling ---------------- */
function setupCalendarUI() {
  // FAB
  const fab = document.getElementById('openCalendarBtn');
  if (fab) fab.addEventListener('click', openCalendarModal);

  // Modal controls
  const modal = document.getElementById('calendarModal');
  const closeBtn = document.getElementById('calCloseBtn');
  const cancelBtn = document.getElementById('calCancelBtn');
  const addRowBtn = document.getElementById('addRowBtn');
  const saveBtn = document.getElementById('calSaveBtn');

  closeBtn?.addEventListener('click', closeCalendarModal);
  cancelBtn?.addEventListener('click', closeCalendarModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeCalendarModal();
  });

  addRowBtn?.addEventListener('click', () => addScheduleRow());
  saveBtn?.addEventListener('click', saveSchedule);

  // Initialize typeahead for Student input
  setupStudentTypeahead();
}


/* -------- Typeahead for Student: user_roles.full_name (1s debounce) -------- */
let studentTypeTimer;

function setupStudentTypeahead() {
  const input = document.getElementById('studentNameInput');
  const list = document.getElementById('studentNameSuggestions');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    clearTimeout(studentTypeTimer);

    const q = input.value.trim();
    delete input.dataset.userRoleUid; // reset selected link
    delete input.dataset.userRoleEmail; // also clear selected email while typing

    const st = document.getElementById('studentStatusInput');
    if (st) st.value = '';



    if (q.length < 4) {
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    // Debounce: 1 second after user stops typing
    studentTypeTimer = setTimeout(async () => {
      if (!client) return;
      try {
        // NEW CODE (server call instead of direct Supabase query)
        const res = await fetch('/api/cal-search-students', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q })
        });
        const { ok, rows, error } = await res.json();
        if (!res.ok || !ok) throw new Error(error || 'Search failed');
        const data = rows;


        if (!data || data.length === 0) {
          list.innerHTML = '<div class="empty">No matches</div>';
          list.classList.remove('hidden');
          return;
        }

        list.innerHTML = (data?.length ? data : []).map(r => `
  <button type="button" class="suggestion"
    data-email="${escapeHtml(r.email || '')}"
    data-status="${r.status ?? ''}">
    ${escapeHtml(r.email || '')}
  </button>
`).join('') || '<div class="empty">No matches</div>';



        list.classList.remove('hidden');
      } catch (e) {
        console.error('Typeahead error:', e);
      }
    }, 1000);
  });

  // Choose a suggestion
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button.suggestion');
    if (!btn) return;
    input.value = btn.dataset.email || '';
    input.dataset.userRoleEmail = btn.dataset.email || '';

    const statusInput = document.getElementById('studentStatusInput');
    if (statusInput) statusInput.value = btn.dataset.status ?? '';

    list.classList.add('hidden');
    list.innerHTML = '';

  });


  // Click-away to close suggestions
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) {
      list.classList.add('hidden');
    }
  }, { capture: true });
}



function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}


function openCalendarModal() {
  const modal = document.getElementById('calendarModal');
  modal.hidden = false;
  clearStudentSelection();
  resetScheduleRows();
  addScheduleRow(); // at least one row
}


async function openStudentEditorByEmail(email = '') {
  try {
    const modal = document.getElementById('calendarModal');
    modal.hidden = false;

    const nameInput = document.getElementById('studentNameInput');
    const statusInput = document.getElementById('studentStatusInput');
    if (nameInput) {
      nameInput.value = email || '';
      nameInput.dataset.userRoleEmail = email || '';
    }

    const rsp = await fetch('/api/load-student-editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const out = await rsp.json();
    if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Load failed');

    if (statusInput) statusInput.value = out.status === '' ? '' : String(out.status);

    resetScheduleRows();
    const scheds = out.schedules || [];
    if (scheds.length) {
      for (const r of scheds) addScheduleRow(r);
    } else {
      addScheduleRow();
    }
  } catch (e) {
    console.error(e);
    alert('Could not open editor. Check console.');
  }
}



function clearStudentSelection() {
  const input = document.getElementById('studentNameInput');
  const list = document.getElementById('studentNameSuggestions');
  const status = document.getElementById('studentStatusInput');
  if (input) {
    input.value = '';
    delete input.dataset.userRoleUid; // clear last selected suggestion

    delete input.dataset.userRoleEmail; // NEW: also clear stored email on new typing

    const st = document.getElementById('studentStatusInput');
    if (st) st.value = '';


  }
  if (status) {
    status.value = '';
  }
  if (list) {
    list.classList.add('hidden');
    list.innerHTML = '';
  }
}



function closeCalendarModal() {
  const modal = document.getElementById('calendarModal');
  modal.hidden = true;

  const list = document.getElementById('studentNameSuggestions');
  if (list) {
    list.classList.add('hidden');
    list.innerHTML = '';
  }
}




function resetScheduleRows() {
  document.getElementById('scheduleRows').innerHTML = '';
}

// Nice warning popup when a student is set to more than 2 sessions/day.
// Returns a Promise<boolean>: true = keep the number, false = revert.
function confirmDoubleSessions(n) {
  return new Promise((resolve) => {
    const isDouble = (n === 2);
    const accent   = isDouble ? '#2563eb' : '#d97706';
    const accentBg = isDouble ? '#eff6ff' : '#fff7ed';
    const icon     = isDouble ? 'fa-circle-info' : 'fa-triangle-exclamation';
    const title    = isDouble ? 'Đặt gấp đôi buổi cho ngày này?' : 'Số buổi nhiều bất thường';
    const body     = isDouble
      ? 'Bạn đang đặt <b>2 buổi</b> (gấp đôi) cho ngày này. Học viên sẽ được phép báo cáo <b>2 lượt TTKB</b> trong ngày, và <b>cả 2 đều được tính</b> giờ. Bạn có chắc không?'
      : 'Một học viên thường không nên học quá <b>2 buổi/ngày</b>. Bạn có chắc muốn đặt <b>' + n + ' buổi</b> cho ngày này không?';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:4000;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;max-width:440px;width:100%;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,.3);font-family:inherit;text-align:center;';
    box.innerHTML =
      '<div style="width:60px;height:60px;margin:0 auto 16px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:' + accentBg + ';color:' + accent + ';font-size:1.7rem;"><i class="fa-solid ' + icon + '"></i></div>' +
      '<h3 style="margin:0 0 10px;color:#0f172a;font-size:1.2rem;font-weight:800;">' + title + '</h3>' +
      '<p style="margin:0 0 22px;color:#475569;font-size:1rem;line-height:1.6;">' + body + '</p>' +
      '<div style="display:flex;gap:12px;justify-content:center;">' +
        '<button type="button" class="cds-cancel" style="padding:12px 20px;border-radius:12px;border:1px solid #e5e7eb;background:#fff;color:#334155;font-weight:700;font-size:1rem;cursor:pointer;">Quay lại</button>' +
        '<button type="button" class="cds-ok" style="padding:12px 20px;border-radius:12px;border:none;background:' + accent + ';color:#fff;font-weight:800;font-size:1rem;cursor:pointer;">Vẫn tiếp tục</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    box.querySelector('.cds-cancel').addEventListener('click', () => done(false));
    box.querySelector('.cds-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

function addScheduleRow(values = {}) {
  const wrap = document.getElementById('scheduleRows');
  const row = document.createElement('div');
  row.className = 'schedule-row';

  // ----- Day -----
  const day = document.createElement('select');
  day.className = 'day';
  const days = [
    ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'],
    ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']
  ];
  day.innerHTML = days.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (values.day_of_week != null) day.value = String(values.day_of_week);

  // ----- Time: custom picker. A hidden input keeps the HH:MM value so saving is unchanged. -----
  const timeWrap = document.createElement('div');
  timeWrap.className = 'time-wrap';

  const time = document.createElement('input');
  time.type = 'hidden';
  time.className = 'time';
  if (values.time_local) time.value = values.time_local;

  const field = document.createElement('button');
  field.type = 'button';
  field.className = 'time-field' + (values.time_local ? '' : ' empty');
  field.innerHTML = `<i class="fa-solid fa-clock"></i><span class="tf-val">${values.time_local || 'Chọn giờ'}</span>`;

  const pop = document.createElement('div');
  pop.className = 'time-pop';
  pop.hidden = true;

  const hourOpts = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const minOpts = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
  const cur = { h: null, m: null };
  if (values.time_local && /^\d{1,2}:\d{2}$/.test(values.time_local)) {
    const parts = values.time_local.split(':');
    cur.h = String(parts[0]).padStart(2, '0');
    cur.m = String(parts[1]).padStart(2, '0');
  }

  pop.innerHTML = `
    <div class="tp-head">
      <span class="tp-lbl">Chọn giờ</span>
      <span class="tp-disp">${(cur.h != null && cur.m != null) ? (cur.h + ':' + cur.m) : '--:--'}</span>
    </div>
    <div class="tp-cols">
      <div class="tp-col tp-h">
        <div class="tp-cap">Giờ</div>
        ${hourOpts.map(h => `<div class="tp-opt${h === cur.h ? ' sel' : ''}" data-h="${h}">${h}</div>`).join('')}
      </div>
      <div class="tp-col tp-m">
        <div class="tp-cap">Phút</div>
        ${minOpts.map(m => `<div class="tp-opt${m === cur.m ? ' sel' : ''}" data-m="${m}">${m}</div>`).join('')}
      </div>
    </div>
    <div class="tp-actions">
      <button type="button" class="tp-cancel">Hủy</button>
      <button type="button" class="tp-done">Xong</button>
    </div>
  `;

  const disp = pop.querySelector('.tp-disp');

  function refresh() {
    if (cur.h != null && cur.m != null) {
      const v = `${cur.h}:${cur.m}`;
      time.value = v;
      field.querySelector('.tf-val').textContent = v;
      field.classList.remove('empty');
      disp.textContent = v;
    }
  }
  function closePop() { pop.hidden = true; field.classList.remove('open'); }
  function openPop() {
    document.querySelectorAll('#scheduleRows .time-pop').forEach(p => { if (p !== pop) p.hidden = true; });
    document.querySelectorAll('#scheduleRows .time-field.open').forEach(f => { if (f !== field) f.classList.remove('open'); });
    pop.hidden = false;
    field.classList.add('open');
    pop.querySelectorAll('.tp-opt.sel').forEach(o => o.scrollIntoView({ block: 'center' }));
  }

  field.addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden) { openPop(); } else { closePop(); } });
  pop.addEventListener('click', (e) => e.stopPropagation());

  pop.querySelector('.tp-h').addEventListener('click', (e) => {
    const o = e.target.closest('.tp-opt'); if (!o) return;
    pop.querySelectorAll('.tp-h .tp-opt').forEach(x => x.classList.remove('sel'));
    o.classList.add('sel');
    cur.h = o.dataset.h;
    if (cur.m == null) { cur.m = '00'; const m0 = pop.querySelector('.tp-m .tp-opt[data-m="00"]'); if (m0) m0.classList.add('sel'); }
    refresh();
  });
  pop.querySelector('.tp-m').addEventListener('click', (e) => {
    const o = e.target.closest('.tp-opt'); if (!o) return;
    pop.querySelectorAll('.tp-m .tp-opt').forEach(x => x.classList.remove('sel'));
    o.classList.add('sel');
    cur.m = o.dataset.m;
    if (cur.h == null) { cur.h = '08'; const h8 = pop.querySelector('.tp-h .tp-opt[data-h="08"]'); if (h8) h8.classList.add('sel'); }
    refresh();
  });
  pop.querySelector('.tp-done').addEventListener('click', closePop);
  pop.querySelector('.tp-cancel').addEventListener('click', closePop);

  timeWrap.append(time, field, pop);

  // ----- "Buổi phụ" toggle switch -----
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'bp-toggle';
  toggleWrap.innerHTML = `
    <input type="checkbox" class="bp" />
    <span class="bp-switch"></span>
    <span>Buổi phụ</span>
  `;
  if (values.buoi_phu) toggleWrap.querySelector('.bp').checked = true;

  // ----- Remove -----
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
  remove.title = 'Remove';
  remove.addEventListener('click', () => row.remove());

  // NEW: "Số buổi" (sessions per day) — 1 = normal, 2 = double.
  const spdWrap = document.createElement('label');
  spdWrap.className = 'spd-wrap';
  spdWrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;font-weight:600;color:#334155;white-space:nowrap;';
  spdWrap.innerHTML = '<span>Số buổi</span><input type="number" class="spd" min="1" step="1" inputmode="numeric" style="width:52px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;font:inherit;text-align:center;" />';
  const spdInput = spdWrap.querySelector('.spd');
  let prevSpd = Math.max(1, parseInt(values.sessions_per_day, 10) || 1);
  spdInput.value = String(prevSpd);
  spdInput.addEventListener('change', async () => {
    let v = parseInt(spdInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    spdInput.value = String(v);
    if (v >= 2) {
      const ok = await confirmDoubleSessions(v);
      if (!ok) { spdInput.value = String(prevSpd); return; }
    }
    prevSpd = parseInt(spdInput.value, 10) || 1;
  });

  // append: day, time, Buổi phụ, Số buổi, then the trash
  row.append(day, timeWrap, toggleWrap, spdWrap, remove);
  // Keep the whole row on ONE line so the trash icon never wraps below.
  row.style.display = 'flex';
  row.style.flexWrap = 'nowrap';
  row.style.alignItems = 'center';
  row.style.justifyContent = 'flex-start';
  row.style.gap = '10px';
  [day, timeWrap, toggleWrap, spdWrap, remove].forEach(function (el) { el.style.margin = '0'; });
  day.style.flex = '0 1 auto'; day.style.minWidth = '0';
  timeWrap.style.flex = '0 1 auto'; timeWrap.style.minWidth = '0';
  toggleWrap.style.flex = '0 0 auto';
  spdWrap.style.flex = '0 0 auto';
  remove.style.flex = '0 0 auto';
  wrap.appendChild(row);

  // Close any open time picker when clicking elsewhere (registered once).
  if (!window.__schedTimePickerOutside) {
    window.__schedTimePickerOutside = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('#scheduleRows .time-pop:not([hidden])').forEach(p => { p.hidden = true; });
      document.querySelectorAll('#scheduleRows .time-field.open').forEach(f => f.classList.remove('open'));
    });
  }
}

async function saveSchedule() {
  const nameInput = document.getElementById('studentNameInput');
  const statusInput = document.getElementById('studentStatusInput');

  // Student email typed or picked from suggestions
  const studentEmail = (nameInput?.dataset?.userRoleEmail || nameInput?.value || '').trim();
  const statusVal = statusInput?.value === '' ? null : Number(statusInput.value);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  if (!studentEmail) { alert('Please pick a student email.'); return; }

  // Collect desired rows from the modal (same as before)
  const desired = Array.from(document.querySelectorAll('#scheduleRows .schedule-row')).map(r => {
    const day = parseInt(r.querySelector('.day').value, 10);
    const time = r.querySelector('.time').value;
    const bp = !!r.querySelector('.bp')?.checked;
    const spd = Math.max(1, parseInt(r.querySelector('.spd')?.value, 10) || 1);
    return time ? { day_of_week: day, time_local: time, buoi_phu: bp, sessions_per_day: spd, timezone: tz } : null;
  }).filter(Boolean);

  if (!desired.length) { alert('Please add at least one day & time.'); return; }

  // ---- Validate MAIN / EXTRA counts against danh_sach_hv (danhsachhv app) ----
  // Counted by SESSION: a day with "So buoi" = 2 counts as 2 sessions, because
  // danh_sach_hv stores buoi_hoc_chinh / buoi_hoc_phu as sessions per week.
  // To count by DAY instead, replace (Number(d.sessions_per_day) || 1) with 1 below.
  const enteredMain  = desired.filter(d => !d.buoi_phu).reduce((n, d) => n + (Number(d.sessions_per_day) || 1), 0);
  const enteredExtra = desired.filter(d =>  d.buoi_phu).reduce((n, d) => n + (Number(d.sessions_per_day) || 1), 0);

  let quota;
  try {
    quota = await fetchStudentQuota(studentEmail);
  } catch (e) {
    console.error('quota fetch failed:', e);
    showQuotaPopup({ mode: 'error' });   // fail-safe: cannot verify -> do not save
    return;
  }

  // Blank in danhsachhv (student missing, or either number not set) -> ask to set first
  if (!quota.found || quota.main === null || quota.extra === null) {
    showQuotaPopup({ mode: 'unset' });
    return;
  }

  // Counts must match exactly
  if (enteredMain !== quota.main || enteredExtra !== quota.extra) {
    showQuotaPopup({
      mode: 'mismatch',
      reqMain: quota.main, reqExtra: quota.extra,
      gotMain: enteredMain, gotExtra: enteredExtra
    });
    return;
  }
  // ---- end validation ----

  try {
    // get the signed-in user id to satisfy NOT NULL created_by
    const { data: { user } } = await client.auth.getUser();
    const currentUserId = user?.id || '';

    const res = await fetch('/api/save-student-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentEmail, statusVal, desired, tz, currentUserId })
    });
    const json = await res.json();

    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || 'Save failed');
    }

    alert(`Saved!
- Timezone fixed: ${json.updatedTz}
- Moved: ${json.moved}
- Inserted: ${json.inserted}
- Deleted: ${json.deleted}`);

    await renderCalendarBoard(true);
    closeCalendarModal();
  } catch (e) {
    console.error(e);
    alert('Save failed. Check console.');
  }
}



/* ---- MAIN/EXTRA session validation helpers (danh_sach_hv) ---- */
async function fetchStudentQuota(email) {
  const res = await fetch('/api/cal-student-quota', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const json = await res.json();
  if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || 'Quota lookup failed');
  return json; // { found, main, extra }
}

function ensureQuotaPopupStyles() {
  if (document.getElementById('sqStyles')) return;
  const st = document.createElement('style');
  st.id = 'sqStyles';
  st.textContent = `
  .sq-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);
    display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;animation:sqFade .15s ease}
  @keyframes sqFade{from{opacity:0}to{opacity:1}}
  .sq-modal{width:100%;max-width:430px;background:#fff;border-radius:16px;overflow:hidden;
    box-shadow:0 24px 60px rgba(2,6,23,.35);font-family:inherit;animation:sqPop .18s cubic-bezier(.2,.8,.2,1)}
  @keyframes sqPop{from{transform:translateY(10px) scale(.98);opacity:0}to{transform:none;opacity:1}}
  .sq-head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid #f1f5f9}
  .sq-ico{flex-shrink:0;width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}
  .sq-ico.warn{background:#fef3c7;color:#d97706}
  .sq-ico.info{background:#e0e7ff;color:#4f46e5}
  .sq-ico.err{background:#fee2e2;color:#dc2626}
  .sq-title{font-size:1.05rem;font-weight:700;color:#0f172a;line-height:1.3}
  .sq-body{padding:18px 20px;color:#334155;font-size:.95rem;line-height:1.55}
  .sq-nums{display:flex;gap:10px;margin:14px 0 0}
  .sq-num{flex:1;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;text-align:center;background:#f8fafc}
  .sq-num .lab{font-size:.72rem;color:#64748b;text-transform:uppercase;letter-spacing:.03em}
  .sq-num .val{font-size:1.5rem;font-weight:800;color:#0f172a;margin-top:2px;line-height:1}
  .sq-num.need{background:#eef2ff;border-color:#c7d2fe}
  .sq-num.bad .val{color:#dc2626}
  .sq-num.ok  .val{color:#16a34a}
  .sq-note{margin-top:14px;font-size:.85rem;color:#64748b}
  .sq-ftr{display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;background:#f8fafc;border-top:1px solid #f1f5f9}
  .sq-btn{border:none;border-radius:10px;padding:9px 16px;font-size:.9rem;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:7px}
  .sq-btn.primary{background:#4f46e5;color:#fff}
  .sq-btn.primary:hover{background:#4338ca}
  .sq-btn.ghost{background:#fff;color:#475569;border:1px solid #e2e8f0}
  .sq-btn.ghost:hover{background:#f1f5f9}
  `;
  document.head.appendChild(st);
}

function showQuotaPopup(opts) {
  ensureQuotaPopupStyles();
  document.getElementById('sqOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'sqOverlay';
  overlay.className = 'sq-overlay';

  let icoClass = 'warn', ico = 'fa-triangle-exclamation', title = '', body = '', extraBtn = '';

  if (opts.mode === 'unset') {
    icoClass = 'info'; ico = 'fa-circle-info';
    title = 'Chưa cài số buổi học';
    body =
      '<div>Học viên này chưa được cài <b>số buổi chính</b> / <b>số buổi phụ</b> trong <b>Danh sách HV</b>.</div>' +
      '<div class="sq-note">Vui lòng vào Danh sách HV cài số buổi chính và buổi phụ cho học viên trước, rồi quay lại tạo lịch.</div>';
    extraBtn =
      '<a class="sq-btn ghost" href="https://danhsachhv.tansinh.info" target="_blank" rel="noopener">' +
      '<i class="fa-solid fa-up-right-from-square"></i> Mở Danh sách HV</a>';
  } else if (opts.mode === 'error') {
    icoClass = 'err'; ico = 'fa-plug-circle-xmark';
    title = 'Không kiểm tra được số buổi';
    body =
      '<div>Không lấy được số buổi chính / phụ của học viên (lỗi kết nối).</div>' +
      '<div class="sq-note">Vui lòng thử lại sau giây lát. Lịch chưa được lưu.</div>';
  } else { // mismatch
    const mainBad = opts.gotMain !== opts.reqMain;
    const extraBad = opts.gotExtra !== opts.reqExtra;
    title = 'Số buổi học chưa khớp';
    body =
      '<div>Học viên này cần <b>' + opts.reqMain + ' buổi chính</b> và <b>' + opts.reqExtra + ' buổi phụ</b> mỗi tuần.</div>' +
      '<div class="sq-nums">' +
        '<div class="sq-num need"><div class="lab">Cần · Chính</div><div class="val">' + opts.reqMain + '</div></div>' +
        '<div class="sq-num need"><div class="lab">Cần · Phụ</div><div class="val">' + opts.reqExtra + '</div></div>' +
      '</div>' +
      '<div class="sq-nums">' +
        '<div class="sq-num ' + (mainBad ? 'bad' : 'ok') + '"><div class="lab">Bạn nhập · Chính</div><div class="val">' + opts.gotMain + '</div></div>' +
        '<div class="sq-num ' + (extraBad ? 'bad' : 'ok') + '"><div class="lab">Bạn nhập · Phụ</div><div class="val">' + opts.gotExtra + '</div></div>' +
      '</div>' +
      '<div class="sq-note">Chỉnh lại lịch cho đúng số buổi (ô \u201CBuổi phụ\u201D = buổi phụ; ô \u201CSố buổi\u201D = 2 được tính là 2 buổi), rồi bấm Lưu lại.</div>';
  }

  overlay.innerHTML =
    '<div class="sq-modal" role="dialog" aria-modal="true" aria-labelledby="sqTitle">' +
      '<div class="sq-head">' +
        '<div class="sq-ico ' + icoClass + '"><i class="fa-solid ' + ico + '"></i></div>' +
        '<div class="sq-title" id="sqTitle">' + title + '</div>' +
      '</div>' +
      '<div class="sq-body">' + body + '</div>' +
      '<div class="sq-ftr">' + extraBtn +
        '<button class="sq-btn primary" data-sq-close>Đã hiểu</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.querySelector('[data-sq-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
}

/* ---------------- Teacher calendar popup & scheduling ---------------- */

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

/* --- Typeahead for Teacher (same source as students) --- */
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
      if (!client) return;
      try {
        // NEW CODE (server call instead of direct Supabase query)
        const res = await fetch('/api/cal-search-teachers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q })
        });
        const { ok, rows, error } = await res.json();
        if (!res.ok || !ok) throw new Error(error || 'Search failed');
        const data = rows;


        list.innerHTML = (data?.length ? data : []).map(r => ` 
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
      }
    }, 1000);
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button.suggestion');
    if (!btn) return;
    input.value = btn.dataset.email;                 // show EMAIL in the box
    input.dataset.userRoleUid = btn.dataset.uid;
    input.dataset.userRoleEmail = btn.dataset.email; // keep email for saving
    list.classList.add('hidden'); list.innerHTML = '';
  });




  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) {
      list.classList.add('hidden');
    }
  }, { capture: true });
}

function openTeacherModal() {
  const modal = document.getElementById('teacherCalendarModal');
  modal.hidden = false;
  clearTeacherSelection();
  resetTeacherRows();
  addTeacherRow(); // at least one range
}

function closeTeacherModal() {
  const modal = document.getElementById('teacherCalendarModal');
  modal.hidden = true;
  const list = document.getElementById('teacherNameSuggestions');
  if (list) { list.classList.add('hidden'); list.innerHTML = ''; }
}

function clearTeacherSelection() {
  const input = document.getElementById('teacherNameInput');
  const list = document.getElementById('teacherNameSuggestions');
  if (input) {
    input.value = '';
    delete input.dataset.userRoleUid;
    delete input.dataset.userRoleEmail; // clear stored email
  }
  if (list) { list.classList.add('hidden'); list.innerHTML = ''; }
}




function resetTeacherRows() {
  document.getElementById('teacherScheduleRows').innerHTML = '';
}

function addTeacherRow(values = {}) {
  const wrap = document.getElementById('teacherScheduleRows');
  const row = document.createElement('div');
  row.className = 'range-row';

  const day = document.createElement('select');
  day.className = 'day';
  const days = [
    ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'],
    ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']
  ];
  day.innerHTML = days.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (values.day_of_week != null) day.value = String(values.day_of_week);

  const start = document.createElement('input');
  start.className = 'start'; start.type = 'time'; start.step = 60;
  if (values.time_start) start.value = values.time_start;

  const end = document.createElement('input');
  end.className = 'end'; end.type = 'time'; end.step = 60;
  if (values.time_end) end.value = values.time_end;

  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'remove';
  remove.innerHTML = '<i class="fa-solid fa-trash"></i>'; remove.title = 'Remove';
  remove.addEventListener('click', () => row.remove());

  row.append(day, start, end, remove);
  wrap.appendChild(row);
}

async function saveTeacherSchedule() {
  const nameInput = document.getElementById('teacherNameInput');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';

  // Resolve EMAIL (typed or selected)
  let teacherEmail = (nameInput?.dataset?.userRoleEmail || nameInput?.value || '').trim();
  if (!teacherEmail && nameInput?.dataset?.userRoleUid) {
    const { data: urEmail } = await client.from('user_roles').select('email').eq('uid', nameInput.dataset.userRoleUid).maybeSingle();
    teacherEmail = urEmail?.email || '';
  }
  if (!teacherEmail) { alert('Please pick a teacher by email from the suggestions.'); return; }

  // collect ranges
  const ranges = Array.from(document.querySelectorAll('#teacherScheduleRows .range-row')).map(r => {
    const day = parseInt(r.querySelector('.day').value, 10);
    const start = r.querySelector('.start').value;
    const end = r.querySelector('.end').value;
    return { day_of_week: day, time_start: start, time_end: end, timezone: tz };
  }).filter(r => r.time_start && r.time_end);

  if (!ranges.length) { alert('Please add at least one time range.'); return; }

  try {
    const { data: { user } } = await client.auth.getUser();
    const rsp = await fetch('/api/save-teacher-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacherEmail,
        ranges,
        currentUserId: user?.id || null,
        runReassign: true
      })
    });
    const out = await rsp.json();
    if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Save failed');

    alert(
      `Teacher schedule saved!\n` +
      `Inserted ${out.inserted} range(s)\n` +
      `Reassigned ${out.changed || 0} session(s)` +
      (out.unmapped ? `; ${out.unmapped} had no available teacher` : ``)
    );

    closeTeacherModal();
    renderCalendarBoard(true);
  } catch (e) {
    alert('Save failed. Check console.');
    console.error(e);
  }
}


/* ---------------- Board: load & render ---------------- */
let boardCache = null;            // cache last fetch

let boardLoadPromise = null; // in-flight load guard

let boardView = 'student';        // 'student' | 'day'
let boardTeacherFilter = '';      // '' = all teachers
let boardFilterBreakoutOnly = false; // when true, filter by breakout_email

let boardTeacherFilterLabel = ''; // text of the selected option (name/email)
let boardStudentFilter = '';      // '' = no student-name filter




function setupBoardUI() {
  document.getElementById('viewByStudent')?.addEventListener('click', () => {
    boardView = 'student';
    document.getElementById('viewByStudent')?.classList.add('active');
    document.getElementById('viewByDay')?.classList.remove('active');
    renderCalendarBoard(false);
  });
  document.getElementById('viewByDay')?.addEventListener('click', () => {
    boardView = 'day';
    document.getElementById('viewByDay')?.classList.add('active');
    document.getElementById('viewByStudent')?.classList.remove('active');
    renderCalendarBoard(false);
  });
  document.getElementById('refreshBoard')?.addEventListener('click', () => renderCalendarBoard(true));

  document.getElementById('teacherFilter')?.addEventListener('change', (e) => {
    boardTeacherFilter = e.target.value || '';
    const opt = e.target.options[e.target.selectedIndex];
    boardTeacherFilterLabel = opt ? (opt.text || '') : '';
    renderCalendarBoard(false);
  });




  const filterInput = document.getElementById('studentFilter');
  const clearBtn = document.getElementById('clearStudentFilter');
  const searchWrapper = filterInput?.parentElement;
  const filterBar = document.getElementById('filterBar');
  const clearAllBtn = document.getElementById('clearAllFilters');

  // Helper to update filter bar state
  function updateFilterBarState() {
    const hasFilters = boardTeacherFilter || boardStudentFilter;
    filterBar?.classList.toggle('has-filters', hasFilters);
  }

  // Helper to update search wrapper state
  function updateSearchState() {
    const hasValue = filterInput && filterInput.value.trim();
    searchWrapper?.classList.toggle('has-value', !!hasValue);
  }

  // Student search input
  filterInput?.addEventListener('input', (e) => {
    boardStudentFilter = (e.target.value || '').trim().toLowerCase();
    updateSearchState();
    updateFilterBarState();
    renderCalendarBoard(false);
  });

  // Clear single search
  clearBtn?.addEventListener('click', () => {
    if (filterInput) {
      filterInput.value = '';
      filterInput.focus();
    }
    boardStudentFilter = '';
    updateSearchState();
    updateFilterBarState();
    renderCalendarBoard(false);
  });

  // Clear ALL filters button
  clearAllBtn?.addEventListener('click', () => {
    // Reset teacher filter
    const teacherSelect = document.getElementById('teacherFilter');
    if (teacherSelect) {
      teacherSelect.value = '';
      boardTeacherFilter = '';
      boardTeacherFilterLabel = '';
    }

    // Reset student search
    if (filterInput) {
      filterInput.value = '';
    }
    boardStudentFilter = '';

    updateSearchState();
    updateFilterBarState();
    renderCalendarBoard(false);
  });

  // Update state when teacher filter changes
  const teacherSelect = document.getElementById('teacherFilter');
  teacherSelect?.addEventListener('change', () => {
    updateFilterBarState();
  });



  // Click a pill to assign a teacher
  const container = document.getElementById('boardContent');

  // ---- Custom confirmation popup for removing teachers ----
  function showRemoveTeacherConfirm({ teacherName, type }) {
    return new Promise((resolve) => {
      document.getElementById('removeTeacherOverlay')?.remove();

      const isBreakout = type === 'breakout';
      const typeLabel = isBreakout ? 'Breakout' : 'TTKB';
      const iconBg = isBreakout ? '#eef2ff' : '#f0fdf4';
      const iconColor = isBreakout ? '#6366f1' : '#16a34a';
      const icon = isBreakout ? 'fa-users' : 'fa-chalkboard-teacher';

      const overlay = document.createElement('div');
      overlay.id = 'removeTeacherOverlay';
      overlay.className = 'remove-teacher-overlay';
      overlay.innerHTML = `
        <div class="remove-teacher-popup">
          <div class="rtp-icon" style="background:${iconBg};color:${iconColor};">
            <i class="fa-solid ${icon}"></i>
          </div>
          <h3 class="rtp-title">Remove ${typeLabel} Teacher</h3>
          <p class="rtp-message">
            Are you sure you want to remove
            <strong>${escapeHtml(teacherName)}</strong>
            as the <span class="rtp-type-badge" style="background:${iconBg};color:${iconColor};">${typeLabel}</span> teacher from this slot?
          </p>
          <div class="rtp-actions">
            <button type="button" class="rtp-btn rtp-btn-cancel">Cancel</button>
            <button type="button" class="rtp-btn rtp-btn-remove">
              <i class="fa-solid fa-user-minus"></i> Remove
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));

      const close = (result) => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
        resolve(result);
      };

      overlay.querySelector('.rtp-btn-cancel').addEventListener('click', () => close(false));
      overlay.querySelector('.rtp-btn-remove').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
      overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(false); });
      overlay.querySelector('.rtp-btn-cancel').focus();
    });
  }

  // Show actions on hover (no CSS changes)
  container?.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.student-card');
    if (!card) return;
    const actions = card.querySelector('.card-actions');
    if (actions) {
      actions.style.opacity = '1';
      actions.style.transform = 'translateY(0)';
    }
  });

  container?.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.student-card');
    if (!card) return;
    const actions = card.querySelector('.card-actions');
    if (actions) {
      actions.style.opacity = '0';
      actions.style.transform = 'translateY(-4px)';
    }
  });


  container?.addEventListener('click', async (e) => {
    // -2) Breakout-chip clicked? -> confirm and remove breakout teacher
    const breakoutChip = e.target.closest('.breakout-chip[data-sched-id]');
    if (breakoutChip) {
      e.preventDefault();
      e.stopPropagation();
      const schedId = breakoutChip.dataset.schedId;
      const bEmail = breakoutChip.dataset.breakoutEmail || '';
      const bName = breakoutChip.textContent.trim();
      const confirmed = await showRemoveTeacherConfirm({ teacherName: bName, type: 'breakout' });
      if (!confirmed) return;
      try {
        const rsp = await fetch('/api/set-breakout-teacher-cal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedId, breakoutEmail: null })
        });
        const out = await rsp.json();
        if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Remove failed');
        renderCalendarBoard(true);
      } catch (err) {
        alert(`Could not remove breakout teacher: ${err?.message || 'Unknown error'}`);
        console.error(err);
      }
      return;
    }

    // -1) Teacher-chip clicked? -> confirm and remove TTKB teacher
    const teacherChip = e.target.closest('.teacher-chip[data-sched-id]');
    if (teacherChip) {
      e.preventDefault();
      e.stopPropagation();
      const schedId = teacherChip.dataset.schedId;
      const tEmail = teacherChip.dataset.teacherEmail || '';
      const tName = teacherChip.textContent.trim();
      const confirmed = await showRemoveTeacherConfirm({ teacherName: tName, type: 'ttkb' });
      if (!confirmed) return;
      try {
        const rsp = await fetch('/api/set-teacher', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedId, teacherEmail: null })
        });
        const out = await rsp.json();
        if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Remove failed');
        renderCalendarBoard(true);
      } catch (err) {
        alert(`Could not remove teacher: ${err?.message || 'Unknown error'}`);
        console.error(err);
      }
      return;
    }

    // 0) BR badge clicked? -> open Smart Assign popup for Breakout teachers only.
    const brBtn = e.target.closest('.br-badge-inline');
    if (brBtn) {
      e.preventDefault();
      e.stopPropagation();
      
      const pill = brBtn.closest('.duo-chip');
      if (!pill) {
        console.error('[BR] No .duo-chip found for button');
        return;
      }

      const schedId = pill.dataset.schedId;
      if (!schedId) {
        console.error('[BR] No schedId on pill:', pill.dataset);
        alert('Cannot assign breakout: missing schedule ID');
        return;
      }

      // Get student email from the card
      const card = pill.closest('.student-card');
      const studentEmail = card?.querySelector('.card-action.edit')?.dataset?.studentEmail || '';
      const studentName = card?.querySelector('.name-txt')?.textContent || studentEmail;

      await openSmartAssignPopup({
        type: 'breakout',
        schedId: schedId,
        day: parseInt(pill.dataset.day, 10),
        time: pill.dataset.time,
        studentEmail: studentEmail,
        studentName: studentName
      });
      return;
    }

    // 1) Card actions
    const editBtn = e.target.closest('.card-action.edit');
    const delBtn = e.target.closest('.card-action.delete');

    if (editBtn) {
      const email = editBtn.dataset.studentEmail || '';
      openStudentEditorByEmail(email);
      return;
    }

    if (delBtn) {
      const email = delBtn.dataset.studentEmail || '';
      const sure = confirm(`Delete all schedules for "${email}"? This cannot be undone.`);
      if (!sure) return;

      try {
        const rsp = await fetch('/api/delete-student-schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const out = await rsp.json();
        if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Delete failed');

        alert(`Deleted ${out.deleted} schedule(s) for ${email}.`);
        renderCalendarBoard(true);
      } catch (err) {
        console.error(err);
        alert(`Delete failed: ${err?.message || 'Unknown error'}`);
      }

      return;
    }

    // 2) Click a pill to open Smart Assign popup for TTKB teachers only
    const pill = e.target.closest('.duo-chip');
    if (!pill) return;

    // Get student email from the card
    const card = pill.closest('.student-card');
    const studentEmail = card?.querySelector('.card-action.edit')?.dataset?.studentEmail || '';
    const studentName = card?.querySelector('.name-txt')?.textContent || studentEmail;

    await openSmartAssignPopup({
      type: 'ttkb',
      schedId: pill.dataset.schedId,
      day: parseInt(pill.dataset.day, 10),
      time: pill.dataset.time,
      studentEmail: studentEmail,
      studentName: studentName
    });
  });



}

// --- Teacher filter helpers ---
function ensureTeacherFilterOptions(teachers = []) {
  const sel = document.getElementById('teacherFilter');
  if (!sel) return;

  const prev = sel.value || '';
  sel.innerHTML = ['<option value="">All teachers</option>']
    .concat((teachers || []).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`))
    .join('');

  // keep prior selection if still available
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function filterStudentsByTeacher(
  students = [],
  schedules = [],
  teacherEmail = '',
  teacherLabel = '',
  breakoutOnly = false
) {
  const email = (teacherEmail || '').trim();
  if (!email) return students;

  const taughtEmails = new Set(
    (schedules || []).filter(sc => {
      // Match against teacher_email or breakout_email
      const mainMatch = (sc.teacher_email || '') === email;
      const breakoutMatch = (sc.breakout_email || '') === email;
      return mainMatch || breakoutMatch;
    }).map(sc => sc.student_email)
  );

  return (students || []).filter(s => taughtEmails.has(s.email));
}


function filterStudentsByName(students = [], q = '') {
  if (!q) return students;
  const qc = q.toLowerCase();
  return (students || []).filter(s =>
    (s.email || '').toLowerCase().includes(qc) ||
    (s.displayName || '').toLowerCase().includes(qc)
  );

}



async function renderCalendarBoard(forceReload = false) {

  const container = document.getElementById('boardContent');
  if (!container || !client) return;

  if (forceReload) {
    boardCache = null; // force a fresh fetch
  }

  // If nothing cached yet, start (or await) a single shared load
  if (!boardCache) {
    if (!boardLoadPromise) {
      container.innerHTML = 'Loading…';
      boardLoadPromise = loadStudentSchedules()
        .then(data => { boardCache = data; return data; })
        .finally(() => { boardLoadPromise = null; });
    }
    try {
      await boardLoadPromise; // wait for the first caller’s request
    } catch (e) {
      console.error('Board load failed:', e);
      container.innerHTML = `
      <div class="tip" style="color:#d52731">
        Cannot load schedules. ${escapeHtml(e.message || '')}
      </div>`;
      boardLoadPromise = null;
      return;
    }
  }



  // build map for showing teacher names (if you show them under pills)
  window._teacherNameById = new Map((boardCache.teachers || []).map(t => [t.id, t.name]));

  window._teacherAvailIndex = buildAvailIndex(boardCache.availability || []);

  window._teacherNameByEmail = boardCache.teacherNamesByEmail || new Map(); // NEW


  // Populate the teacher dropdown
  ensureTeacherFilterOptions(boardCache.teachers);

  // Start with all students
  let filteredStudents = boardCache.students;

  // Apply teacher filter (if any)
  // Apply teacher / breakout filters
  if (boardTeacherFilter) {
    // Filter by the selected teacher
    filteredStudents = filterStudentsByTeacher(
      filteredStudents,
      boardCache.schedules,
      boardTeacherFilter,
      boardTeacherFilterLabel,
      boardFilterBreakoutOnly   // << honor the checkbox too
    );
  } else if (boardFilterBreakoutOnly) {
    // No teacher selected, but "Breakout only" is ON -> keep only students who have any breakout teacher
    filteredStudents = filterStudentsWithAnyBreakout(
      filteredStudents,
      boardCache.schedules
    );
  }





  // Apply student-name filter (if any)
  if (boardStudentFilter) {
    filteredStudents = filterStudentsByName(filteredStudents, boardStudentFilter);
  }

  const dataForRender = { ...boardCache, students: filteredStudents };

  // NEW: if no filters are active, show grouped-by-teacher (cards remain unchanged)
  const isUnfiltered = !boardTeacherFilter && !boardStudentFilter && !boardFilterBreakoutOnly;

  // FORCE NICE DISPLAY: Always use the scheduleSection container
  const scheduleSection = document.getElementById('scheduleSection');
  const unfilteredContainer = document.getElementById('boardContentUnfiltered');

  // Always show the nice section, hide the plain container
  if (scheduleSection) scheduleSection.style.display = 'block';
  if (unfilteredContainer) unfilteredContainer.style.display = 'none';

  // Render content into the nice container
  container.innerHTML =
    boardView === 'day'
      ? renderByDay(dataForRender)
      : renderByStudent(dataForRender);

  // Update badge (use "All Students" if no teacher is selected)
  updateScheduleSectionHeader(
    filteredStudents.length,
    boardTeacherFilterLabel || 'All Students'
  );

  // Update filter count display
  const filterCountEl = document.getElementById('filterCount');
  if (filterCountEl) {
    const total = boardCache?.students?.length || 0;
    const shown = filteredStudents.length;
    if (total !== shown) {
      filterCountEl.innerHTML = `<strong>${shown}</strong> of <strong>${total}</strong> students`;
      filterCountEl.style.display = '';
    } else {
      filterCountEl.innerHTML = `<strong>${total}</strong> students`;
      filterCountEl.style.display = '';
    }
  }

  // Render missing teachers section
  renderMissingTeachersSection(boardCache.students, boardCache.schedules);

}


// ========== MISSING TEACHERS SECTION ==========
function renderMissingTeachersSection(students = [], schedules = []) {
  const section = document.getElementById('missingTeachersSection');
  const content = document.getElementById('missingTeachersContent');
  if (!section || !content) return;

  // Build a map: student_email -> array of schedules missing teachers
  const missingByStudent = new Map();

  for (const sched of schedules) {
    const missing = [];
    const isExtraDay = !!sched.buoi_phu; // Extra learning day

    // Check if missing TTKB teacher (NOT required for extra days)
    if (!isExtraDay && (!sched.teacher_email || !sched.teacher_email.trim())) {
      missing.push({ type: 'ttkb', day: sched.day_of_week, time: sched.time_local, schedId: sched.id, studentEmail: sched.student_email });
    }

    // Check if missing Breakout teacher (required for all days including extra)
    if (!sched.breakout_email || !sched.breakout_email.trim()) {
      missing.push({ type: 'breakout', day: sched.day_of_week, time: sched.time_local, schedId: sched.id, studentEmail: sched.student_email });
    }

    if (missing.length > 0) {
      if (!missingByStudent.has(sched.student_email)) {
        missingByStudent.set(sched.student_email, []);
      }
      missingByStudent.get(sched.student_email).push(...missing);
    }
  }

  // If nothing missing, hide section
  if (missingByStudent.size === 0) {
    section.style.display = 'none';
    return;
  }

  // Build student name lookup
  const nameByEmail = new Map((students || []).map(s => [s.email, s.displayName || s.email]));

  // Sort students by number of missing requirements (least first), then by name
  const sortedEntries = Array.from(missingByStudent.entries()).sort((a, b) => {
    const countA = a[1].length;
    const countB = b[1].length;
    // First: sort by count (ascending - least requirements first)
    if (countA !== countB) return countA - countB;
    // Second: if same count, sort by name alphabetically
    const nameA = nameByEmail.get(a[0]) || a[0];
    const nameB = nameByEmail.get(b[0]) || b[0];
    return nameA.localeCompare(nameB);
  });

  // Count total missing assignments
  let totalMissing = 0;
  for (const [, arr] of sortedEntries) totalMissing += arr.length;

  // Update header badge
  const header = section.querySelector('.missing-header span');
  if (header) {
    header.innerHTML = `HV chưa có GV phụ trách <span class="missing-count-badge">${totalMissing}</span>`;
  }

  // Render rows
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const rows = sortedEntries.map(([email, missingList]) => {
    const studentName = nameByEmail.get(email) || email;

    // Group by day: { day -> [full objects] }
    const byDay = new Map();
    for (const m of missingList) {
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day).push(m);
    }

    // Sort by day and render combined chips
    const chips = Array.from(byDay.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([day, items]) => {
        const dayLabel = dayLabels[day] || `Day ${day}`;
        const badges = items.map(m => {
          const cls = m.type === 'ttkb' ? 'badge-ttkb' : 'badge-br';
          const label = m.type === 'ttkb' ? 'TT' : 'BR';
          return `<span class="missing-badge ${cls} clickable-badge"
            data-type="${m.type}"
            data-sched-id="${m.schedId}"
            data-day="${m.day}"
            data-time="${escapeHtml(m.time || '')}"
            data-student-email="${escapeHtml(m.studentEmail || '')}"
            data-student-name="${escapeHtml(email)}"
            title="Click to find suitable teachers">${label}</span>`;
        }).join('');
        return `
          <span class="missing-day-chip">
            <span class="day-label">${dayLabel}</span>
            ${badges}
          </span>
        `;
      }).join('');

    return `
      <div class="missing-student-row" data-student-name="${escapeHtml(studentName)}" style="cursor:pointer;" title="Click to filter this student">
        <div class="missing-student-name">${escapeHtml(studentName)}</div>
        <div class="missing-days-list">${chips}</div>
      </div>
    `;
  }).join('');

  content.innerHTML = rows || `
    <div class="missing-empty">
      <i class="fa-solid fa-circle-check"></i>
      Tất cả HV đã có GV phụ trách!
    </div>
  `;

  section.style.display = 'block';

  // Setup collapse button (only once)
  setupMissingCollapseBtn();
}

function setupMissingCollapseBtn() {
  const btn = document.getElementById('collapseMissingBtn');
  const content = document.getElementById('missingTeachersContent');
  if (!btn || !content || btn._setupDone) return;

  btn._setupDone = true;
  btn.addEventListener('click', () => {
    const isCollapsed = content.classList.toggle('collapsed');
    btn.classList.toggle('collapsed', isCollapsed);
  });

  // Click on badge to open smart assign popup
  content.addEventListener('click', async (e) => {
    const badge = e.target.closest('.clickable-badge');
    if (badge) {
      e.stopPropagation();
      const data = {
        type: badge.dataset.type,
        schedId: badge.dataset.schedId,
        day: parseInt(badge.dataset.day, 10),
        time: badge.dataset.time,
        studentEmail: badge.dataset.studentEmail,
        studentName: badge.dataset.studentName || badge.dataset.studentEmail
      };
      await openSmartAssignPopup(data);
      return;
    }

    // Click on student card to filter (existing behavior)
    const row = e.target.closest('.missing-student-row');
    if (!row) return;

    const studentName = row.dataset.studentName || '';
    if (!studentName) return;

    // Set the student filter input
    const filterInput = document.getElementById('studentFilter');
    if (filterInput) {
      filterInput.value = studentName;
      boardStudentFilter = studentName.toLowerCase();
      renderCalendarBoard(false);
    }
  });
}

async function findMatchingTeachers(dayOfWeek, timeLocal, tz) {
  try {
    const res = await fetch('/api/find-matching-teachers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day_of_week: dayOfWeek,
        time_local: timeLocal
      })
    });

    const json = await res.json();
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || 'Failed to fetch matching teachers');
    }

    // Keep the same return shape used by your UI (array of { email })
    return (json.emails || []).map(email => ({ email }));
  } catch (e) {
    console.error('findMatchingTeachers (server) error:', e);
    return [];
  }
}





// ---- Availability helpers (display condition) ----
function buildAvailIndex(avails = []) {
  const idx = new Map(); // teacher_id -> Map(day_of_week -> [ [start,end], ... ])
  for (const r of avails) {
    if (!idx.has(r.teacher_id)) idx.set(r.teacher_id, new Map());
    const byDay = idx.get(r.teacher_id);
    if (!byDay.has(r.day_of_week)) byDay.set(r.day_of_week, []);
    byDay.get(r.day_of_week).push([r.time_start, r.time_end]);
  }
  // optional: sort ranges by start time
  for (const [, byDay] of idx) {
    for (const [d, arr] of byDay) arr.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return idx;
}



function isCovered(availIdx, teacherId, dayOfWeek, timeLocal) {
  const ranges = availIdx?.get(teacherId)?.get(dayOfWeek) || [];
  for (const [start, end] of ranges) {
    if (start <= timeLocal && timeLocal < end) return true;
  }
  return false;
}

function placePopover(list, anchorRect) {
  const M = 8; // margin to screen edge
  // Clamp width to viewport
  const w = Math.min(list.offsetWidth, window.innerWidth - M * 2);
  list.style.maxWidth = w + 'px';

  // Default: open below the anchor
  let left = anchorRect.left;
  let top = anchorRect.bottom + 6;

  // If it goes off the right side, pull it back
  if (left + w > window.innerWidth - M) {
    left = Math.max(M, window.innerWidth - M - w);
  }

  list.style.left = left + 'px';
  list.style.top = top + 'px';

  // If it overflows bottom, open upwards if there's room
  const r = list.getBoundingClientRect();
  if (r.bottom > window.innerHeight - M && (anchorRect.top - 6) > r.height) {
    top = Math.max(M, anchorRect.top - 6 - r.height);
    list.style.top = top + 'px';
  }

  // Final safety: shrink height to fit the viewport if needed
  const maxH = Math.max(
    180,
    Math.min(
      parseInt(getComputedStyle(list).maxHeight, 10) || 9999,
      window.innerHeight - M - Math.max(top, M)
    )
  );
  list.style.maxHeight = maxH + 'px';
}


// Tiny popover to choose a teacher and save it
function showTeacherPicker(anchorEl, teachers, info) {
  // remove old picker if any
  document.getElementById('teacherPickList')?.remove();

  const rect = anchorEl.getBoundingClientRect();
  const list = document.createElement('div');
  list.id = 'teacherPickList';
  list.className = 'autocomplete-list pick-popover';
  list.style.position = 'fixed';
  list.style.top = `${rect.bottom + 6}px`;
  list.style.left = `${rect.left}px`;
  list.style.right = 'auto';
  list.style.minWidth = '220px';
  list.style.maxWidth = '320px';

  const parts = [];

  // Show "Unassign" if there is an email already set on the chip
  if (info.teacherEmail) {
    parts.push(`
      <button type="button" class="suggestion" data-unassign="1">
        🗑️ Remove assigned teacher
      </button>
    `);
  }

  if (teachers.length) {
    parts.push(teachers.map(t => `
      <button type="button" class="suggestion" data-email="${escapeHtml(t.email)}">
        ${escapeHtml(t.email)}
      </button>
    `).join(''));
  } else if (!info.teacherEmail) {
    parts.push('<div class="empty">No available teachers</div>');
  }

  list.innerHTML = parts.join('');
  document.body.appendChild(list);
  placePopover(list, rect);




  const close = (ev) => {
    if (!list.contains(ev.target)) {
      document.removeEventListener('click', close, { capture: true });
      list.remove();
    }
  };
  setTimeout(() => document.addEventListener('click', close, { capture: true }), 0);

  list.addEventListener('click', async (e) => {
    const unassignBtn = e.target.closest('button.suggestion[data-unassign="1"]');
    const assignBtn = e.target.closest('button.suggestion[data-email]');

    // Unassign -> clear teacher_email (and also clear assigned_teacher_id to stop using IDs)
    if (unassignBtn) {
      try {
        const rsp = await fetch('/api/set-teacher', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedId: info.schedId, teacherEmail: null })
        });
        const out = await rsp.json();
        if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Unassign failed');

        list.remove();
        renderCalendarBoard(true);
      } catch (err) {
        alert(`Could not remove teacher: ${err?.message || 'Unknown error'}`);
        console.error(err);
      }

      return;
    }

    // Assign -> set teacher_email only (and clear assigned_teacher_id)
    if (assignBtn) {
      const email = assignBtn.dataset.email;

      // Get student email from the card
      const card = anchorEl.closest('.student-card');
      const studentEmail = card?.querySelector('.card-action.edit')?.dataset?.studentEmail || '';

      // Function to perform the actual assignment
      const doAssign = async () => {
        try {
          const rsp = await fetch('/api/set-teacher', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedId: info.schedId, teacherEmail: email })
          });
          const out = await rsp.json();
          if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Assign failed');

          list.remove();
          renderCalendarBoard(true);
        } catch (err) {
          alert(`Could not assign teacher: ${err?.message || 'Unknown error'}`);
          console.error(err);
        }
      };

      // Breakout assignments skip level check — any teacher can manage any breakout
      await doAssign();
    }
  });


 // Show level mismatch warning popup
function showLevelMismatchWarning(teacherEmail, teacherName, studentLevel, allowedLevels, onAssignAnyway, onReassign) {
  // Remove any existing popup
  document.getElementById('levelWarningOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'levelWarningOverlay';
  overlay.className = 'level-warning-overlay';

  // Group the allowed levels
  const groupedLevels = groupLevelsByCategory(allowedLevels);
  const groupedHTML = buildGroupedLevelsHTML(groupedLevels);

  overlay.innerHTML = `
    <div class="level-warning-popup">
      <div class="warning-icon">⚠️</div>
      <h3>Level Mismatch</h3>
      <p class="warning-message">
        This student's level <span class="student-level-highlight">${escapeHtml(studentLevel)}</span> does not fall into the allowed levels for <strong>${escapeHtml(teacherName)}</strong>.
      </p>
      <div class="allowed-section">
        <div class="allowed-section-title">Allowed Levels for ${escapeHtml(teacherName)}</div>
        ${groupedHTML}
      </div>
      <div class="btn-group">
        <button type="button" class="btn-assign-anyway">Assign Anyway</button>
        <button type="button" class="btn-reassign">Re-assign</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Handle button clicks
  overlay.querySelector('.btn-assign-anyway').addEventListener('click', () => {
    overlay.remove();
    onAssignAnyway();
  });

  overlay.querySelector('.btn-reassign').addEventListener('click', () => {
    overlay.remove();
    onReassign();
  });

  // Close on overlay click (outside popup)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      onReassign();
    }
  });
}

// Group levels by category for display
function groupLevelsByCategory(levels) {
  const groups = {
    'PRE-STARTERS': [],
    'STARTERS': [],
    'MOVERS': [],
    'FLYERS': [],
    'KET': [],
    'B1': [],
    'B2': [],
    'IELTS': [],
    'TEST PREP': [],
    'INTERACTION': [],
    'TIỂU HỌC': [],
    'THCS/THPT': [],
    'BUSINESS 1': [],
    'BUSINESS 2': [],
    'TOEIC': [],
    'OTHERS': []
  };

  for (const level of levels) {
    const upperLevel = level.toUpperCase();
    
    if (upperLevel.includes('PRE_STARTERS') || upperLevel.includes('PRE-STARTERS')) {
      groups['PRE-STARTERS'].push(level);
    } else if (upperLevel.includes('STARTERS')) {
      groups['STARTERS'].push(level);
    } else if (upperLevel.includes('MOVERS')) {
      groups['MOVERS'].push(level);
    } else if (upperLevel.includes('FLYERS')) {
      groups['FLYERS'].push(level);
    } else if (upperLevel.includes('KET')) {
      groups['KET'].push(level);
    } else if (upperLevel.startsWith('B1') || upperLevel === 'B1A' || upperLevel === 'B1B') {
      groups['B1'].push(level);
    } else if (upperLevel.startsWith('B2') || upperLevel === 'B2A' || upperLevel === 'B2B') {
      groups['B2'].push(level);
    } else if (upperLevel.includes('IELTS')) {
      groups['IELTS'].push(level);
    } else if (upperLevel.includes('TEST_PREP') || upperLevel.includes('TEST-PREP')) {
      groups['TEST PREP'].push(level);
    } else if (upperLevel.includes('INTERACTION')) {
      groups['INTERACTION'].push(level);
    } else if (upperLevel.includes('TIEU_HOC') || upperLevel.includes('TIEU-HOC') || upperLevel.includes('TIỂU')) {
      groups['TIỂU HỌC'].push(level);
    } else if (upperLevel.includes('THCS') || upperLevel.includes('THPT')) {
      groups['THCS/THPT'].push(level);
    } else if (upperLevel.includes('BUSINESS1') || upperLevel === 'BUSINESS1A' || upperLevel === 'BUSINESS1B') {
      groups['BUSINESS 1'].push(level);
    } else if (upperLevel.includes('BUSINESS2') || upperLevel === 'BUSINESS2A' || upperLevel === 'BUSINESS2B') {
      groups['BUSINESS 2'].push(level);
    } else if (upperLevel.includes('TOEIC')) {
      groups['TOEIC'].push(level);
    } else {
      groups['OTHERS'].push(level);
    }
  }

  return groups;
}

// Build HTML for grouped levels
function buildGroupedLevelsHTML(groups) {
  const groupClassMap = {
    'PRE-STARTERS': 'group-pre-starters',
    'STARTERS': 'group-starters',
    'MOVERS': 'group-movers',
    'FLYERS': 'group-flyers',
    'KET': 'group-ket',
    'B1': 'group-b1',
    'B2': 'group-b2',
    'IELTS': 'group-ielts',
    'TEST PREP': 'group-test-prep',
    'INTERACTION': 'group-interaction',
    'TIỂU HỌC': 'group-tieu-hoc',
    'THCS/THPT': 'group-thcs-thpt',
    'BUSINESS 1': 'group-business',
    'BUSINESS 2': 'group-business',
    'TOEIC': 'group-toeic',
    'OTHERS': 'group-others'
  };

  let html = '<div class="level-groups-grid">';
  let hasAnyLevels = false;

  for (const [groupName, levels] of Object.entries(groups)) {
    if (levels.length === 0) continue;
    hasAnyLevels = true;

    const groupClass = groupClassMap[groupName] || 'group-others';
    const badgesHTML = levels.map(l => `<span class="level-badge-item">${escapeHtml(l)}</span>`).join('');

    html += `
      <div class="level-group-row ${groupClass}">
        <div class="level-group-title">${escapeHtml(groupName)}</div>
        <div class="level-group-items">${badgesHTML}</div>
      </div>
    `;
  }

  html += '</div>';

  if (!hasAnyLevels) {
    return '<div class="no-levels-message">No levels assigned to this teacher</div>';
  }

  return html;
}

  // Check if teacher is allowed to teach student's level
  async function checkLevelAssignment(teacherEmail, studentEmail) {
    try {
      const res = await fetch('/api/check-level-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacherEmail, studentEmail })
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        console.error('Level check failed:', json?.error);
        return { allowed: true }; // On error, allow assignment
      }
      return json;
} catch (e) {
      console.error('checkLevelAssignment error:', e);
      return { allowed: true }; // On error, allow assignment
    }
  }
}

// ========== SHARED HELPER FUNCTIONS (used by both showTeacherPicker and showBreakoutPicker) ==========

// Check if teacher is allowed to teach student's level
async function checkLevelAssignment(teacherEmail, studentEmail) {
  try {
    const res = await fetch('/api/check-level-assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teacherEmail, studentEmail })
    });
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      console.error('Level check failed:', json?.error);
      return { allowed: true };
    }
    return json;
  } catch (e) {
    console.error('checkLevelAssignment error:', e);
    return { allowed: true };
  }
}

// Show level mismatch warning popup
function showLevelMismatchWarning(teacherEmail, teacherName, studentLevel, allowedLevels, onAssignAnyway, onReassign) {
  document.getElementById('levelWarningOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'levelWarningOverlay';
  overlay.className = 'level-warning-overlay';

  const groupedLevels = groupLevelsByCategory(allowedLevels);
  const groupedHTML = buildGroupedLevelsHTML(groupedLevels);

  overlay.innerHTML = `
    <div class="level-warning-popup">
      <div class="warning-icon">⚠️</div>
      <h3>Level Mismatch</h3>
      <p class="warning-message">
        This student's level <span class="student-level-highlight">${escapeHtml(studentLevel)}</span> does not fall into the allowed levels for <strong>${escapeHtml(teacherName)}</strong>.
      </p>
      <div class="allowed-section">
        <div class="allowed-section-title">Allowed Levels for ${escapeHtml(teacherName)}</div>
        ${groupedHTML}
      </div>
      <div class="btn-group">
        <button type="button" class="btn-assign-anyway">Assign Anyway</button>
        <button type="button" class="btn-reassign">Re-assign</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.btn-assign-anyway').addEventListener('click', () => {
    overlay.remove();
    onAssignAnyway();
  });

  overlay.querySelector('.btn-reassign').addEventListener('click', () => {
    overlay.remove();
    onReassign();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      onReassign();
    }
  });
}

// Group levels by category for display
function groupLevelsByCategory(levels) {
  const groups = {
    'PRE-STARTERS': [], 'STARTERS': [], 'MOVERS': [], 'FLYERS': [],
    'KET': [], 'B1': [], 'B2': [], 'IELTS': [], 'TEST PREP': [],
    'INTERACTION': [], 'TIỂU HỌC': [], 'THCS/THPT': [],
    'BUSINESS 1': [], 'BUSINESS 2': [], 'TOEIC': [], 'OTHERS': []
  };

  for (const level of levels) {
    const upperLevel = level.toUpperCase();
    if (upperLevel.includes('PRE_STARTERS') || upperLevel.includes('PRE-STARTERS')) groups['PRE-STARTERS'].push(level);
    else if (upperLevel.includes('STARTERS')) groups['STARTERS'].push(level);
    else if (upperLevel.includes('MOVERS')) groups['MOVERS'].push(level);
    else if (upperLevel.includes('FLYERS')) groups['FLYERS'].push(level);
    else if (upperLevel.includes('KET')) groups['KET'].push(level);
    else if (upperLevel.startsWith('B1') || upperLevel === 'B1A' || upperLevel === 'B1B') groups['B1'].push(level);
    else if (upperLevel.startsWith('B2') || upperLevel === 'B2A' || upperLevel === 'B2B') groups['B2'].push(level);
    else if (upperLevel.includes('IELTS')) groups['IELTS'].push(level);
    else if (upperLevel.includes('TEST_PREP') || upperLevel.includes('TEST-PREP')) groups['TEST PREP'].push(level);
    else if (upperLevel.includes('INTERACTION')) groups['INTERACTION'].push(level);
    else if (upperLevel.includes('TIEU_HOC') || upperLevel.includes('TIEU-HOC') || upperLevel.includes('TIỂU')) groups['TIỂU HỌC'].push(level);
    else if (upperLevel.includes('THCS') || upperLevel.includes('THPT')) groups['THCS/THPT'].push(level);
    else if (upperLevel.includes('BUSINESS1') || upperLevel === 'BUSINESS1A' || upperLevel === 'BUSINESS1B') groups['BUSINESS 1'].push(level);
    else if (upperLevel.includes('BUSINESS2') || upperLevel === 'BUSINESS2A' || upperLevel === 'BUSINESS2B') groups['BUSINESS 2'].push(level);
    else if (upperLevel.includes('TOEIC')) groups['TOEIC'].push(level);
    else groups['OTHERS'].push(level);
  }
  return groups;
}

// Build HTML for grouped levels
function buildGroupedLevelsHTML(groups) {
  const groupClassMap = {
    'PRE-STARTERS': 'group-pre-starters', 'STARTERS': 'group-starters',
    'MOVERS': 'group-movers', 'FLYERS': 'group-flyers', 'KET': 'group-ket',
    'B1': 'group-b1', 'B2': 'group-b2', 'IELTS': 'group-ielts',
    'TEST PREP': 'group-test-prep', 'INTERACTION': 'group-interaction',
    'TIỂU HỌC': 'group-tieu-hoc', 'THCS/THPT': 'group-thcs-thpt',
    'BUSINESS 1': 'group-business', 'BUSINESS 2': 'group-business',
    'TOEIC': 'group-toeic', 'OTHERS': 'group-others'
  };

  let html = '<div class="level-groups-grid">';
  let hasAnyLevels = false;

  for (const [groupName, levels] of Object.entries(groups)) {
    if (levels.length === 0) continue;
    hasAnyLevels = true;
    const groupClass = groupClassMap[groupName] || 'group-others';
    const badgesHTML = levels.map(l => `<span class="level-badge-item">${escapeHtml(l)}</span>`).join('');
    html += `<div class="level-group-row ${groupClass}"><div class="level-group-title">${escapeHtml(groupName)}</div><div class="level-group-items">${badgesHTML}</div></div>`;
  }

  html += '</div>';
  return hasAnyLevels ? html : '<div class="no-levels-message">No levels assigned to this teacher</div>';
}

// Breakout teacher picker (same layout as normal picker, different endpoint/labels)
function showBreakoutPicker(anchorEl, teachers, info) {
  // remove any open pickers
  document.getElementById('teacherPickList')?.remove();
  document.getElementById('breakoutPickList')?.remove();

  const rect = anchorEl.getBoundingClientRect();
  const list = document.createElement('div');
  list.id = 'breakoutPickList';
  list.className = 'autocomplete-list pick-popover';
  list.style.position = 'fixed';
  list.style.top = `${rect.bottom + 6}px`;
  list.style.left = `${rect.left}px`;
  list.style.right = 'auto';
  list.style.minWidth = '220px';
  list.style.maxWidth = '320px';

  const parts = [];

  if (info.breakoutEmail) {
    parts.push(`
      <button type="button" class="suggestion" data-unassign="1">
        🗑️ Remove breakout teacher
      </button>
    `);
  }

  if (teachers.length) {
    parts.push(teachers.map(t => `
      <button type="button" class="suggestion" data-email="${escapeHtml(t.email)}">
        ${escapeHtml(t.email)}
      </button>
    `).join(''));
  } else if (!info.breakoutEmail) {
    parts.push('<div class="empty">No available teachers</div>');
  }

  list.innerHTML = parts.join('');
  document.body.appendChild(list);
  placePopover(list, rect);


  const close = (ev) => {
    if (!list.contains(ev.target)) {
      document.removeEventListener('click', close, { capture: true });
      list.remove();
    }
  };
  setTimeout(() => document.addEventListener('click', close, { capture: true }), 0);

  list.addEventListener('click', async (e) => {
    const unassignBtn = e.target.closest('button.suggestion[data-unassign="1"]');
    const assignBtn = e.target.closest('button.suggestion[data-email]');

    // Unassign -> set breakout_email = null
    if (unassignBtn) {
      try {
        const rsp = await fetch('/api/set-breakout-teacher-cal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedId: info.schedId, breakoutEmail: null })
        });
        const out = await rsp.json();
        if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Unassign failed');

        list.remove();
        renderCalendarBoard(true);
      } catch (err) {
        alert(`Could not remove breakout teacher: ${err?.message || 'Unknown error'}`);
        console.error(err);
      }
      return;
    }

    // Assign -> set breakout_email to chosen email
    if (assignBtn) {
      const email = assignBtn.dataset.email;

      // Get student email from the card
      const card = anchorEl.closest('.student-card');
      const studentEmail = card?.querySelector('.card-action.edit')?.dataset?.studentEmail || '';

      // Function to perform the actual assignment
      const doAssign = async () => {
        try {
          const rsp = await fetch('/api/set-breakout-teacher-cal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedId: info.schedId, breakoutEmail: email })
          });
          const out = await rsp.json();
          if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Assign failed');

          list.remove();
          renderCalendarBoard(true);
        } catch (err) {
          alert(`Could not assign breakout teacher: ${err?.message || 'Unknown error'}`);
          console.error(err);
        }
      };

      // Breakout assignments skip level check — any teacher can manage any breakout
      await doAssign();
    }
  });
}

// Compute and draw usage bars under assigned pills.



async function loadStudentSchedules() {
  const res = await fetch('/api/load-student-schedules', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  const json = await res.json();
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || 'Failed to load schedules');
  }

  const d = json.data || {};
  // Convert the plain object to a Map so downstream .get() works
  const nameMap = new Map(Object.entries(d.teacherNamesByEmail || {}));

  return {
    students: d.students || [],
    schedules: d.schedules || [],
    teachers: d.teachers || [],
    availability: d.availability || [],
    teacherNamesByEmail: nameMap
  };
}




function renderByStudent({ students, schedules }) {
  // Build student -> slots using EMAIL
  const map = new Map(students.map(s => [s.email, { ...s, slots: [] }]));
  for (const r of schedules) {
    const s = map.get(r.student_email);
    if (s) s.slots.push(r);
  }
  for (const s of map.values()) {
    s.slots.sort((a, b) =>
      ((a.day_of_week - b.day_of_week) || (timeToMinutes(a.time_local) - timeToMinutes(b.time_local)))
    );
  }

  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const dayLabel = d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d];

  const cards = Array.from(map.values()).map(s => {
    const byDay = new Map(dayOrder.map(d => [d, []]));
    for (const sl of s.slots) if (byDay.has(sl.day_of_week)) byDay.get(sl.day_of_week).push(sl);

    const next = nextSlot(s.slots);

    const dayCells = dayOrder.map(d => {
      const items = byDay.get(d) || [];
      const pills = items.map(sl => {
        const isNext = next && sl.day_of_week === next.day_of_week && sl.time_local === next.time_local;
        // Show the email whenever teacher_email is present (no availability check)
        const assignedLabel = sl.teacher_email
          ? (window._teacherNameByEmail?.get(sl.teacher_email) || sl.teacher_email)
          : '';


        const dayClass = dayCss(d);

        // NEW: figure out breakout label (name map falls back to email)
        const breakoutLabel = sl.breakout_email
          ? (window._teacherNameByEmail?.get(sl.breakout_email) || sl.breakout_email)
          : '';

        return `
    <span class="duo-chip ${dayCss(d)}${isNext ? ' next' : ''}${sl.buoi_phu ? ' extra' : ''}"
          data-sched-id="${sl.id}"
          data-day="${sl.day_of_week}"
          data-time="${sl.time_local}"
          data-tz="${sl.timezone || ''}"
          data-teacher-email="${sl.teacher_email || ''}"
          data-breakout-email="${sl.breakout_email || ''}"
          title="${sl.buoi_phu ? 'Buổi phụ · Click to assign a teacher' : 'Click to assign a teacher'}">

      ${breakoutLabel ? `
        <span class="breakout-chip" title="Click to remove breakout teacher" data-sched-id="${sl.id}" data-breakout-email="${sl.breakout_email || ''}" style="cursor:pointer;pointer-events:auto;">
          <span class="dot"></span>
          ${escapeHtml(breakoutLabel)}
        </span>` : ``}

      <span class="day">${dayLabel(d)}</span>
      <span class="time">
        ${formatTime(sl.time_local)}
        <button type="button" class="br-badge-inline" title="Pick breakout teacher" aria-label="Pick breakout teacher">BR</button>
      </span>
    </span>

    ${(Number(sl.sessions_per_day) >= 2) ? `<span class="spd-badge" title="${Number(sl.sessions_per_day)} lượt TTKB mỗi ngày" style="display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:3px 9px;border-radius:999px;background:#eef2ff;border:1px solid #c7d2fe;color:#4338ca;font-size:11px;font-weight:800;white-space:nowrap;line-height:1;"><i class="fa-solid fa-repeat" style="font-size:10px;"></i>${Number(sl.sessions_per_day)} lượt TTKB</span>` : ``}

    ${assignedLabel ? `<span class="teacher-chip" data-sched-id="${sl.id}" data-teacher-email="${sl.teacher_email || ''}" style="cursor:pointer;" title="Click to remove teacher">${escapeHtml(assignedLabel)}</span>` : ``}
`;



      }).join('');

      const cellCls = items.length ? 'day-cell has-pill' : 'day-cell';
      return `<div class="${cellCls}" data-label="${dayLabel(d)}">${pills}</div>`;
    }).join('');

    return `
  <div class="student-card" style="position:relative;">
    <div class="card-actions"
         style="position:absolute; top:8px; right:8px; display:flex; gap:8px;
                opacity:0; transform:translateY(-4px); transition:opacity .15s ease, transform .15s ease;
                pointer-events:none;">
      <button class="card-action edit"
              style="width:34px; height:34px; display:grid; place-items:center; border:1px solid #e5e7eb;
                     background:#fff; border-radius:10px; cursor:pointer; pointer-events:auto;"
              title="Edit this student's schedule"
              data-student-email="${s.email}">
        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
      </button>
      <button class="card-action delete"
              style="width:34px; height:34px; display:grid; place-items:center; border:1px solid #e5e7eb;
                     background:#fff; border-radius:10px; cursor:pointer; pointer-events:auto;"
              title="Delete this student's schedules"
              data-student-email="${s.email}">
        <i class="fa-solid fa-trash" aria-hidden="true"></i>
      </button>
    </div>

<div class="student-week">
      <div class="student-name">
<span class="name-txt">${escapeHtml(s.displayName || s.email)}</span>
        ${(s.status ?? '') !== '' ? `<span class="status-badge" title="Status">${escapeHtml(String(s.status))}</span>` : ''}
      </div>
      ${dayCells}
    </div>
    ${s.cap_lop_hoc ? `<span class="level-badge" title="Level">${escapeHtml(s.cap_lop_hoc)}</span>` : ''}
  </div>`;
  }).join('');

  return `<div class="student-grid">${cards}</div>`;
}





function dayCss(i) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][i] || 'sun'; }

/** Return the next upcoming slot (this week or next) */
function nextSlot(slots = []) {
  if (!slots.length) return null;
  const now = new Date();
  const today = now.getDay(); // 0=Sun..6=Sat
  let best = null, bestDelta = Infinity;

  for (const s of slots) {
    const [h, m] = (s.time_local || '00:00:00').split(':').map(Number);
    // base event on this week
    const dOffset = (s.day_of_week - today + 7) % 7;
    const event = new Date(now);
    event.setHours(h || 0, m || 0, 0, 0);
    event.setDate(now.getDate() + dOffset);

    let delta = event - now;
    if (delta < 0) { // already passed today -> add a week
      event.setDate(event.getDate() + 7);
      delta = event - now;
    }
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}


// NEW: Group students by teacher (uses your existing renderByStudent for cards)
function renderByStudentGrouped({ students, schedules, teachers }) {
  // teacher.id -> teacher email (in your table, name = email)
  const teacherEmailById = new Map((teachers || []).map(t => [t.id, t.name]));
  // order groups the same as your Teacher dropdown (A→Z, because you order by name when loading)
  const teacherOrderEmails = (teachers || []).map(t => t.name);

  // collect each student's slots
  const slotsByStudent = new Map((students || []).map(s => [s.email, []]));
  for (const r of (schedules || [])) {
    if (slotsByStudent.has(r.student_email)) slotsByStudent.get(r.student_email).push(r);
  }

  // choose a "primary" teacher for grouping = teacher with the most slots
  function pickPrimaryTeacherEmail(slots = []) {
    const counts = new Map();
    for (const sl of slots) {
      const email = sl.teacher_email || teacherEmailById.get(sl.assigned_teacher_id) || null;
      if (!email) continue;
      counts.set(email, (counts.get(email) || 0) + 1);
    }
    let best = null, max = -1;
    for (const [email, cnt] of counts) {
      if (cnt > max || (cnt === max && String(email).localeCompare(String(best || '')) < 0)) {
        max = cnt; best = email;
      }
    }
    return best; // can be null
  }

  // build empty groups for each teacher (plus Unassigned)
  const groups = new Map();
  for (const email of teacherOrderEmails) groups.set(email, []);
  groups.set('__unassigned__', []);

  // place each student into a group
  for (const s of (students || [])) {
    const slots = slotsByStudent.get(s.email) || [];
    const email = pickPrimaryTeacherEmail(slots);
    if (email && groups.has(email)) groups.get(email).push(s);
    else groups.get('__unassigned__').push(s);
  }

  // render each group by reusing your EXISTING renderByStudent (so layout stays identical)
  let html = '';
  for (const email of teacherOrderEmails) {
    const subset = groups.get(email) || [];
    if (!subset.length) continue;
    const displayName = (window._teacherNameByEmail && window._teacherNameByEmail.get(email)) || email;
    html += `
<section class="teacher-group">
  <h2 class="section-title">
    <span class="teacher-badge">
      <span class="tb-name">${escapeHtml(displayName)}</span>
      <span class="tb-count">${subset.length}</span>
    </span>
  </h2>
  ${renderByStudent({ students: subset, schedules })}
</section>
`;
  }

  const un = groups.get('__unassigned__') || [];
  if (un.length) {
    html += `
<section class="teacher-group">
  <h2 class="section-title">
    <span class="teacher-badge">
      <span class="tb-name">Unassigned</span>
      <span class="tb-count">${un.length}</span>
    </span>
  </h2>
  ${renderByStudent({ students: un, schedules })}
</section>
`;
  }

  return html || `<div class="tip">No students to display.</div>`;
}


function renderByDay({ students, schedules }) {
  const names = new Map(students.map(s => [s.email, s.displayName || s.email]));
  const days = Array.from({ length: 7 }, () => []);

  for (const r of schedules) {
    days[r.day_of_week]?.push({
      name: names.get(r.student_email) || r.student_email || 'Unknown',
      time: r.time_local,
      tz: r.timezone || ''
    });
  }

  for (const arr of days) {
    arr.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  }

  const cols = days.map((arr, i) => `
    <div class="day-col">
      <h4>${weekdayLong(i)}</h4>
      ${arr.length
      ? arr.map(x => `<div class="day-item">
                 <span class="who">${escapeHtml(x.name)}</span>
                 <span class="when">${formatTime(x.time)}</span>
               </div>`).join('')
      : '<div class="tip">No classes</div>'}
    </div>
  `).join('');

  return `<div class="day-grid">${cols}</div>`;
}


// --- Helpers ---
function weekdayShort(i) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]; }
function weekdayLong(i) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]; }
function timeToMinutes(t) { const [h = 0, m = 0] = (t || '').split(':').map(Number); return h * 60 + m; }
function formatTime(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':');
  let h = parseInt(hh, 10), m = parseInt(mm, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = (h % 12) || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}


// ========== SECTION 2 HEADER UPDATE ==========
function updateScheduleSectionHeader(studentCount, teacherName) {
  const badge = document.getElementById('filteredTeacherBadge');

  if (!badge) return;

  // Show teacher badge with name and count
  // Removed the check for 'All teachers' so it displays that text too
  if (teacherName && teacherName.trim()) {
    badge.innerHTML = `
      <span class="ftb-name">${escapeHtml(teacherName)}</span>
      <span class="ftb-count">${studentCount}</span>
    `;
  } else {
    badge.innerHTML = '';
  }
}

// ========== SMART ASSIGN POPUP ==========

const DAY_LABELS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function openSmartAssignPopup(data) {
  // Remove existing popup
  document.getElementById('smartAssignOverlay')?.remove();

  const dayLabel = DAY_LABELS_FULL[data.day] || `Day ${data.day}`;
  const timeLabel = formatTime(data.time);

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'smartAssignOverlay';
  overlay.className = 'smart-assign-overlay';
  overlay.innerHTML = `
    <div class="smart-assign-modal">
      <div class="sam-header">
        <div>
          <div class="sam-title">Assign Teacher</div>
          <div class="sam-sub">${escapeHtml(data.studentName)} · ${dayLabel} · ${timeLabel}</div>
        </div>
        <button class="sam-close" title="Close">&times;</button>
      </div>
      <div class="sam-body">
        <div class="sam-loading">
          <i class="fa-solid fa-spinner fa-spin"></i> Đang tìm GV phù hợp…
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('.sam-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Fetch data
  try {
    const res = await fetch('/api/find-suitable-teachers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day_of_week: data.day,
        time_local: data.time,
        student_email: data.studentEmail
      })
    });
    const json = await res.json();
    if (!res.ok || !json?.ok) throw new Error(json?.error || 'Failed to load');

    renderSmartAssignResults(overlay, json, data);
  } catch (err) {
    console.error('Smart assign error:', err);
    overlay.querySelector('.sam-body').innerHTML = `
      <div class="sam-error">
        <i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(err.message || 'Could not load teachers')}
      </div>
    `;
  }
}

function renderSmartAssignResults(overlay, json, data) {
  const body = overlay.querySelector('.sam-body');
  const breakout = json.breakoutTeachers || [];
  const ttkb = json.ttkbTeachers || [];
  const supporter = json.supporterTeachers || [];
  const mode = data.type || 'both';

  let html = '';

// ---- BREAKOUT SECTION ----
  if (mode === 'breakout' || mode === 'both') {
  html += `
    <div class="sam-section">
      <div class="sam-section-title">
        <i class="fa-solid fa-users-rectangle"></i>
        Breakout Teachers
        <span class="sam-section-count">${breakout.length}</span>
      </div>
  `;

  if (breakout.length === 0) {
    html += `<div class="sam-empty">Không có GV breakout phù hợp vào giờ này</div>`;
  } else {
html += breakout.map((t, i) => {
      // Suitability colors
      const suitColors = {
        good:     { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', barBg: '#22c55e', icon: 'fa-circle-check',  label: t.suitabilityLabel || 'Phù hợp' },
        ok:       { bg: '#fefce8', border: '#fde68a', text: '#a16207', barBg: '#eab308', icon: 'fa-circle-info',   label: t.suitabilityLabel || 'Chấp nhận được' },
        overload: { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', barBg: '#ef4444', icon: 'fa-triangle-exclamation', label: t.suitabilityLabel || 'Quá tải' }
      };
      const sc = suitColors[t.suitability] || suitColors.ok;
      const isBest = i === 0 && (t.suitability === 'good');

      // Build timeline bar (colored segments)
      const totalDur = (t.timeline || []).reduce((s, seg) => s + seg.duration, 0) || 1;
      const timelineBarHtml = (t.timeline || []).map(seg => {
        const pct = (seg.duration / totalDur * 100).toFixed(1);
        let segColor;
        if (seg.count === 0) segColor = '#e5e7eb';
        else if (seg.count <= 3) segColor = '#22c55e';
        else if (seg.count <= 6) segColor = '#eab308';
        else segColor = '#ef4444';
        return `<div style="width:${pct}%;height:100%;background:${segColor};position:relative;" title="${seg.start}–${seg.end}: ${seg.count} HV"></div>`;
      }).join('');

      // Build segment detail rows
      const segmentRows = (t.timeline || []).map(seg => {
        let countColor;
        if (seg.count === 0) countColor = '#9ca3af';
        else if (seg.count <= 3) countColor = '#15803d';
        else if (seg.count <= 6) countColor = '#a16207';
        else countColor = '#dc2626';

        const studentChips = seg.students.map(s => {
          const roleBadge = s.role === 'TT'
            ? ' <span style="background:#dbeafe;color:#1e40af;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">TT</span>'
            : s.role === 'BR'
            ? ' <span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">BR</span>'
            : '';
          return `<span style="display:inline-flex;align-items:center;gap:3px;background:#f1f5f9;padding:2px 7px;border-radius:99px;font-size:0.68rem;white-space:nowrap;">${escapeHtml(s.name)}${roleBadge}${s.buoiPhu ? ' <span style="color:#7c3aed;font-weight:700;font-size:0.6rem;">phụ</span>' : ''}</span>`;
        }).join(' ');

        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:0.75rem;">
            <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;min-width:90px;">${escapeHtml(seg.start)} → ${escapeHtml(seg.end)}</span>
            <span style="font-weight:800;color:${countColor};min-width:20px;text-align:center;">${seg.count}</span>
            <div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;">${studentChips}</div>
          </div>`;
      }).join('');

      return `
      <div class="sam-teacher-row ${isBest ? 'sam-best' : ''}">
        <div class="sam-teacher-top">
          <div class="sam-teacher-info">
            <span class="sam-teacher-name">${escapeHtml(t.name)}</span>
            ${t.shift ? `<span class="sam-teacher-shift">${escapeHtml(t.shift)}</span>` : ''}
          </div>
          <button type="button" class="sam-assign-btn sam-assign-br"
            data-sched-id="${data.schedId}"
            data-email="${escapeHtml(t.email)}"
            data-student-email="${escapeHtml(data.studentEmail)}">Assign BR</button>
        </div>

        <div style="margin:8px 0 6px;padding:10px 12px;background:${sc.bg};border:1px solid ${sc.border};border-radius:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <i class="fa-solid ${sc.icon}" style="color:${sc.text};font-size:0.9rem;"></i>
            <span style="font-size:0.8rem;font-weight:700;color:${sc.text};">${escapeHtml(sc.label)}</span>
          </div>
          <div style="display:flex;gap:12px;font-size:0.75rem;color:#374151;flex-wrap:wrap;">
            <span>Lúc bắt đầu: <strong>${t.countAtStart || 0} HV</strong></span>
            <span>Cao điểm: <strong style="color:${sc.text};">${t.peakCount || 0} HV</strong></span>
            <span>Cả ngày: <strong>${t.totalStudentsOnDay} HV</strong></span>
          </div>
        </div>

        <div class="sam-reason">
          <span class="sam-reason-text" style="font-size:0.75rem;color:#6b7280;">
            ${escapeHtml(t.reason)}
          </span>
        </div>

        ${(t.timeline && t.timeline.length > 0) ? `
        <div style="margin-top:8px;padding:10px 12px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;">
          <div style="font-size:0.68rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:8px;">
            <i class="fa-solid fa-chart-bar" style="margin-right:4px;"></i> Timeline trong giờ học của HV
          </div>

          <div style="display:flex;height:14px;border-radius:99px;overflow:hidden;gap:1px;margin-bottom:10px;">
            ${timelineBarHtml}
          </div>

          <div style="display:flex;gap:10px;font-size:0.65rem;color:#9ca3af;margin-bottom:8px;flex-wrap:wrap;">
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#22c55e;margin-right:3px;"></span>0–3 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#eab308;margin-right:3px;"></span>4–6 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#ef4444;margin-right:3px;"></span>7+ HV</span>
          </div>

          ${segmentRows}
        </div>
        ` : ''}

        ${isBest ? '<div class="sam-best-label"><i class="fa-solid fa-star"></i> Phù hợp nhất</div>' : ''}
      </div>`;
    }).join('');
  }

  html += `</div>`;

  // ---- SUPPORTER / MIX SECTION (only in breakout mode) ----
  if ((mode === 'breakout' || mode === 'both') && supporter.length > 0) {
    html += `
      <div class="sam-section">
        <div class="sam-section-title" style="color:#7c3aed;">
          <i class="fa-solid fa-hands-helping"></i>
          Supporter / Mix Teachers
          <span class="sam-section-count" style="background:#ede9fe;color:#7c3aed;">${supporter.length}</span>
        </div>
        <div style="padding:6px 16px 2px;font-size:0.72rem;color:#9ca3af;font-style:italic;">
          GV bộ phận hỗ trợ — có thể nhờ phụ trách breakout khi cần
        </div>
    `;
    html += supporter.map((t, i) => {
      const suitColors = {
        good:     { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', icon: 'fa-circle-check' },
        ok:       { bg: '#fefce8', border: '#fde68a', text: '#a16207', icon: 'fa-circle-info' },
        overload: { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', icon: 'fa-triangle-exclamation' }
      };
      const sc = suitColors[t.suitability] || suitColors.ok;

      const totalDur = (t.timeline || []).reduce((s, seg) => s + seg.duration, 0) || 1;
      const timelineBarHtml = (t.timeline || []).map(seg => {
        const pct = (seg.duration / totalDur * 100).toFixed(1);
        let segColor;
        if (seg.count === 0) segColor = '#e5e7eb';
        else if (seg.count <= 3) segColor = '#22c55e';
        else if (seg.count <= 6) segColor = '#eab308';
        else segColor = '#ef4444';
        return `<div style="width:${pct}%;height:100%;background:${segColor};" title="${seg.start}–${seg.end}: ${seg.count} HV"></div>`;
      }).join('');

      const segmentRows = (t.timeline || []).map(seg => {
        let countColor;
        if (seg.count === 0) countColor = '#9ca3af';
        else if (seg.count <= 3) countColor = '#15803d';
        else if (seg.count <= 6) countColor = '#a16207';
        else countColor = '#dc2626';
        const studentChips = seg.students.map(s => {
          const roleBadge = s.role === 'TT'
            ? ' <span style="background:#dbeafe;color:#1e40af;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">TT</span>'
            : s.role === 'BR'
            ? ' <span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">BR</span>'
            : '';
          return `<span style="display:inline-flex;align-items:center;gap:3px;background:#f1f5f9;padding:2px 7px;border-radius:99px;font-size:0.68rem;white-space:nowrap;">${escapeHtml(s.name)}${roleBadge}${s.buoiPhu ? ' <span style="color:#7c3aed;font-weight:700;font-size:0.6rem;">phụ</span>' : ''}</span>`;
        }).join(' ');
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:0.75rem;">
            <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;min-width:90px;">${escapeHtml(seg.start)} → ${escapeHtml(seg.end)}</span>
            <span style="font-weight:800;color:${countColor};min-width:20px;text-align:center;">${seg.count}</span>
            <div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;">${studentChips}</div>
          </div>`;
      }).join('');

      return `
      <div class="sam-teacher-row">
        <div class="sam-teacher-top">
          <div class="sam-teacher-info">
            <span class="sam-teacher-name">${escapeHtml(t.name)}</span>
            ${t.shift ? `<span class="sam-teacher-shift">${escapeHtml(t.shift)}</span>` : ''}
            <span style="background:#ede9fe;color:#7c3aed;font-size:0.65rem;font-weight:600;padding:2px 8px;border-radius:99px;">${escapeHtml(t.department || 'Supporter')}</span>
          </div>
          <button type="button" class="sam-assign-btn sam-assign-br"
            data-sched-id="${data.schedId}"
            data-email="${escapeHtml(t.email)}"
            data-student-email="${escapeHtml(data.studentEmail)}">Assign BR</button>
        </div>

        <div style="margin:8px 0 6px;padding:10px 12px;background:${sc.bg};border:1px solid ${sc.border};border-radius:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <i class="fa-solid ${sc.icon}" style="color:${sc.text};font-size:0.9rem;"></i>
            <span style="font-size:0.8rem;font-weight:700;color:${sc.text};">${escapeHtml(t.suitabilityLabel || '')}</span>
          </div>
          <div style="display:flex;gap:12px;font-size:0.75rem;color:#374151;flex-wrap:wrap;">
            <span>Lúc bắt đầu: <strong>${t.countAtStart || 0} HV</strong></span>
            <span>Cao điểm: <strong style="color:${sc.text};">${t.peakCount || 0} HV</strong></span>
            <span>Cả ngày: <strong>${t.totalStudentsOnDay} HV</strong></span>
          </div>
        </div>

        <div class="sam-reason">
          <span class="sam-reason-text" style="font-size:0.75rem;color:#6b7280;">${escapeHtml(t.reason)}</span>
        </div>

        ${(t.timeline && t.timeline.length > 0) ? `
        <div style="margin-top:8px;padding:10px 12px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;">
          <div style="font-size:0.68rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:8px;">
            <i class="fa-solid fa-chart-bar" style="margin-right:4px;"></i> Timeline trong giờ học của HV
          </div>
          <div style="display:flex;height:14px;border-radius:99px;overflow:hidden;gap:1px;margin-bottom:10px;">${timelineBarHtml}</div>
          <div style="display:flex;gap:10px;font-size:0.65rem;color:#9ca3af;margin-bottom:8px;flex-wrap:wrap;">
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#22c55e;margin-right:3px;"></span>0–3 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#eab308;margin-right:3px;"></span>4–6 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#ef4444;margin-right:3px;"></span>7+ HV</span>
          </div>
          ${segmentRows}
        </div>
        ` : ''}
      </div>`;
    }).join('');
    html += `</div>`;
  }

  } // end of breakout mode check

  // ---- TTKB SECTION ----
  if (mode === 'ttkb' || mode === 'both') {
  html += `
    <div class="sam-section">
      <div class="sam-section-title">
        <i class="fa-solid fa-chalkboard-user"></i>
        TTKB Teachers
        <span class="sam-section-count">${ttkb.length}</span>
      </div>
  `;

  if (ttkb.length === 0) {
    html += `<div class="sam-empty">Không có GV TTKB phù hợp vào giờ này</div>`;
  } else {
    html += ttkb.map((t, i) => {
      // Suitability colors (same pattern as Breakout)
      const suitColors = {
        good:     { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', barBg: '#22c55e', icon: 'fa-circle-check',  label: t.suitabilityLabel || 'Phù hợp' },
        ok:       { bg: '#fefce8', border: '#fde68a', text: '#a16207', barBg: '#eab308', icon: 'fa-circle-info',   label: t.suitabilityLabel || 'Chấp nhận được' },
        overload: { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', barBg: '#ef4444', icon: 'fa-triangle-exclamation', label: t.suitabilityLabel || 'Quá tải' }
      };
      const sc = suitColors[t.suitability] || suitColors.ok;
      const isBest = i === 0 && (t.suitability === 'good');

      // Build timeline bar (colored segments)
      const totalDur = (t.timeline || []).reduce((s, seg) => s + seg.duration, 0) || 1;
      const timelineBarHtml = (t.timeline || []).map(seg => {
        const pct = (seg.duration / totalDur * 100).toFixed(1);
        let segColor;
        if (seg.count === 0) segColor = '#e5e7eb';
        else if (seg.count <= 3) segColor = '#22c55e';
        else if (seg.count <= 6) segColor = '#eab308';
        else segColor = '#ef4444';
        return `<div style="width:${pct}%;height:100%;background:${segColor};position:relative;" title="${seg.start}–${seg.end}: ${seg.count} HV"></div>`;
      }).join('');

// Build sequential session view for TTKB — use WORK SHIFT + cursor logic
      const ttRawStudents = (t.allDayStudents || t.overlappingNames || [])
        .map(s => ({
          ...s,
          scheduledMin: timeToMinutes(s.time),
          baseDuration: s.duration || 0
        }))
        .sort((a, b) => a.scheduledMin - b.scheduledMin);

      // Work shift = actual working hours from meeting_content
      const ttWorkStart = t.workShiftStart ? timeToMinutes(t.workShiftStart) : null;
      const ttWorkEnd = t.workShiftEnd ? timeToMinutes(t.workShiftEnd) : null;
      const ttAvailStart = t.shiftStart ? timeToMinutes(t.shiftStart) : null;
      const ttAvailEnd = t.shiftEnd ? timeToMinutes(t.shiftEnd) : null;

      const ttShiftStart = ttWorkStart !== null ? ttWorkStart : (ttAvailStart !== null ? ttAvailStart : (ttRawStudents.length ? ttRawStudents[0].scheduledMin : 0));
      const ttShiftEnd = ttWorkEnd !== null ? ttWorkEnd : (ttAvailEnd !== null ? ttAvailEnd : (ttRawStudents.length ? Math.max(...ttRawStudents.map(s => s.scheduledMin + s.baseDuration)) : 0));

      // Extra available time badge
      const extraBefore = (ttAvailStart !== null && ttWorkStart !== null && ttAvailStart < ttWorkStart) ? (ttWorkStart - ttAvailStart) : 0;
      const extraAfter = (ttAvailEnd !== null && ttWorkEnd !== null && ttAvailEnd > ttWorkEnd) ? (ttAvailEnd - ttWorkEnd) : 0;
      const totalExtra = extraBefore + extraAfter;

      let extraAvailHtml = '';
      if (totalExtra > 0) {
        const extraParts = [];
        if (extraBefore > 0) extraParts.push(`${t.shiftStart} → ${t.workShiftStart}`);
        if (extraAfter > 0) extraParts.push(`${t.workShiftEnd} → ${t.shiftEnd}`);
        extraAvailHtml = `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;margin:0 0 6px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:0.72rem;">
            <span style="color:#1d4ed8;font-weight:700;white-space:nowrap;">
              <i class="fa-solid fa-clock-rotate-left" style="margin-right:3px;"></i>Rảnh thêm ${totalExtra}m
            </span>
            <span style="color:#6b7280;margin-left:auto;white-space:nowrap;">${extraParts.join(' · ')}</span>
          </div>`;
      }

      // Filter students within work shift
      const ttWorkStudents = ttWorkStart !== null
        ? ttRawStudents.filter(s => s.scheduledMin >= ttShiftStart || (s.scheduledMin + s.baseDuration) > ttShiftStart)
        : ttRawStudents;

      // Sequential cursor logic: each student starts after previous ends + 2min prep
      const PREP_MINS = 2;
      let ttCursor = ttShiftStart;
      const ttSequential = [];

      for (const s of ttWorkStudents) {
        if (s.baseDuration <= 0) continue;

        // Student starts at their scheduled time or after cursor (whichever is later)
        const actualStart = Math.max(s.scheduledMin, ttCursor);
        const actualEnd = actualStart + s.baseDuration;

        ttSequential.push({
          type: 'student',
          name: s.name,
          email: s.email,
          role: s.role,
          buoiPhu: s.buoiPhu,
          scheduledTime: s.time,
          startMin: actualStart,
          endMin: actualEnd,
          duration: s.baseDuration,
          time: String(Math.floor(actualStart/60)).padStart(2,'0')+':'+String(actualStart%60).padStart(2,'0'),
          endTime: String(Math.floor(actualEnd/60)).padStart(2,'0')+':'+String(actualEnd%60).padStart(2,'0')
        });

        // Move cursor past this student + prep time
        ttCursor = actualEnd + PREP_MINS;
        // Don't let prep extend past shift end
        if (ttCursor > ttShiftEnd) ttCursor = actualEnd;
      }

      // Find free gaps between sequential students (within work shift)
      const ttFreeGaps = [];
      let gapCursor = ttShiftStart;
      for (const s of ttSequential) {
        if (s.startMin > gapCursor) {
          ttFreeGaps.push({
            type: 'free',
            startMin: gapCursor,
            endMin: s.startMin,
            duration: s.startMin - gapCursor,
            start: String(Math.floor(gapCursor/60)).padStart(2,'0')+':'+String(gapCursor%60).padStart(2,'0'),
            end: String(Math.floor(s.startMin/60)).padStart(2,'0')+':'+String(s.startMin%60).padStart(2,'0')
          });
        }
        gapCursor = s.endMin + PREP_MINS;
        if (gapCursor > ttShiftEnd) gapCursor = s.endMin;
      }
      // Final free gap after last student
      if (ttShiftEnd > gapCursor) {
        ttFreeGaps.push({
          type: 'free',
          startMin: gapCursor,
          endMin: ttShiftEnd,
          duration: ttShiftEnd - gapCursor,
          start: String(Math.floor(gapCursor/60)).padStart(2,'0')+':'+String(gapCursor%60).padStart(2,'0'),
          end: String(Math.floor(ttShiftEnd/60)).padStart(2,'0')+':'+String(ttShiftEnd%60).padStart(2,'0')
        });
      }

      // Combine and sort by start time
      const ttSessionItems = [...ttSequential, ...ttFreeGaps]
        .sort((a, b) => a.startMin - b.startMin);

      const segmentRows = extraAvailHtml + ttSessionItems.map(item => {
        if (item.type === 'free') {
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;margin:2px 0;background:#f0fdf4;border:1px dashed #86efac;border-radius:6px;font-size:0.75rem;">
              <span style="color:#16a34a;font-weight:700;font-size:0.72rem;white-space:nowrap;">
                <i class="fa-solid fa-clock" style="margin-right:3px;"></i>Free ${item.duration}m
              </span>
              <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;margin-left:auto;">
                ${escapeHtml(item.start)} → ${escapeHtml(item.end)}
              </span>
            </div>`;
        }

        // Student session row
        const roleBadge = item.role === 'TT'
          ? ' <span style="background:#dbeafe;color:#1e40af;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">TT</span>'
          : item.role === 'BR'
          ? ' <span style="background:#fef3c7;color:#92400e;font-weight:700;font-size:0.55rem;padding:1px 4px;border-radius:99px;">BR</span>'
          : '';

        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:0.75rem;">
            <span style="font-variant-numeric:tabular-nums;color:#6b7280;white-space:nowrap;min-width:90px;">
              ${escapeHtml(item.time)} → ${escapeHtml(item.endTime)}
            </span>
            <div style="flex:1;display:flex;align-items:center;gap:4px;">
              <span style="display:inline-flex;align-items:center;gap:3px;background:#f1f5f9;padding:2px 7px;border-radius:99px;font-size:0.68rem;white-space:nowrap;">
                ${escapeHtml(item.name)}${roleBadge}${item.buoiPhu ? ' <span style="color:#7c3aed;font-weight:700;font-size:0.6rem;">phụ</span>' : ''}
              </span>
            </div>
            <span style="font-weight:600;color:#374151;font-size:0.72rem;white-space:nowrap;">${item.duration}m</span>
          </div>`;
      }).join('');

      return `
      <div class="sam-teacher-row ${isBest ? 'sam-best' : ''}">
        <div class="sam-teacher-top">
          <div class="sam-teacher-info">
            <span class="sam-teacher-name">${escapeHtml(t.name)}</span>
            ${t.shift ? `<span class="sam-teacher-shift">${escapeHtml(t.shift)}</span>` : ''}
            ${t.department ? (() => {
              const _dl = (t.department || '').toLowerCase();
              let _dbg = '#dbeafe', _dc = '#1e40af';
              if (_dl === 'supporter' || _dl === 'support') { _dbg = '#ede9fe'; _dc = '#7c3aed'; }
              else if (_dl === 'mix') { _dbg = '#fef3c7'; _dc = '#92400e'; }
              return `<span style="font-size:0.68rem;padding:2px 8px;border-radius:99px;font-weight:600;background:${_dbg};color:${_dc};">${escapeHtml(t.department)}</span>`;
            })() : ''}
          </div>
          <button type="button" class="sam-assign-btn sam-assign-tt"
            data-sched-id="${data.schedId}"
            data-email="${escapeHtml(t.email)}"
            data-student-email="${escapeHtml(data.studentEmail)}">Assign TT</button>
        </div>

        <div style="margin:8px 0 6px;padding:10px 12px;background:${sc.bg};border:1px solid ${sc.border};border-radius:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <i class="fa-solid ${sc.icon}" style="color:${sc.text};font-size:0.9rem;"></i>
            <span style="font-size:0.8rem;font-weight:700;color:${sc.text};">${escapeHtml(sc.label)}</span>
          </div>
          <div style="display:flex;gap:12px;font-size:0.75rem;color:#374151;flex-wrap:wrap;">
            <span>Lúc bắt đầu: <strong>${t.countAtStart || 0} HV</strong></span>
            <span>Cao điểm: <strong style="color:${sc.text};">${t.peakCount || 0} HV</strong></span>
            <span>Cả ngày: <strong>${t.totalStudentsOnDay} HV</strong></span>
          </div>
        </div>

        <div class="sam-reason">
          <span class="sam-reason-text" style="font-size:0.75rem;color:#6b7280;">
            ${escapeHtml(t.reason)}
          </span>
        </div>

        ${(t.timeline && t.timeline.length > 0) ? `
        <div style="margin-top:8px;padding:10px 12px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;">
          <div style="font-size:0.68rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:8px;">
            <i class="fa-solid fa-chart-bar" style="margin-right:4px;"></i> Timeline trong giờ học của HV
          </div>

          <div style="display:flex;height:14px;border-radius:99px;overflow:hidden;gap:1px;margin-bottom:10px;">
            ${timelineBarHtml}
          </div>

          <div style="display:flex;gap:10px;font-size:0.65rem;color:#9ca3af;margin-bottom:8px;flex-wrap:wrap;">
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#22c55e;margin-right:3px;"></span>0–3 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#eab308;margin-right:3px;"></span>4–6 HV</span>
            <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#ef4444;margin-right:3px;"></span>7+ HV</span>
          </div>

          ${segmentRows}
        </div>
        ` : ''}

        ${isBest ? '<div class="sam-best-label"><i class="fa-solid fa-star"></i> Phù hợp nhất</div>' : ''}
      </div>`;
    }).join('');
  }

  html += `</div>`;
  } // end of ttkb mode check

  body.innerHTML = html;

  // ---- ASSIGN CLICK HANDLERS ----
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('.sam-assign-btn');
    if (!btn) return;

    const schedId = btn.dataset.schedId;
    const email = btn.dataset.email;
    const studentEmail = btn.dataset.studentEmail;
    const isBR = btn.classList.contains('sam-assign-br');

    // Disable button while saving
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      // Level check — skip for breakout assignments (any teacher can manage breakout)
      if (!isBR) {
        const check = await checkLevelAssignment(email, studentEmail);
        if (!check.allowed) {
          const teacherName = window._teacherNameByEmail?.get(email) || email;
          overlay.remove();
          showLevelMismatchWarning(
            email, teacherName, check.studentLevel, check.allowedLevels,
            async () => {
              await doSmartAssign(schedId, email, isBR);
            },
            () => { }
          );
          return;
        }
      }

      await doSmartAssign(schedId, email, isBR);
      overlay.remove();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = isBR ? 'Assign BR' : 'Assign TT';
      alert(`Assignment failed: ${err?.message || 'Unknown error'}`);
      console.error(err);
    }
  });
}

async function doSmartAssign(schedId, teacherEmail, isBreakout) {
  const endpoint = isBreakout
    ? '/api/set-breakout-teacher-cal'
    : '/api/set-teacher';

  const bodyData = isBreakout
    ? { schedId, breakoutEmail: teacherEmail }
    : { schedId, teacherEmail };

  const rsp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyData)
  });
  const out = await rsp.json();
  if (!rsp.ok || !out?.ok) throw new Error(out?.error || 'Assign failed');

  // Refresh the board
  await renderCalendarBoard(true);
}

document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  setupPasswordToggle();
  setupLoginHandler();
  setupCalendarUI();       // Students popup
  // setupTeacherCalendarUI(); // removed: no teacher FAB/popup on main page
  setupBoardUI();          // Board toggles & refresh button
});