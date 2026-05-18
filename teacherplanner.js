/* ---------- Helpers ---------- */
let client;

let PL_STUDENT_NAME_BY_EMAIL = new Map();
const displayStudent = (email) => PL_STUDENT_NAME_BY_EMAIL.get(email) || email;


function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch])); }
function timeToMin(t) { const [h = 0, m = 0] = String(t || '').split(':').map(Number); return h * 60 + m; }
function minToTime(x) { const h = Math.floor(x / 60), m = x % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }

// Display "HH:MM" even if the DB gives "HH:MM:SS"
function showHHMM(t) {
    const s = String(t || '');
    // if "08:00:00" => "08:00"; if "08:30:00" => "08:30"
    const m = s.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
    return m ? m[1] : s;
}


function weekdayLong(i) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]; }
function dayCss(i) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][i] || 'sun'; }

const PX_PER_MIN = 3; // 3px = 1 minute (try 4 if you want it even taller)


const TEACHER_TABLE = 'teachers';
const AVAIL_TABLE = 'teacher_availability';
const BLOCKS_TABLE = 'teacher_blocks';

let PL_TEACHER_EMAIL = null;

let PL_CACHE = null; // { ranges, blocks, studentById, byDayStudents }

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', initSupabase);

async function initSupabase() {
    try {
        const res = await fetch('/api/cal-supabase-credentials');
        const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();
        client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, detectSessionInUrl: true }
        });
        const { data: { session } } = await client.auth.getSession();
        if (!session) {
            document.getElementById('plannerContent').innerHTML = '<div class="tip">Please log in on the main page.</div>';
            return;
        }
        setupUI();
        await loadTeachers();
        await renderPlanner(true);
    } catch (e) { console.error(e); }
}

/* ---------- UI ---------- */
function setupUI() {
    document.getElementById('plannerTeacher')?.addEventListener('change', async (e) => {
        PL_TEACHER_EMAIL = e.target.value || null;   // email string
        await renderPlanner(true);
    });

    document.getElementById('plannerRefresh')?.addEventListener('click', () => renderPlanner(true));

    // ONE global click handler for delete + add (delete first!)
    document.body.addEventListener('click', async (e) => {
        // DELETE — handle first and stop bubbling
        const delBtn = e.target.closest('button.del[data-id]');
        if (delBtn) {
            e.preventDefault();
            e.stopPropagation();

            const id = delBtn.dataset.id; // UUID
            if (confirm('Delete this block?')) {
                try {
                    const resp = await fetch('/api/teacher-blocks-delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            block_id: id,
                            teacher_email: PL_TEACHER_EMAIL
                        })
                    });

                    const result = await resp.json();
                    if (!resp.ok) {
                        alert(result?.error || 'Delete failed');
                        console.error('Delete error:', result);
                        return;
                    }

                    // close any open Add popup just in case
                    document.getElementById('apBackdrop')?.remove();
                    await renderPlanner(true);
                } catch (err) {
                    alert('Network error deleting block. See console.');
                    console.error(err);
                }
            }
            return; // IMPORTANT: don't let this click trigger anything else
        }

       

        // EDIT — click a block (but not the delete button)
        const blkEl = e.target.closest('.blk[data-id]');
        if (blkEl && !e.target.closest('button.del')) {
            e.preventDefault();
            e.stopPropagation();
            openEditPopover(blkEl);
            return;
        }


        // ADD — open the modal
        const addBtn = e.target.closest('.add-link');
        if (addBtn) {
            e.preventDefault();
            e.stopPropagation();
            openAddPopover(addBtn);
            return;
        }
    });

    // SECOND listener (registered ONCE) for timeline clicks to pre-fill start time
    document.body.addEventListener('click', (e) => {
        const col = e.target.closest('.timeline');
        if (!col) return;

        // ignore if the click was on delete or on the add button itself
        if (e.target.closest('button.del') || e.target.closest('.add-link')) return;

        const addBtn = col.nextElementSibling && col.nextElementSibling.matches('.add-link')
            ? col.nextElementSibling
            : null;
        if (!addBtn) return;

        const rect = col.getBoundingClientRect();
        const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top)); // 0..height
        const minutesFromStart = Math.round(y / PX_PER_MIN / 5) * 5;        // snap to 5
        const startM = timeToMin(addBtn.dataset.start);
        const picked = minToTime(startM + minutesFromStart);

        // open the modal and prefill the start time
        openAddPopover(addBtn);
        setTimeout(() => {
            const inp = document.getElementById('apStart');
            if (inp) inp.value = picked;
        }, 0);
    });

}

async function loadTeachers() {
    const sel = document.getElementById('plannerTeacher');

    try {
        const resp = await fetch('/api/teachers-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const payload = await resp.json();

        if (!resp.ok) {
            console.error('teachers-list error', payload);
            sel.innerHTML = '<option>Error</option>';
            return;
        }

        const emails = payload.emails || [];

        sel.innerHTML = emails.length
            ? emails.map(e => `<option value="${e}">${escapeHtml(e)}</option>`).join('')
            : '<option value="">No emails</option>';

        PL_TEACHER_EMAIL = emails[0] || null;
    } catch (err) {
        console.error('teachers-list network error', err);
        const sel = document.getElementById('plannerTeacher');
        if (sel) sel.innerHTML = '<option>Error</option>';
    }
}



async function renderPlanner(force = false) {
    if (!PL_TEACHER_EMAIL) {
        document.getElementById('plannerContent').innerHTML = '';
        return;
    }

    if (force || !PL_CACHE) {
        try {
            const resp = await fetch('/api/planner-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teacher_email: PL_TEACHER_EMAIL })
            });
            const payload = await resp.json();
            if (!resp.ok) {
                console.error('planner-data error', payload);
                return;
            }

            const rangesData = payload.ranges || [];
            const blocksData = payload.blocks || [];
            const assignedData = payload.assigned || [];
            const names = payload.names || [];

            // names map for displayStudent(...)
            PL_STUDENT_NAME_BY_EMAIL = new Map(
                (names || []).map(r => [r.email, r.full_name || r.email])
            );

            // Build helper map of candidate emails per day
            const byDayEmails = new Map(Array.from({ length: 7 }, (_, i) => [i, new Set()]));
            for (const r of assignedData) {
                if (r?.student_email) byDayEmails.get(r.day_of_week)?.add(r.student_email);
            }

            PL_CACHE = {
                ranges: rangesData,
                blocks: blocksData,
                byDayEmails
            };
        } catch (e) {
            console.error('planner-data network error', e);
            return;
        }
    }


    const cont = document.getElementById('plannerContent');
    const days = Array.from({ length: 7 }, (_, i) => i);

    const html = [
        '<div class="planner-grid">',
        ...days.map(d => {
            const ranges = (PL_CACHE.ranges || []).filter(r => r.day_of_week === d)
                .sort((a, b) => timeToMin(a.time_start) - timeToMin(b.time_start));

            if (ranges.length === 0) return '';

            const col = ranges.map(r => {
                const startM = timeToMin(r.time_start);
                const endM = timeToMin(r.time_end);
                const len = endM - startM;

                const blocks = (PL_CACHE.blocks || [])
                    .filter(b =>
                        b.day_of_week === d &&
                        b.teacher_email === PL_TEACHER_EMAIL &&
                        timeToMin(b.start_time) >= startM &&
                        timeToMin(b.end_time) <= endM
                    )
                    .sort((a, b) => timeToMin(a.start_time) - timeToMin(b.start_time));


                const cand = Array.from(PL_CACHE.byDayEmails.get(d) || []);
                const options = cand.map(email => ({ email, label: displayStudent(email) }));



                const ticks = [];
                for (let i = 0; i <= len; i += 5) {
                    const top = i * PX_PER_MIN;
                    const isHour = i % 60 === 0;
                    const isHalf = !isHour && (i % 30 === 0);
                    const cls = isHour ? 'hour' : (isHalf ? 'half' : '');
                    const label = (isHour || isHalf) ? minToTime(startM + i) : '';
                    ticks.push(`<div class="tick ${cls}" style="top:${top}px;">${label ? `<span class="tlabel">${label}</span>` : ''}</div>`);
                }

                const events = blocks.map(b => ({ b, start: timeToMin(b.start_time), end: timeToMin(b.end_time), lane: 0, group: -1 }));
                let active = [], curGroup = -1, groupMax = [];
                for (const ev of events) {
                    active = active.filter(a => a.end > ev.start);
                    if (active.length === 0) curGroup++;
                    ev.group = curGroup;
                    const used = new Set(active.map(a => a.lane));
                    let lane = 0; while (used.has(lane)) lane++;
                    ev.lane = lane;
                    active.push(ev);
                    groupMax[curGroup] = Math.max(groupMax[curGroup] || 0, active.length);
                }

                const blocksRects = events.map(ev => {
                    const top = (ev.start - startM) * PX_PER_MIN;
                    const height = (ev.end - ev.start) * PX_PER_MIN;
                    const cols = Math.max(1, groupMax[ev.group] || 1);
                    const colW = 100 / cols;
                    const leftPct = ev.lane * colW;
                    const email = ev.b.student_email || '';
                    const name = email ? displayStudent(email)
                        : (ev.b.student_id || '(Unassigned)');



                    const startHHMM = minToTime(ev.start);
                    const endHHMM = minToTime(ev.end);

                    return `
    <div class="blk ${dayCss(d)}"
         data-id="${ev.b.id}"
         data-day="${d}"
         data-start="${startHHMM}"
         data-end="${endHHMM}"
         data-student="${escapeHtml(email)}"
         style="top:${top}px;height:${Math.max(12, height)}px; left:calc(${leftPct}% + 8px); right:auto; width:calc(${colW}% - 16px);"
         title="${escapeHtml(name)} (${startHHMM} - ${endHHMM})">
      <div class="b-top">
        <span class="b-name">${escapeHtml(name)} (${startHHMM} - ${endHHMM})</span>
        <button class="del" data-id="${ev.b.id}" title="Delete" aria-label="Delete block"><i class="fa-regular fa-trash-can"></i></button>
      </div>
    </div>`;


                }).join('');

                return `
<div class="range-head chip ${dayCss(d)}">
  <span class="range-time">
    <span>${escapeHtml(showHHMM(r.time_start))}</span>
    <span class="t-sep" aria-hidden="true"></span>
    <span>${escapeHtml(showHHMM(r.time_end))}</span>
  </span>
  <span class="range-len">${len} min</span>
</div>
<div class="timeline" style="--len-min:${len}">
  <div class="ticks">${ticks.join('')}</div>
  <div class="blocks-v">${blocksRects}</div>
</div>
<button class="add-link" data-day="${d}" data-avail="${r.id}"
        data-start="${escapeHtml(r.time_start)}" data-end="${escapeHtml(r.time_end)}"
        data-cands='${escapeHtml(JSON.stringify(options))}'>
  <i class="fa-solid fa-plus"></i> Add block
</button>`;

            }).join('');

            return `<div class="planner-day"><h4>${weekdayLong(d)}</h4>${col}</div>`;
        }).filter(Boolean),
        '</div>'
    ].join('');

    cont.innerHTML = html;
}

function openEditPopover(blkEl) {
        const blockId = blkEl.dataset.id;
        const day = Number(blkEl.dataset.day);
        const startHHMM = blkEl.dataset.start || '08:00';
        const endHHMM = blkEl.dataset.end || '08:30';
        const curStudent = blkEl.dataset.student || '';

        // compute current minutes from start/end
        const curMins = Math.max(5, timeToMin(endHHMM) - timeToMin(startHHMM));

        // candidates for this day from PL_CACHE (same as Add)
        const cand = Array.from(PL_CACHE?.byDayEmails?.get(day) || []);
        const options = cand.map(email => ({ email, label: displayStudent(email) }));

        // remove any existing modal
        document.getElementById('epBackdrop')?.remove();

        // build modal (re-use the same look)
        const backdrop = document.createElement('div');
        backdrop.id = 'epBackdrop';
        backdrop.className = 'add-pop-backdrop';

        const pop = document.createElement('div');

        if (!document.getElementById('apNiceStyles')) {
            const s = document.createElement('style');
            s.id = 'apNiceStyles';
            s.textContent = `
    .add-pop{border-radius:16px;padding:18px 18px 14px;background:#fff;
      box-shadow:0 14px 40px rgba(0,0,0,.14);max-width:420px;width:92%;}
    .add-pop .ap-header{display:flex;align-items:center;gap:10px;margin:2px 0 12px}
    .add-pop .ap-header .t{font-size:18px;font-weight:700;letter-spacing:.2px}
    .add-pop .row{margin-bottom:12px}
    .add-pop label{display:block;font-weight:600;color:#1f2937;margin-bottom:6px}
    .add-pop input,.add-pop select{
      width:100%;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;
      background:#fff;outline:none;box-shadow:0 1px 0 rgba(0,0,0,.02) inset;
    }
    .add-pop input:focus,.add-pop select:focus{border-color:#93c5fd;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
    .add-pop .ap-muted{font-size:12.5px;color:#6b7280;margin-top:6px;line-height:1.35}
    .add-pop .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
    .add-pop .btn-sm{border-radius:12px;padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb}
    .add-pop .btn-sm.primary{background:#2563eb;color:#fff;border-color:#2563eb}
  `;
            document.head.appendChild(s);
        }

        const optionsHtml = options.length
            ? options.map(s => `<option value="${s.email}" ${s.email === curStudent ? 'selected' : ''}>${escapeHtml(s.label || s.email)}</option>`).join('')
            : '';

        pop.className = 'add-pop';
        pop.innerHTML = `
  <div class="ap-header">
    <div class="emoji">✏️</div>
    <div class="t">Edit lesson</div>
  </div>

  <div class="row">
    <label>Student</label>
    <select id="epStudent">
      ${optionsHtml || '<option value="">(No assigned students for this day)</option>'}
    </select>
  </div>

  <div class="row">
    <label>Or new student</label>
    <input id="epNewStudent" type="text" placeholder="Nhập tên học viên mới hoặc email"/>
    <div class="ap-muted">Để trống để giữ nguyên học viên hiện tại.</div>
  </div>

  <div class="row">
    <label>Start</label>
    <input id="epStart" type="time" step="60" value="${startHHMM}">
  </div>

  <div class="row">
    <label>Minutes</label>
    <input id="epMin" type="number" min="5" step="5" value="${curMins}">
    <div class="ap-muted">Server will check availability window & prevent overlaps.</div>
  </div>

  <div class="actions">
    <button class="btn-sm" id="epCancel">Cancel</button>
    <button class="btn-sm primary" id="epSave">Update</button>
  </div>
`;

        backdrop.appendChild(pop);
        document.body.appendChild(backdrop);

        const sel = pop.querySelector('#epStudent');
        const newInput = pop.querySelector('#epNewStudent');
        sel?.addEventListener('change', () => {
            if (sel.value && newInput) newInput.value = '';
        });
        newInput?.addEventListener('input', () => {
            if (newInput.value.trim() && sel) sel.value = '';
        });

        const close = () => {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
        };
        const onKey = (ev) => { if (ev.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
        pop.querySelector('#epCancel')?.addEventListener('click', close);

        pop.querySelector('#epSave')?.addEventListener('click', async () => {
            const sTime = pop.querySelector('#epStart').value;
            const mins = Number(pop.querySelector('#epMin').value || 0);
            if (!sTime || !mins) { alert('Start & minutes are required'); return; }

            // derive desired student change
            const pickedStudent = sel?.value || '';
            const typedStudent = (newInput?.value || '').trim();
            const desiredStudent = typedStudent || pickedStudent; // may be '' to keep

            try {
                // 1) update time first (existing function)
                const timeResp = await fetch('/api/teacher-blocks-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        block_id: blockId,
                        teacher_email: PL_TEACHER_EMAIL,
                        start_time: sTime,
                        minutes: mins
                    })
                });
                const timeResult = await timeResp.json();
                if (!timeResp.ok) {
                    alert(timeResult?.error || 'Update time failed');
                    console.warn('teacher-blocks-update error', timeResult);
                    return;
                }

                // 2) if student changed, call set-student
                const studentChanged = (desiredStudent || '') !== (curStudent || '');
                if (studentChanged) {
                    const stuResp = await fetch('/api/teacher-blocks-set-student', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            block_id: blockId,
                            teacher_email: PL_TEACHER_EMAIL,
                            student_email: desiredStudent // empty -> becomes null
                        })
                    });
                    const stuResult = await stuResp.json();
                    if (!stuResp.ok) {
                        alert(stuResult?.error || 'Update student failed');
                        console.warn('teacher-blocks-set-student error', stuResult);
                        return;
                    }
                }

                close();
                renderPlanner(true);
            } catch (err) {
                alert('Network error updating block. See console.');
                console.error(err);
            }
        });
    }

/* ---------- Add block popover ---------- */
function openAddPopover(anchor) {
    // remove any existing modal
    document.getElementById('apBackdrop')?.remove();

    // read data from the clicked "Add block" button
    const day = Number(anchor.dataset.day);
    const availId = anchor.dataset.avail;   // UUID string

    const start = anchor.dataset.start;
    const end = anchor.dataset.end;
    const cands = JSON.parse(anchor.dataset.cands || '[]'); // [{id,name,status}]

    const options = cands.length
        ? cands.map(s => `<option value="${s.email}">${escapeHtml(s.label || s.email)}</option>`).join('')
        : '';



    // build centered modal
    const backdrop = document.createElement('div');
    backdrop.id = 'apBackdrop';
    backdrop.className = 'add-pop-backdrop';

    const pop = document.createElement('div');

    // --- pretty styles for the popup (added once) ---
    if (!document.getElementById('apNiceStyles')) {
        const s = document.createElement('style');
        s.id = 'apNiceStyles';
s.textContent = `
    .add-pop{border-radius:20px;padding:0;background:#fff;
      box-shadow:0 25px 60px rgba(0,0,0,.18);max-width:420px;width:92%;overflow:hidden;}
    
    /* Header with gradient */
    .add-pop .ap-header{
      display:flex;align-items:center;gap:14px;
      padding:20px 24px;
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      color:#fff;margin:0;border:0;
    }
    .add-pop .ap-header .emoji{
      width:44px;height:44px;border-radius:12px;
      background:rgba(255,255,255,.2);
      display:flex;align-items:center;justify-content:center;
      font-size:22px;
    }
    .add-pop .ap-header .t{font-size:18px;font-weight:700;letter-spacing:.3px;color:#fff;}
    .add-pop .ap-header .ap-subtitle{font-size:13px;opacity:.85;margin-top:2px;}
    
    /* Body content */
    .add-pop .ap-body{padding:24px;}
    
/* Form groups */
    .add-pop .ap-group{margin-bottom:20px;}
    .add-pop .ap-group:last-child{margin-bottom:0;}
    .add-pop .ap-group > label{
      display:flex;align-items:center;gap:8px;
      font-weight:600;color:#1f2937;margin-bottom:10px;font-size:14px;
      white-space:nowrap;
    }
    .add-pop .ap-group > label i{color:#6366f1;font-size:14px;}
    
    /* Inputs and selects */
    .add-pop input,.add-pop select{
      width:100%;border:2px solid #e5e7eb;border-radius:12px;padding:12px 14px;
      background:#f9fafb;outline:none;font-size:14px;box-sizing:border-box;
      transition:all .2s ease;
    }
    .add-pop input:hover,.add-pop select:hover{border-color:#c7d2fe;background:#fff;}
    .add-pop input:focus,.add-pop select:focus{
      border-color:#6366f1;background:#fff;
      box-shadow:0 0 0 4px rgba(99,102,241,.12);
    }
    
/* Time inputs row */
    .add-pop .ap-time-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;}
    .add-pop .ap-time-row .ap-group{margin-bottom:0;}
    .add-pop .ap-time-row .ap-group > label{margin-bottom:10px;min-height:20px;}
    .add-pop .ap-time-row input{height:48px;}
    
/* Muted helper text */
    .add-pop .ap-muted{
      font-size:12px;color:#92400e;margin-top:8px;line-height:1.5;
      padding:10px 12px;background:#fef3c7;border-radius:10px;
      border:1px solid #fde68a;
    }
    
    /* Divider */
    .add-pop .ap-divider{
      height:1px;background:#e5e7eb;margin:20px 0;
    }
    
    /* Actions footer */
    .add-pop .actions{
      display:flex;justify-content:flex-end;gap:12px;
      padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;
    }
    .add-pop .btn-sm{
      border-radius:10px;padding:12px 24px;border:2px solid #e5e7eb;
      background:#fff;font-weight:600;cursor:pointer;font-size:14px;
      transition:all .2s ease;
    }
    .add-pop .btn-sm:hover{background:#f3f4f6;border-color:#d1d5db;}
    .add-pop .btn-sm.primary{
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      color:#fff;border:0;padding:14px 28px;
    }
    .add-pop .btn-sm.primary:hover{
      transform:translateY(-1px);
      box-shadow:0 4px 12px rgba(102,126,234,.4);
    }
    
/* Radio group styling */
    .add-pop .ap-radio-group{display:flex;gap:12px;flex-wrap:nowrap;}
    .add-pop .ap-radio-label{
      flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:8px;padding:16px 12px;border-radius:12px;
      background:#f9fafb;border:2px solid #e5e7eb;
      cursor:pointer;font-size:13px;color:#6b7280;font-weight:500;
      transition:all .2s ease;text-align:center;min-height:70px;
    }
    .add-pop .ap-radio-label:hover{background:#f3f4f6;border-color:#d1d5db;}
    .add-pop .ap-radio-label:has(input:checked){
      background:linear-gradient(135deg,#eef2ff 0%,#e0e7ff 100%);
      border-color:#6366f1;color:#4338ca;
    }
    .add-pop .ap-radio-label input[type="radio"]{display:none;}
    .add-pop .ap-radio-label .ap-radio-icon{
      width:32px;height:32px;border-radius:50%;
      background:#e5e7eb;display:flex;align-items:center;justify-content:center;
      font-size:14px;color:#6b7280;transition:all .2s ease;
    }
    .add-pop .ap-radio-label:has(input:checked) .ap-radio-icon{
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;
    }
    
    /* Weeks row */
    .add-pop .ap-weeks-row{
      display:flex;align-items:center;gap:12px;
      background:#f0fdf4;padding:14px;border-radius:12px;margin-top:12px;
      border:1px solid #bbf7d0;
    }
    .add-pop .ap-weeks-row label{margin:0;font-size:14px;font-weight:600;white-space:nowrap;color:#166534;}
    .add-pop .ap-weeks-input{width:70px !important;text-align:center;}
    .add-pop .ap-weeks-row .ap-muted{margin:0;font-size:12px;background:none;padding:0;border:0;}
  `;
        document.head.appendChild(s);
    }
    // -------------------------------------------------

pop.className = 'add-pop';
    pop.innerHTML = `
  <div class="ap-header">
    <div class="emoji">📚</div>
    <div>
      <div class="t">Add Lesson</div>
      <div class="ap-subtitle">${weekdayLong(day)} • ${showHHMM(start)} - ${showHHMM(end)}</div>
    </div>
  </div>

  <div class="ap-body">
    <div class="ap-group">
      <label><i class="fa-solid fa-user-graduate"></i> Select Student</label>
      <select id="apStudent">
        ${options || '<option value="">(No assigned students for this day)</option>'}
      </select>
    </div>

    <div class="ap-group">
      <label><i class="fa-solid fa-user-plus"></i> Or Add New Student</label>
      <input id="apNewStudent" type="text" placeholder="Enter student name not in the list"/>
      <div class="ap-muted">
        ⚠️ Khi lên lịch cho HV không phải mình phụ trách chính, hãy nói rõ là dạy thế cho GV nào
      </div>
    </div>

<div class="ap-group" id="apRecurringRow" style="display:none;">
      <label><i class="fa-solid fa-repeat"></i> Recurring Schedule?</label>
      <div class="ap-radio-group">
        <label class="ap-radio-label">
          <input type="radio" name="apRecurring" value="one_time" checked />
          <span class="ap-radio-icon"><i class="fa-solid fa-calendar-day"></i></span>
          <span>This week only</span>
        </label>
        <label class="ap-radio-label">
          <input type="radio" name="apRecurring" value="recurring" />
          <span class="ap-radio-icon"><i class="fa-solid fa-calendar-week"></i></span>
          <span>Repeat weekly</span>
        </label>
      </div>
      <div id="apWeeksRow" class="ap-weeks-row" style="display:none;">
        <label>Weeks:</label>
        <input id="apWeeksCount" type="number" min="1" max="52" value="2" class="ap-weeks-input"/>
        <span class="ap-muted">(including this week)</span>
      </div>
    </div>

    <div class="ap-divider"></div>

    <div class="ap-time-row">
      <div class="ap-group">
        <label><i class="fa-solid fa-clock"></i> Start Time</label>
        <input id="apStart" type="time" step="60" value="${showHHMM(start)}">
      </div>
      <div class="ap-group">
        <label><i class="fa-solid fa-hourglass-half"></i> Minutes</label>
        <input id="apMin" type="number" min="5" step="5" value="" placeholder="e.g. 30">
      </div>
    </div>
  </div>

  <div class="actions">
    <button class="btn-sm" id="apCancel">Cancel</button>
    <button class="btn-sm primary" id="apSave">💾 Save Lesson</button>
  </div>
`;


    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);

    // default minutes = student's status if present
    const sel = pop.querySelector('#apStudent');
    const min = pop.querySelector('#apMin');

    async function setDefault() {
        try {
            const email = sel?.value || '';
            if (!email) return;

            const resp = await fetch('/api/student-minutes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const payload = await resp.json();
            if (!resp.ok) {
                console.warn('student-minutes error', payload);
                return;
            }

            const minutes = Number(payload?.minutes);
            if (Number.isFinite(minutes) && minutes > 0) {
                min.value = String(minutes);   // prefill Minutes
            }
        } catch (e) {
            console.warn('student-minutes network error', e);
        }
    }

    



    setDefault();   // run once on open (will use the first option if any)


    const newInput = pop.querySelector('#apNewStudent');

    // When user picks from the dropdown, clear the text field
    sel?.addEventListener('change', () => {
        if (sel.value && newInput) newInput.value = '';
        setDefault();
    });

// When user types a name, clear the dropdown so the typed name is used
    // Also show the recurring options
    const recurringRow = pop.querySelector('#apRecurringRow');
    const weeksRow = pop.querySelector('#apWeeksRow');
    const recurringRadios = pop.querySelectorAll('input[name="apRecurring"]');

    newInput?.addEventListener('input', () => {
        if (newInput.value.trim() && sel) {
            sel.value = '';
            // Show the recurring section
            if (recurringRow) recurringRow.style.display = 'block';
        } else {
            // Hide if empty
            if (recurringRow) recurringRow.style.display = 'none';
            if (weeksRow) weeksRow.style.display = 'none';
        }
    });

    // Show/hide weeks input based on radio selection
    recurringRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            const isRecurring = pop.querySelector('input[name="apRecurring"]:checked')?.value === 'recurring';
            if (weeksRow) weeksRow.style.display = isRecurring ? 'block' : 'none';
        });
    });


    // close helpers
    const close = () => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };

    // close on ESC or clicking the shaded area
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
    pop.querySelector('#apCancel')?.addEventListener('click', close);

    // save
    pop.querySelector('#apSave')?.addEventListener('click', async () => {
        const studentEmail = pop.querySelector('#apStudent')?.value || '';
        const typedEmail = (pop.querySelector('#apNewStudent')?.value || '').trim();

        if (!studentEmail && !typedEmail) {
            alert('Pick a student email OR type one');
            return;
        }

        const emailToUse = studentEmail || typedEmail;

        // collect time + minutes
        const sTime = pop.querySelector('#apStart').value;
        const mins = Number(pop.querySelector('#apMin').value || 0);
        if (!sTime || !mins) { alert('Start & minutes are required'); return; }

        // keep the block inside the availability window
        const sMin = timeToMin(sTime);
        const eMin = sMin + mins;
        const aStart = timeToMin(start);
        const aEnd = timeToMin(end);
        if (sMin < aStart || eMin > aEnd) {
            alert('Block must fit inside the availability range');
            return;
        }

        // verify the availability row belongs to the selected teacher email
try {
            // Get current user token
            const { data: { session } } = await client.auth.getSession();
            const userToken = session?.access_token || null;

// Check if this is a temp assignment with recurring info
            const isTempAssignment = !!typedEmail;
            const recurringValue = pop.querySelector('input[name="apRecurring"]:checked')?.value || 'one_time';
            const weeksCount = recurringValue === 'recurring' 
                ? Number(pop.querySelector('#apWeeksCount')?.value || 1) 
                : 1;

            const resp = await fetch('/api/teacher-blocks-add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    availability_id: availId,
                    teacher_email: PL_TEACHER_EMAIL,
                    day_of_week: day,
                    start_time: sTime,
                    minutes: mins,
                    student_email: emailToUse,
                    userToken: userToken,
                    is_temp_assignment: isTempAssignment,
                    temp_weeks_remaining: isTempAssignment ? weeksCount : null
                })
            });

            const result = await resp.json();
            if (!resp.ok) {
                alert(result?.error || 'Save failed');
                console.warn('teacher-blocks-add error', result);
                return;
            }

            close();
            renderPlanner(true);
        } catch (err) {
            alert('Network error saving block. See console.');
            console.error(err);
        }

    });
}