/* board.js — calendar.tansinh.info/board.html
 *
 * Direction C: every student is a card, every lesson is a slot you edit in
 * place, and a save bar appears only when a card has unsaved changes.
 *
 * It calls ONLY routes that already exist:
 *   cal-supabase-credentials   load-student-schedules   cal-student-quota
 *   save-student-schedule      delete-student-schedules cal-search-students
 *   set-teacher                set-breakout-teacher-cal find-suitable-teachers
 *
 * Every slot has TWO teachers: teacher_email (TT, the TTKB teacher) and
 * breakout_email (BR). A slot is "chưa có GV" when either is missing.
 */
(() => {
  'use strict';

  const TZ = 'Asia/Ho_Chi_Minh';
  const DAYS = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [0, 'CN']];
  const DAY_LABEL = Object.fromEntries(DAYS);

  let client = null;
  let currentUserId = '';

  // ------------------------------------------------------------------ state --
  const S = {
    students: [],            // {email, displayName, status, cap_lop_hoc}
    schedules: [],           // raw rows from load-student-schedules
    teachers: [],            // [{id:email, name:email}]
    teacherNames: {},        // email -> full name
    byStudent: new Map(),    // email -> { orig: slot[], cur: slot[], quota, dirty }
    filter: { q: '', teacher: '', missing: false, dirtyOnly: false },
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const normTime = t => { const s = String(t || '').trim(); if (!s) return ''; const [h = '0', m = '0'] = s.split(':'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const teacherLabel = em => em ? (S.teacherNames[em] || em.split('@')[0]) : '';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // load-student-schedules is the one GET route in this set; everything else is POST.
  async function api(path, body, method = 'POST') {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') opts.body = JSON.stringify(body || {});
    const rsp = await fetch('/api/' + path, opts);
    let json = null;
    try { json = await rsp.json(); } catch (_) { }
    if (!rsp.ok || !json || json.ok === false) {
      const step = json && json.step ? ` [${json.step}]` : '';
      throw new Error((json && json.error) ? `${json.error}${step}` : `HTTP ${rsp.status}`);
    }
    return json;
  }

  // ------------------------------------------------------------------- boot --
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      const res = await fetch('/api/cal-supabase-credentials');
      if (!res.ok) throw new Error('Failed to load credentials');
      const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();
      client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
      });
      const { data: { session } } = await client.auth.getSession();
      if (session) await showApp(session); else showLogin();
      client.auth.onAuthStateChange((_e, sess) => { if (sess && $('cbBoard').classList.contains('hidden')) showApp(sess); });
    } catch (e) {
      console.error(e);
      tsToast('Không tải được trang. Vui lòng tải lại.', 'error');
    }

    $('login')?.addEventListener('click', doLogin);
    $('password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    $('togglePwd')?.addEventListener('click', () => { const p = $('password'); p.type = p.type === 'password' ? 'text' : 'password'; });
  }

  function showLogin() { $('loginCard').style.display = ''; $('cbBoard').classList.add('hidden'); document.body.classList.remove('cb-app'); }

  async function doLogin() {
    const email = $('email').value.trim(), password = $('password').value;
    const msg = $('message');
    if (!email || !password) { msg.textContent = 'Nhập email và mật khẩu.'; msg.className = 'error'; return; }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) { msg.textContent = error.message; msg.className = 'error'; } else { msg.textContent = ''; }
  }

  async function showApp(session) {
    currentUserId = session?.user?.id || '';
    $('loginCard').style.display = 'none';
    $('cbBoard').classList.remove('hidden');
    document.body.classList.add('cb-app');   // style.css centres <body> for the login card; the board must not be
    wireUI();
    await loadAll();
  }

  // ------------------------------------------------------------------- data --
  async function loadAll(quiet = false) {
    if (!quiet) spinner(true);
    try {
      const out = await api('load-student-schedules', null, 'GET');
      const d = out.data || {};
      S.students = d.students || [];
      S.schedules = d.schedules || [];
      S.teachers = d.teachers || [];
      S.teacherNames = d.teacherNamesByEmail || {};

      // Keep any unsaved edits across a reload: only rebuild students that are not dirty.
      const fresh = new Map();
      for (const st of S.students) {
        const rows = S.schedules.filter(r => r.student_email === st.email).map(rowToSlot).sort(bySlot);
        const prev = S.byStudent.get(st.email);
        if (prev && prev.dirty) { prev.orig = rows; fresh.set(st.email, prev); }
        else fresh.set(st.email, { orig: rows, cur: rows.map(s => ({ ...s })), quota: prev?.quota || null, dirty: false, saving: false });
      }
      // students added on this page but not yet saved
      for (const [em, rec] of S.byStudent) if (rec.added && !fresh.has(em)) fresh.set(em, rec);
      S.byStudent = fresh;

      fillTeacherFilter();
      render();
    } catch (e) {
      console.error(e);
      tsToast('Tải dữ liệu thất bại: ' + e.message, 'error');
    } finally { if (!quiet) spinner(false); }
  }

  function rowToSlot(r) {
    return {
      id: r.id, day: Number(r.day_of_week), time: normTime(r.time_local), bp: !!r.buoi_phu,
      n: Math.max(1, Number(r.sessions_per_day) || 1), tt: r.teacher_email || '', br: r.breakout_email || ''
    };
  }
  // chính first, then phụ — so the two groups are contiguous and can be divided on the card
  const bySlot = (a, b) => (Number(a.bp) - Number(b.bp)) || ((a.day === 0 ? 7 : a.day) - (b.day === 0 ? 7 : b.day)) || a.time.localeCompare(b.time);
  const slotKey = s => `${s.day}|${s.time}|${s.bp ? 1 : 0}`;
  // A buổi phụ has NO TTKB teacher by rule — only a Breakout teacher. So a phụ slot
  // is "missing" only when BR is empty; a chính slot when either is empty.
  const needsTT = s => !s.bp;
  const slotMissing = s => !s.br || (needsTT(s) && !s.tt);

  function isDirty(rec) {
    const a = rec.orig.map(s => `${slotKey(s)}|${s.n}`).sort().join(';');
    const b = rec.cur.filter(s => s.time).map(s => `${slotKey(s)}|${s.n}`).sort().join(';');
    return a !== b || rec.cur.some(s => !s.time);
  }

  function studentOf(email) { return S.students.find(s => s.email === email) || { email, displayName: email, status: '', cap_lop_hoc: '' }; }

  function fillTeacherFilter() {
    const sel = $('cbTeacher');
    const cur = sel.value;
    const emails = new Set();
    for (const r of S.schedules) { if (r.teacher_email) emails.add(r.teacher_email); if (r.breakout_email) emails.add(r.breakout_email); }
    for (const t of S.teachers) emails.add(t.id);
    const list = [...emails].filter(Boolean).sort((a, b) => teacherLabel(a).localeCompare(teacherLabel(b)));
    sel.innerHTML = '<option value="">Tất cả GV</option>' + list.map(e => `<option value="${esc(e)}">${esc(teacherLabel(e))}</option>`).join('');
    sel.value = cur;
  }

  // ----------------------------------------------------------------- render --
  function visibleStudents() {
    const q = S.filter.q.trim().toLowerCase();
    return [...S.byStudent.entries()].filter(([email, rec]) => {
      const st = studentOf(email);
      if (q && !(`${st.displayName} ${email}`.toLowerCase().includes(q))) return false;
      if (S.filter.teacher && !rec.cur.some(s => s.tt === S.filter.teacher || s.br === S.filter.teacher)) return false;
      if (S.filter.missing && !rec.cur.some(slotMissing)) return false;
      if (S.filter.dirtyOnly && !rec.dirty) return false;
      return true;
    }).sort((a, b) => studentOf(a[0]).displayName.localeCompare(studentOf(b[0]).displayName));
  }

  function render() {
    const list = $('cbList');
    const vis = visibleStudents();
    const y = window.scrollY;                       // a full re-render must not move the page
    list.innerHTML = vis.map(([email, rec]) => cardHTML(email, rec)).join('');
    window.scrollTo({ top: y, behavior: 'instant' });
    renderSide();
    $('cbEmpty').hidden = vis.length > 0;

    const missingN = [...S.byStudent.values()].filter(r => r.cur.some(slotMissing)).length;
    const dirtyN = [...S.byStudent.values()].filter(r => r.dirty).length;
    $('cbMissingN').textContent = missingN;
    $('cbDirtyN').textContent = dirtyN;
    $('cbDirtyOnly').hidden = dirtyN === 0;
    if (dirtyN === 0 && S.filter.dirtyOnly) { S.filter.dirtyOnly = false; $('cbDirtyOnly').setAttribute('aria-pressed', 'false'); }
    $('cbCount').textContent = `${vis.length} / ${S.byStudent.size} học viên`;
  }

  function renderCard(email) {
    const rec = S.byStudent.get(email);
    const old = document.querySelector(`.cb-card[data-email="${CSS.escape(email)}"]`);
    if (!rec) { old?.remove(); renderSide(); return; }
    rec.dirty = isDirty(rec);
    // remember what the user is doing so rebuilding the card is invisible to them
    const a = document.activeElement;
    const keep = (a && old && old.contains(a)) ? {
      f: a.dataset.f, i: a.dataset.i, act: a.dataset.act, kind: a.dataset.kind,
      s0: a.selectionStart, s1: a.selectionEnd
    } : null;
    const y = window.scrollY;
    const tmp = document.createElement('div');
    tmp.innerHTML = cardHTML(email, rec);
    const fresh = tmp.firstElementChild;
    if (old) old.replaceWith(fresh); else $('cbList').prepend(fresh);
    window.scrollTo({ top: y, behavior: 'instant' });
    if (keep) {
      const sel = keep.f ? `[data-f="${keep.f}"][data-i="${keep.i}"]`
        : keep.act ? `[data-act="${keep.act}"][data-i="${keep.i}"]${keep.kind ? `[data-kind="${keep.kind}"]` : ''}` : null;
      const el = sel && fresh.querySelector(sel);
      if (el) { el.focus({ preventScroll: true }); if (keep.s0 != null && el.setSelectionRange) { try { el.setSelectionRange(keep.s0, keep.s1); } catch (_) { } } }
    }
    renderSide();
    // counters without a full re-render
    const missingN = [...S.byStudent.values()].filter(r => r.cur.some(slotMissing)).length;
    const dirtyN = [...S.byStudent.values()].filter(r => r.dirty).length;
    $('cbMissingN').textContent = missingN; $('cbDirtyN').textContent = dirtyN; $('cbDirtyOnly').hidden = dirtyN === 0;
  }

  function quotaHTML(rec) {
    const q = rec.quota;
    const main = rec.cur.filter(s => s.time && !s.bp).reduce((n, s) => n + s.n, 0);
    const extra = rec.cur.filter(s => s.time && s.bp).reduce((n, s) => n + s.n, 0);
    if (!q) return `<span class="cb-quota" title="Buổi chính · buổi phụ đã xếp"><i class="fa-regular fa-clock"></i> ${main} chính · ${extra} phụ</span>`;
    if (!q.found || q.main === null || q.extra === null) return `<span class="cb-quota unset" title="Chưa đặt số buổi trong danhsachhv"><i class="fa-solid fa-triangle-exclamation"></i> ${main} chính · ${extra} phụ · chưa đặt chỉ tiêu</span>`;
    const ok = main === q.main && extra === q.extra;
    return `<span class="cb-quota ${ok ? 'ok' : 'bad'}" title="Đã xếp / chỉ tiêu trong danhsachhv"><i class="fa-solid ${ok ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> ${main}/${q.main} chính · ${extra}/${q.extra} phụ</span>`;
  }

  const DAY_CLS = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };

  // What is special about this card, said in words. Replaces the coloured bar.
  function conditionChips(rec) {
    const chips = [];
    const noTT = rec.cur.filter(s => s.id && needsTT(s) && !s.tt).map(s => DAY_LABEL[s.day]);
    const noBR = rec.cur.filter(s => s.id && !s.br).map(s => DAY_LABEL[s.day]);
    if (noTT.length) chips.push(`<span class="cb-cond danger" title="Chưa gán giáo viên TTKB"><i class="fa-solid fa-user-xmark"></i> Thiếu GV TT · ${noTT.join(', ')}</span>`);
    if (noBR.length) chips.push(`<span class="cb-cond danger" title="Chưa gán giáo viên Breakout"><i class="fa-solid fa-user-xmark"></i> Thiếu GV BR · ${noBR.join(', ')}</span>`);
    const extra = rec.cur.filter(s => s.bp);
    if (extra.length) chips.push(`<span class="cb-cond extra" title="Buổi phụ"><i class="fa-solid fa-plus"></i> ${extra.length} buổi phụ · ${extra.map(s => DAY_LABEL[s.day]).join(', ')}</span>`);
    if (rec.added) chips.push(`<span class="cb-cond new"><i class="fa-solid fa-sparkles"></i> Học viên mới, chưa lưu</span>`);
    return chips.join('');
  }

  function cardHTML(email, rec) {
    const st = studentOf(email);
    const firstExtra = rec.cur.findIndex(s => s.bp);
    const slots = rec.cur.map((s, i) =>
      (i === firstExtra ? `<div class="cb-divider" title="Buổi phụ"><span>Buổi phụ</span></div>` : '') + slotHTML(s, i, rec.orig)).join('');
    let bar = '';
    if (rec.dirty) {
      const problems = saveProblems(rec);
      bar = `<div class="cb-savebar ${problems ? 'bad' : ''}">
        <i class="fa-solid ${problems ? 'fa-circle-exclamation' : 'fa-pen'}"></i>
        <span class="msg">${problems || changeSummary(rec)}</span>
        <button type="button" data-act="revert">Hoàn tác</button>
        <button type="button" class="primary" data-act="save" ${problems ? 'disabled' : ''}>Lưu</button>
      </div>`;
    }
    return `<article class="cb-card ${rec.dirty ? 'dirty' : ''} ${rec.saving ? 'saving' : ''}" data-email="${esc(email)}">
      <div class="cb-card-head">
        <span class="cb-name">${esc(st.displayName)}</span>
        ${st.status !== '' ? `<span class="cb-status" title="Trạng thái (phút mỗi buổi)">${esc(st.status)}</span>` : ''}
        ${st.cap_lop_hoc ? `<span class="cb-level">${esc(st.cap_lop_hoc)}</span>` : ''}
        ${quotaHTML(rec)}
        <span class="cb-conds">${conditionChips(rec)}</span>
        <div class="cb-card-actions">
          <button type="button" class="cb-act danger" data-act="delete" title="Xoá toàn bộ lịch học của ${esc(st.displayName)}" aria-label="Xoá lịch học"><i class="fa-regular fa-trash-can"></i></button>
        </div>
      </div>
      <div class="cb-slots">
        ${slots}
        <button type="button" class="cb-slot-add" data-act="add"><i class="fa-solid fa-plus"></i> Thêm ngày</button>
      </div>
      ${bar}
    </article>`;
  }

  function slotHTML(s, i, orig) {
    const isNew = !s.id;
    const o = s.id ? orig.find(x => x.id === s.id) : null;
    const changed = o && (o.day !== s.day || o.time !== s.time || o.bp !== s.bp || o.n !== s.n);
    const cls = ['cb-slot', DAY_CLS[s.day] || '', isNew ? 'new' : '', changed ? 'changed' : '', s.bp ? 'bp' : ''].join(' ');
    const dayOpts = DAYS.map(([v, t]) => `<option value="${v}" ${v === s.day ? 'selected' : ''}>${t}</option>`).join('');
    const gvBtn = (kind, em) => `<button type="button" class="pick ${em ? '' : 'empty'}" data-act="gv" data-kind="${kind}" data-i="${i}" ${isNew ? 'disabled title="Lưu ngày này trước rồi mới gán GV"' : ''}>${em ? esc(teacherLabel(em)) : '+ chọn GV'}</button>`;
    return `<div class="${cls}" data-i="${i}">
      ${s.bp ? '<span class="cb-ribbon">Phụ</span>' : ''}
      <div class="cb-slot-row">
        <select class="day" data-f="day" data-i="${i}" aria-label="Ngày">${dayOpts}</select>
        <span class="cb-time-wrap"><input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" value="${esc(s.time)}" data-f="time" data-i="${i}" aria-label="Giờ" class="time ${s.time ? '' : 'empty'}"><button type="button" class="cb-time-btn" data-act="tpick" data-i="${i}" tabindex="-1" title="Chọn giờ" aria-label="Chọn giờ"><i class="fa-regular fa-clock"></i></button></span>
        <button type="button" class="rm" data-act="rm" data-i="${i}" title="Bỏ ngày này" aria-label="Bỏ ngày này"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="cb-slot-row">
        <span class="cb-seg" role="radiogroup" aria-label="Loại buổi">
          <button type="button" data-act="bp" data-v="0" data-i="${i}" class="${s.bp ? '' : 'on'}" role="radio" aria-checked="${!s.bp}">Chính</button>
          <button type="button" data-act="bp" data-v="1" data-i="${i}" class="${s.bp ? 'on' : ''}" role="radio" aria-checked="${s.bp}">Phụ</button>
        </span>
        <span class="cb-n" title="Số buổi trong ngày này"><input type="number" min="1" max="9" value="${s.n}" data-f="n" data-i="${i}" aria-label="Số buổi"><em>buổi</em></span>
      </div>
      ${needsTT(s)
        ? `<div class="cb-gv"><span class="tag tt" title="Giáo viên TTKB">TT</span>${gvBtn('tt', s.tt)}</div>`
        : (s.tt ? `<div class="cb-gv stale" title="Buổi phụ không cần GV TTKB — bấm × để bỏ gán"><span class="tag tt">TT</span><span class="note">${esc(teacherLabel(s.tt))} · không cần cho buổi phụ</span><button type="button" class="rm" data-act="gvclear" data-kind="tt" data-i="${i}" aria-label="Bỏ gán TT"><i class="fa-solid fa-xmark"></i></button></div>` : '')}
      <div class="cb-gv"><span class="tag br" title="Giáo viên Breakout">BR</span>${gvBtn('br', s.br)}</div>
    </div>`;
  }

  function changeSummary(rec) {
    const o = new Map(rec.orig.map(s => [s.id, s]));
    let added = 0, removed = 0, changed = 0;
    for (const s of rec.cur) { if (!s.id) added++; else { const x = o.get(s.id); if (x && (x.day !== s.day || x.time !== s.time || x.bp !== s.bp || x.n !== s.n)) changed++; } }
    for (const s of rec.orig) if (!rec.cur.some(c => c.id === s.id)) removed++;
    const parts = [];
    if (added) parts.push(`thêm ${added}`); if (changed) parts.push(`sửa ${changed}`); if (removed) parts.push(`bỏ ${removed}`);
    return parts.length ? `Chưa lưu: ${parts.join(', ')} buổi.` : 'Chưa lưu.';
  }

  // Why the save button is disabled, or '' when it can be pressed.
  function saveProblems(rec) {
    if (rec.cur.some(s => !s.time)) return 'Có buổi chưa chọn giờ.';
    const keys = rec.cur.map(slotKey);
    if (new Set(keys).size !== keys.length) return 'Có hai buổi trùng ngày và giờ.';
    const q = rec.quota;
    if (!q) return '';   // not fetched yet — the save handler fetches before it writes
    if (!q.found || q.main === null || q.extra === null) return 'Chưa đặt số buổi chính/phụ trong <a href="https://danhsachhv.tansinh.info" target="_blank" rel="noopener">danhsachhv</a>.';
    const main = rec.cur.filter(s => !s.bp).reduce((n, s) => n + s.n, 0);
    const extra = rec.cur.filter(s => s.bp).reduce((n, s) => n + s.n, 0);
    if (main !== q.main || extra !== q.extra) return `Chỉ tiêu là ${q.main} chính · ${q.extra} phụ (đang xếp ${main} · ${extra}). Đổi chỉ tiêu trong <a href="https://danhsachhv.tansinh.info" target="_blank" rel="noopener">danhsachhv</a> hoặc sửa lịch.`;
    return '';
  }

  async function ensureQuota(email) {
    const rec = S.byStudent.get(email);
    if (rec.quota) return rec.quota;
    try {
      const j = await api('cal-student-quota', { email });
      rec.quota = { found: !!j.found, main: j.main ?? null, extra: j.extra ?? null };
    } catch (e) {
      rec.quota = null;
      tsToast('Không đọc được chỉ tiêu buổi học: ' + e.message, 'warn');
    }
    return rec.quota;
  }

  // ------------------------------------------------------------- interaction --
  function wireUI() {
    const list = $('cbList');

    list.addEventListener('input', e => {
      const el = e.target.closest('[data-f]'); if (!el) return;
      const card = el.closest('.cb-card'); const email = card.dataset.email; const rec = S.byStudent.get(email);
      const s = rec.cur[Number(el.dataset.i)]; if (!s) return;
      const f = el.dataset.f;
      if (f === 'day') s.day = Number(el.value);
      else if (f === 'time') {
        // auto-insert the colon as they type: "19" -> "19:", "1930" -> "19:30"
        let v = el.value.replace(/[^\d:]/g, '');
        if (/^\d{3,4}$/.test(v)) v = v.slice(0, 2) + ':' + v.slice(2);
        if (v !== el.value) el.value = v;
        s.time = /^\d{1,2}:\d{2}$/.test(v) ? normTime(v) : '';
      }
      else if (f === 'n') s.n = Math.max(1, Math.min(9, Number(el.value) || 1));
      rec.cur.sort(bySlot);
      const wasDirty = rec.dirty;
      rec.dirty = isDirty(rec);
      if (rec.dirty && !rec.quota) ensureQuota(email).then(() => renderCard(email));
      // re-render the card; renderCard keeps focus, caret and scroll where they were
      if (f !== 'time' || /^\d{2}:\d{2}$/.test(el.value)) renderCard(email);
      void wasDirty;
    });

    list.addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const card = btn.closest('.cb-card'); const email = card.dataset.email; const rec = S.byStudent.get(email);
      const act = btn.dataset.act;
      if (act === 'add') {
        rec.cur.push({ id: null, day: 1, time: '', bp: false, n: 1, tt: '', br: '' });
        rec.dirty = true; renderCard(email);
        card.querySelector('.cb-slot.new:last-of-type input[type="time"]')?.focus();
        ensureQuota(email).then(() => renderCard(email));
      }
      else if (act === 'bp') {
        const sl = rec.cur[Number(btn.dataset.i)]; if (!sl) return;
        sl.bp = btn.dataset.v === '1'; rec.cur.sort(bySlot); rec.dirty = isDirty(rec);
        ensureQuota(email).then(() => renderCard(email)); renderCard(email);
      }
      else if (act === 'rm') { rec.cur.splice(Number(btn.dataset.i), 1); rec.dirty = isDirty(rec); ensureQuota(email).then(() => renderCard(email)); renderCard(email); }
      else if (act === 'revert') { rec.cur = rec.orig.map(s => ({ ...s })); rec.dirty = false; if (rec.added) { S.byStudent.delete(email); render(); } else renderCard(email); }
      else if (act === 'save') await saveStudent(email);
      else if (act === 'delete') await deleteStudent(email);
      else if (act === 'gv') openTeacherPicker(btn, email, Number(btn.dataset.i), btn.dataset.kind);
      else if (act === 'gvclear') {
        const sl = rec.cur[Number(btn.dataset.i)]; if (!sl || !sl.id) return;
        try {
          await api('set-teacher', { schedId: sl.id, teacherEmail: '' });
          for (const arr of [rec.cur, rec.orig]) { const r = arr.find(x => x.id === sl.id); if (r) r.tt = ''; }
          const raw = S.schedules.find(x => x.id === sl.id); if (raw) raw.teacher_email = null;
          renderCard(email); tsToast('Đã bỏ GV TT khỏi buổi phụ.', 'ok');
        } catch (e) { tsToast('Bỏ gán thất bại: ' + e.message, 'error'); }
      }
      else if (act === 'tpick') openTimePicker(btn, email, Number(btn.dataset.i));
    });

    // leaving a time field: normalise "7:5" -> "07:05", or flag it red if it is not a time
    list.addEventListener('focusout', e => {
      const el = e.target; if (!el.matches || !el.matches('input.time')) return;
      const email = el.closest('.cb-card').dataset.email; const rec = S.byStudent.get(email);
      const sl = rec.cur[Number(el.dataset.i)]; if (!sl) return;
      const v = normTime(el.value);
      const ok = /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      sl.time = ok ? v : '';
      rec.cur.sort(bySlot); rec.dirty = isDirty(rec);
      renderCard(email);
    });

    $('cbSearch').addEventListener('input', e => { S.filter.q = e.target.value; render(); });
    $('cbSearchClear').addEventListener('click', () => { $('cbSearch').value = ''; S.filter.q = ''; render(); });
    $('cbTeacher').addEventListener('change', e => { S.filter.teacher = e.target.value; render(); });
    $('cbMissing').addEventListener('click', e => { S.filter.missing = !S.filter.missing; e.currentTarget.setAttribute('aria-pressed', String(S.filter.missing)); render(); });
    $('cbDirtyOnly').addEventListener('click', e => { S.filter.dirtyOnly = !S.filter.dirtyOnly; e.currentTarget.setAttribute('aria-pressed', String(S.filter.dirtyOnly)); render(); });
    $('cbRefresh').addEventListener('click', () => loadAll(false));
    $('cbSide').addEventListener('click', e => {
      if (e.target.closest('[data-side="hide"]')) { setSideCollapsed(true); renderSide(); return; }
      if (e.target.closest('[data-side="show"]')) { setSideCollapsed(false); renderSide(); return; }
      const b = e.target.closest('[data-goto]'); if (b) gotoStudent(b.dataset.goto);
    });
    $('cbSideToggle').addEventListener('click', () => { setSideCollapsed(!sideCollapsed()); renderSide(); });
    wireAddStudent();

    window.addEventListener('beforeunload', e => {
      if ([...S.byStudent.values()].some(r => r.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ------------------------------------------------------------------- save --
  async function saveStudent(email) {
    const rec = S.byStudent.get(email);
    if (!currentUserId) { tsToast('Phiên đăng nhập đã hết. Tải lại trang.', 'error'); return; }
    if (!rec.quota) await ensureQuota(email);
    const problem = saveProblems(rec);
    if (problem) { renderCard(email); return; }

    const desired = rec.cur.filter(s => s.time).map(s => ({ day_of_week: s.day, time_local: s.time, buoi_phu: s.bp, sessions_per_day: s.n, timezone: TZ }));
    rec.saving = true; renderCard(email);
    try {
      const out = await api('save-student-schedule', { studentEmail: email, desired, tz: TZ, currentUserId, allowEmpty: desired.length === 0 });
      const bits = [];
      if (out.inserted) bits.push(`thêm ${out.inserted}`); if (out.moved) bits.push(`đổi giờ ${out.moved}`);
      if (out.toggled) bits.push(`đổi chính/phụ ${out.toggled}`); if (out.deleted) bits.push(`bỏ ${out.deleted}`);
      if (out.numberUpdated) bits.push(`đổi số buổi ${out.numberUpdated}`);
      tsToast(`Đã lưu ${studentOf(email).displayName}${bits.length ? ': ' + bits.join(', ') : ''}.`, 'ok');
      if (Array.isArray(out.carried) && out.carried.length) {
        for (const c of out.carried) {
          const [d, t] = String(c.to).split('|');
          tsToast(`GV ${teacherLabel(c.teacher_email)} được chuyển sang ${DAY_LABEL[Number(d)]} ${t} — kiểm tra lại lịch rảnh của GV.`, 'warn', 7000);
        }
      }
      rec.dirty = false; rec.saving = false; rec.added = false;
      await loadAll(true);            // background refresh; render() keeps the scroll position
    } catch (e) {
      console.error(e);
      rec.saving = false; renderCard(email);
      tsToast('Lưu không thành công: ' + e.message, 'error', 6000);
    }
  }

  async function deleteStudent(email) {
    const rec = S.byStudent.get(email);
    const st = studentOf(email);
    if (rec.added) { S.byStudent.delete(email); render(); return; }
    const n = rec.orig.length;
    const ok = await tsConfirm({
      title: 'Xoá lịch học?',
      message: `Xoá toàn bộ lịch học của <strong>${esc(st.displayName)}</strong>?`,
      detail: (n ? `${n} buổi học sẽ bị xoá. ` : '') + 'Thao tác này không thể hoàn tác.',
      confirmLabel: 'Xoá lịch học', cancelLabel: 'Huỷ', icon: 'fa-trash', danger: true
    });
    if (!ok) return;
    rec.saving = true; renderCard(email);
    try {
      const out = await api('delete-student-schedules', { email });
      tsToast(`Đã xoá ${out.deleted ?? n} buổi học của ${st.displayName}.`, 'ok');
      S.byStudent.delete(email);       // no rows left, so the board no longer lists them
      renderCard(email);
    } catch (e) {
      rec.saving = false; renderCard(email);
      tsToast('Xoá không thành công: ' + e.message, 'error', 6000);
    }
  }

  // ------------------------------------------------------------- add student --
  function wireAddStudent() {
    const inp = $('cbAddInput'), box = $('cbAddList');
    let timer = null, seq = 0;
    inp.addEventListener('input', () => {
      const q = inp.value.trim();
      clearTimeout(timer);
      if (q.length < 3) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const j = await api('cal-search-students', { q });
          if (my !== seq) return;
          const rows = (j.rows || []).filter(r => !S.byStudent.has(r.email));
          box.innerHTML = rows.length
            ? rows.map(r => `<button type="button" data-email="${esc(r.email)}">${esc(r.email)}</button>`).join('')
            : '<div class="cb-add-note">Không thấy, hoặc học viên đã có trong bảng.</div>';
          box.hidden = false;
        } catch (e) { box.innerHTML = `<div class="cb-add-note">${esc(e.message)}</div>`; box.hidden = false; }
      }, 250);
    });
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-email]'); if (!b) return;
      const email = b.dataset.email;
      if (!S.students.some(s => s.email === email)) S.students.push({ email, displayName: email, status: '', cap_lop_hoc: '' });
      S.byStudent.set(email, { orig: [], cur: [{ id: null, day: 1, time: '', bp: false, n: 1, tt: '', br: '' }], quota: null, dirty: true, saving: false, added: true });
      inp.value = ''; box.hidden = true;
      S.filter.q = ''; $('cbSearch').value = '';
      render();
      ensureQuota(email).then(() => renderCard(email));
      document.querySelector(`.cb-card[data-email="${CSS.escape(email)}"]`)?.scrollIntoView({ block: 'center' });
    });
    document.addEventListener('click', e => { if (!e.target.closest('.cb-add')) box.hidden = true; });
  }

  // ----------------------------------------------------------- teacher picker --
  function openTeacherPicker(anchor, email, i, kind) {
    closePicker();
    const rec = S.byStudent.get(email); const s = rec.cur[i]; if (!s || !s.id) return;
    const cur = kind === 'tt' ? s.tt : s.br;
    const pop = document.createElement('div');
    pop.className = 'cb-pop'; pop.id = 'cbPop';
    const all = [...new Set([...S.teachers.map(t => t.id), ...Object.keys(S.teacherNames)])].filter(Boolean)
      .sort((a, b) => teacherLabel(a).localeCompare(teacherLabel(b)));
    const item = (em, extra = '') => `<button type="button" class="cb-pop-item" data-em="${esc(em)}"><span>${esc(teacherLabel(em))}</span>${extra}<span class="em">${esc(em.split('@')[0])}</span></button>`;
    pop.innerHTML = `
      <div class="cb-pop-head"><span class="tag ${kind}">${kind.toUpperCase()}</span> ${DAY_LABEL[s.day]} ${esc(s.time)}${s.bp ? ' · phụ' : ''}
        <button type="button" class="sug" data-sug="1"><i class="fa-solid fa-wand-magic-sparkles"></i> Gợi ý</button></div>
      <div class="cb-pop-search"><input type="text" placeholder="Lọc GV…" autocomplete="off"></div>
      <div class="cb-pop-body">${cur ? `<button type="button" class="cb-pop-item clear" data-em=""><i class="fa-solid fa-user-minus"></i> Bỏ gán ${esc(teacherLabel(cur))}</button>` : ''}${all.map(em => item(em)).join('')}</div>`;
    document.body.appendChild(pop);
    place(pop, anchor);
    const inp = pop.querySelector('input'); inp.focus();

    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      for (const b of pop.querySelectorAll('.cb-pop-item:not(.clear)')) b.hidden = q && !(`${teacherLabel(b.dataset.em)} ${b.dataset.em}`.toLowerCase().includes(q));
    });
    pop.querySelector('[data-sug]').addEventListener('click', async ev => {
      const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Đang tính…';
      try {
        const j = await api('find-suitable-teachers', { day_of_week: s.day, time_local: s.time, student_email: email });
        const list = kind === 'tt' ? (j.ttkbTeachers || []) : (j.breakoutTeachers || []);
        const body = pop.querySelector('.cb-pop-body');
        if (!list.length) { body.innerHTML = '<div class="cb-pop-note">Không có GV nào rảnh khung giờ này.</div>' + all.map(em => item(em)).join(''); return; }
        body.innerHTML = `<div class="cb-pop-note">Rảnh khung giờ này, ít bận nhất trước:</div>` +
          list.map(t => item(t.email, `<span class="load ${t.suitability || 'good'}" title="Số HV cùng lúc cao nhất: ${t.peakCount ?? '?'}">${t.peakCount ?? '–'}</span>`)).join('') +
          `<div class="cb-pop-note">Tất cả GV:</div>` + all.filter(em => !list.some(t => t.email === em)).map(em => item(em)).join('');
      } catch (e) { tsToast('Gợi ý thất bại: ' + e.message, 'error'); }
      finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Gợi ý'; }
    });
    pop.addEventListener('click', async ev => {
      const b = ev.target.closest('.cb-pop-item'); if (!b) return;
      const em = b.dataset.em || '';
      closePicker();
      try {
        if (kind === 'tt') await api('set-teacher', { schedId: s.id, teacherEmail: em });
        else await api('set-breakout-teacher-cal', { schedId: s.id, breakoutEmail: em });
        // update the row in place (both cur and orig — teacher is saved immediately, it is not part of the dirty diff)
        for (const arr of [rec.cur, rec.orig]) { const r = arr.find(x => x.id === s.id); if (r) r[kind] = em; }
        const raw = S.schedules.find(x => x.id === s.id); if (raw) raw[kind === 'tt' ? 'teacher_email' : 'breakout_email'] = em || null;
        renderCard(email);   // renderCard also redraws the side panel
        tsToast(em ? `Đã gán ${teacherLabel(em)} (${kind.toUpperCase()}) cho ${DAY_LABEL[s.day]} ${s.time}.` : `Đã bỏ gán GV ${kind.toUpperCase()}.`, 'ok');
      } catch (e) { tsToast('Gán GV thất bại: ' + e.message, 'error', 6000); }
    });
    setTimeout(() => document.addEventListener('mousedown', outsideClose, { once: true }), 0);
    function outsideClose(ev) { if (!pop.contains(ev.target)) closePicker(); else document.addEventListener('mousedown', outsideClose, { once: true }); }
    document.addEventListener('keydown', escClose);
    function escClose(ev) { if (ev.key === 'Escape') { closePicker(); document.removeEventListener('keydown', escClose); } }
  }
  function closePicker() { $('cbPop')?.remove(); }

  // A 24-hour picker: hour grid + five-minute chips. Writes HH:MM into the text
  // field and fires its input event so the normal edit path runs.
  function openTimePicker(anchor, email, i) {
    closePicker();
    const rec = S.byStudent.get(email); const sl = rec.cur[i]; if (!sl) return;
    const input = anchor.parentElement.querySelector('input.time');
    let [h, m] = (normTime(input.value) || '18:00').split(':').map(Number);
    const pop = document.createElement('div'); pop.className = 'cb-pop cb-tpop'; pop.id = 'cbPop';
    const hours = Array.from({ length: 24 }, (_, x) => x), mins = Array.from({ length: 12 }, (_, x) => x * 5);
    const pad = n => String(n).padStart(2, '0');
    const draw = () => {
      pop.innerHTML = `<div class="cb-pop-head"><i class="fa-regular fa-clock"></i> ${DAY_LABEL[sl.day]} · <strong>${pad(h)}:${pad(m)}</strong></div>
        <div class="cb-tp-label">Giờ</div>
        <div class="cb-tp-grid h">${hours.map(x => `<button type="button" data-h="${x}" class="${x === h ? 'on' : ''} ${x >= 6 && x <= 21 ? '' : 'dim'}">${pad(x)}</button>`).join('')}</div>
        <div class="cb-tp-label">Phút</div>
        <div class="cb-tp-grid m">${mins.map(x => `<button type="button" data-m="${x}" class="${x === m ? 'on' : ''}">${pad(x)}</button>`).join('')}</div>`;
    };
    draw();
    document.body.appendChild(pop); place(pop, anchor);
    const commit = (close) => {
      input.value = `${pad(h)}:${pad(m)}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (close) { closePicker(); input.dispatchEvent(new Event('focusout', { bubbles: true })); }
    };
    pop.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.h != null) { h = Number(b.dataset.h); draw(); commit(false); }
      if (b.dataset.m != null) { m = Number(b.dataset.m); commit(true); }
    });
    setTimeout(() => document.addEventListener('mousedown', outsideClose, { once: true }), 0);
    function outsideClose(ev) { if (!pop.contains(ev.target)) closePicker(); else document.addEventListener('mousedown', outsideClose, { once: true }); }
    document.addEventListener('keydown', escClose);
    function escClose(ev) { if (ev.key === 'Escape') { closePicker(); document.removeEventListener('keydown', escClose); } }
  }

  // ---------------------------------------------------------- side panel --
  // Students missing a TT or BR teacher, grouped by weekday. Click = go there.
  const SIDE_KEY = 'cb.side.collapsed';
  function sideCollapsed() { return localStorage.getItem(SIDE_KEY) === '1'; }
  function setSideCollapsed(v) {
    localStorage.setItem(SIDE_KEY, v ? '1' : '0');
    document.querySelector('.cb-layout')?.classList.toggle('side-collapsed', v);
    const t = $('cbSideToggle'); if (t) { t.setAttribute('aria-pressed', String(!v)); t.title = v ? 'Hiện bảng Cần gán GV' : 'Ẩn bảng Cần gán GV'; }
  }

  function renderSide() {
    const side = $('cbSide'); if (!side) return;
    const collapsed = sideCollapsed();
    setSideCollapsed(collapsed);
    side.classList.toggle('collapsed', collapsed);
    const byDay = new Map(DAYS.map(([v]) => [v, []]));
    let slotsMissing = 0; const studentsMissing = new Set();
    for (const [email, rec] of S.byStudent) {
      for (const sl of rec.cur) {
        if (!sl.id || !slotMissing(sl)) continue;
        byDay.get(sl.day)?.push({ email, name: studentOf(email).displayName, time: sl.time, needTT: needsTT(sl) && !sl.tt, needBR: !sl.br });
        slotsMissing++; studentsMissing.add(email);
      }
    }
    const t = $('cbSideToggle'); if (t) t.querySelector('.cb-chip-n').textContent = String(slotsMissing);
    if (collapsed) {
      side.innerHTML = `<button type="button" class="cb-rail ${slotsMissing ? '' : 'ok'}" data-side="show" title="Hiện bảng Cần gán GV" aria-label="Hiện bảng Cần gán GV">
        <i class="fa-solid fa-chevron-left"></i>
        <span class="cb-rail-n">${slotsMissing}</span>
        <span class="cb-rail-label">Cần gán GV</span></button>`;
      return;
    }
    if (!slotsMissing) {
      side.innerHTML = `<div class="cb-side-head"><i class="fa-solid fa-circle-check" style="color:#16a34a"></i> Đủ giáo viên<button type="button" class="cb-side-hide" data-side="hide" title="Ẩn bảng" aria-label="Ẩn bảng"><i class="fa-solid fa-chevron-right"></i></button></div><p class="cb-side-empty">Mọi buổi chính đã có GV TT và BR, mọi buổi phụ đã có GV BR.</p>`;
      return;
    }
    const rows = DAYS.map(([v, label]) => {
      const items = byDay.get(v).sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
      if (!items.length) return '';
      return `<div class="cb-side-day"><div class="cb-side-daylabel ${DAY_CLS[v]}">${label}<span>${items.length}</span></div>
        ${items.map(it => `<button type="button" class="cb-side-item" data-goto="${esc(it.email)}" title="Đi tới ${esc(it.name)}">
          <span class="t">${esc(it.time)}</span><span class="n">${esc(it.name)}</span>
          <span class="need">${it.needTT ? '<b class="tt">TT</b>' : ''}${it.needBR ? '<b class="br">BR</b>' : ''}</span></button>`).join('')}</div>`;
    }).join('');
    side.innerHTML = `<div class="cb-side-head"><i class="fa-solid fa-user-xmark" style="color:#dc2626"></i> Cần gán GV
        <span class="cb-side-count">${studentsMissing.size} HV · ${slotsMissing} buổi</span>
        <button type="button" class="cb-side-hide" data-side="hide" title="Ẩn bảng" aria-label="Ẩn bảng"><i class="fa-solid fa-chevron-right"></i></button></div>${rows}`;
  }

  function gotoStudent(email) {
    let card = document.querySelector(`.cb-card[data-email="${CSS.escape(email)}"]`);
    if (!card) {            // hidden by a filter — clear the filters so it can be seen
      S.filter = { q: '', teacher: '', missing: false, dirtyOnly: false };
      $('cbSearch').value = ''; $('cbTeacher').value = '';
      $('cbMissing').setAttribute('aria-pressed', 'false'); $('cbDirtyOnly').setAttribute('aria-pressed', 'false');
      render();
      card = document.querySelector(`.cb-card[data-email="${CSS.escape(email)}"]`);
    }
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1800);
    card.querySelector('.cb-gv button.pick.empty')?.focus({ preventScroll: true });
  }
  function place(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 300, h = Math.min(pop.scrollHeight, 360);
    let left = Math.min(r.left, window.innerWidth - w - 8); if (left < 8) left = 8;
    let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }

  // ------------------------------------------------------------- utilities --
  function spinner(on) { $('cbSpinner').hidden = !on; }

  function tsConfirm({ title = 'Xác nhận', message = '', detail = '', confirmLabel = 'Xác nhận', cancelLabel = 'Huỷ', icon = 'fa-circle-question', danger = false } = {}) {
    return new Promise(resolve => {
      document.getElementById('tsConfirmOverlay')?.remove();
      const overlay = document.createElement('div');
      overlay.id = 'tsConfirmOverlay'; overlay.className = 'remove-teacher-overlay';
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `<div class="remove-teacher-popup">
        <div class="rtp-icon" style="background:${danger ? '#fef2f2' : '#eff6ff'};color:${danger ? '#dc2626' : '#2563eb'};"><i class="fa-solid ${icon}"></i></div>
        <h3 class="rtp-title">${title}</h3><p class="rtp-message">${message}</p>
        ${detail ? `<p class="rtp-message" style="margin-top:-6px;font-size:.86rem;opacity:.85;">${detail}</p>` : ''}
        <div class="rtp-actions"><button type="button" class="rtp-btn rtp-btn-cancel">${cancelLabel}</button><button type="button" class="rtp-btn rtp-btn-remove">${confirmLabel}</button></div></div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
      const prev = document.activeElement, cancel = overlay.querySelector('.rtp-btn-cancel'), ok = overlay.querySelector('.rtp-btn-remove');
      cancel.focus();
      const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); close(false); } else if (ev.key === 'Tab') { ev.preventDefault(); (document.activeElement === cancel ? ok : cancel).focus(); } };
      function close(v) { document.removeEventListener('keydown', onKey, true); overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 200); try { prev?.focus?.(); } catch (_) { } resolve(v); }
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => close(false)); ok.addEventListener('click', () => close(true));
      overlay.addEventListener('click', ev => { if (ev.target === overlay) close(false); });
    });
  }

  function tsToast(message, kind = 'ok', ms = 3600) {
    let wrap = document.querySelector('.ts-toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'ts-toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = `ts-toast ${kind}`; el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ic = kind === 'error' ? 'fa-circle-exclamation' : kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-check';
    el.innerHTML = `<i class="fa-solid ${ic}"></i><span></span>`; el.querySelector('span').textContent = String(message || '');
    wrap.appendChild(el); requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => { el.remove(); if (!wrap.children.length) wrap.remove(); }, 220); }, ms);
  }
})();
