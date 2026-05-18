let client;
const ACTIVE_DATA = new Map(); // email -> { startMs, limitMs }
let ALL_DATA = []; // Store all students here for filtering

document.addEventListener('DOMContentLoaded', () => {
    // Setup Login UI
    setupPasswordToggle();
    setupLoginHandler();

    // Listen for filter changes
    document.getElementById('teacherFilter')?.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'ALL') {
            CURRENT_ROLE_MODE = 'ANY';
            renderCards(ALL_DATA);
        } else {
            // Open the popup to ask which department
            openRoleModal(val);
        }
    });
    initApp();
});

async function initApp() {
    const container = document.getElementById('activeList');
    try {
        const res = await fetch('/api/cal-supabase-credentials');
        const { SUPABASE_URL, ANON_PUBLIC_KEY } = await res.json();
        client = window.supabase.createClient(SUPABASE_URL, ANON_PUBLIC_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage }
        });

const { data: { session } } = await client.auth.getSession();
        
        if (!session) {
            // Not logged in: Show Login Card, Hide Main Content
            document.getElementById('loginCard').style.display = 'block';
            document.querySelector('.board').style.display = 'none';
            return;
        }

        // Logged in: Hide Login Card, Show Main Content
        document.getElementById('loginCard').style.display = 'none';
        document.querySelector('.board').style.display = 'block';

        await loadActiveStudents(session.access_token);
        // Refresh every 30 seconds
        setInterval(() => loadActiveStudents(session.access_token), 30000);

    } catch (err) {
        container.innerHTML = `<div class="tip error">${err.message}</div>`;
    }
}

async function loadActiveStudents(token) {
    try {
        const res = await fetch('/api/get-active-students', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const json = await res.json();
        
        // 1. Store data globally
        ALL_DATA = json.data || [];

        // 2. Sort Logic (Earliest deadline first)
        ALL_DATA.sort((a, b) => {
            const getEndTime = (s) => {
                if (!s.limit_minutes) return 8640000000000000; 
                // If upcoming, use scheduled time, otherwise actual start time
                const base = s.status === 'upcoming' ? s.sched_time : s.start_time;
                return new Date(base || Date.now()).getTime() + (s.limit_minutes * 60 * 1000);
            };
            return getEndTime(a) - getEndTime(b);
        });

        // 3. Populate Filter (Fill the dropdown with teacher names)
        populateFilter(ALL_DATA);

        // 4. Render the cards (Draw them on screen)
        renderCards(ALL_DATA);

    } catch (err) {
        console.error(err);
        document.getElementById('activeList').innerHTML = `<div class="tip error">Error loading data</div>`;
    }
}

function startTimerLoop() {
    window._timerLoop = setInterval(() => {
        const now = Date.now();
        ACTIVE_DATA.forEach((meta, email) => {
            // Check for UPCOMING countdown
            const startEl = document.getElementById(`starts_${email}`);

            // Check for ACTIVE stopwatch
            const usedEl = document.getElementById(`used_${email}`);

            const leftEl = document.getElementById(`left_${email}`);

// 1. HANDLE UPCOMING (Starts In)
            if (startEl) {
                const diff = meta.startMs - now;
                // Round up to nearest minute (e.g., 19.1 min -> 20m)
                const mins = Math.ceil(diff / 60000); 

                if (mins > 0) {
                    startEl.textContent = `Start in ${mins}m`;
                    startEl.style.color = "#334155"; // Default color
                } else {
                    startEl.textContent = "Start in 0m"; // Replaces "NOW"
                    startEl.style.color = "#ea580c"; // Orange alert
                }
                
                // Duration static display
                if (leftEl) {
                    leftEl.textContent = meta.limitMs > 0 ? (meta.limitMs / 60000) + "m" : "∞";
                }
                return; 
            }

            // 2. HANDLE ACTIVE (Time Used)
            if (usedEl) {
                const diffUsed = Math.max(0, now - meta.startMs);
                usedEl.textContent = formatHMS(diffUsed);
            }

            // 3. HANDLE ACTIVE (Time Left)
            if (leftEl && meta.limitMs > 0) {
                const endMs = meta.startMs + meta.limitMs;
                const diffLeft = endMs - now;

                if (diffLeft < 0) {
                    leftEl.textContent = "+" + formatHMS(Math.abs(diffLeft));
                    leftEl.classList.add('overtime');
                    leftEl.closest('.active-card').classList.add('is-overtime');
                } else {
                    leftEl.textContent = formatHMS(diffLeft);
                    leftEl.classList.remove('overtime');
                    leftEl.closest('.active-card').classList.remove('is-overtime');
                }
            } else if (leftEl) {
                leftEl.textContent = "∞";
            }
        });
    }, 1000);
}

function formatHMS(ms) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}


// --- NEW HELPER FUNCTIONS ---

// 1. Extract unique teachers and fill the dropdown
function populateFilter(students) {
    const select = document.getElementById('teacherFilter');
    if (!select) return;

    const currentVal = select.value; // Remember selection so it doesn't reset on refresh
    const teachers = new Set();

    students.forEach(s => {
        if (s.ttkb_teacher && s.ttkb_teacher !== '—') teachers.add(s.ttkb_teacher);
        if (s.breakout_teacher && s.breakout_teacher !== '—') teachers.add(s.breakout_teacher);
    });

    const sortedTeachers = Array.from(teachers).sort();

    // Reset options
    select.innerHTML = '<option value="ALL">All Teachers</option>';

    sortedTeachers.forEach(t => {
        const option = document.createElement('option');
        option.value = t;
        option.textContent = t;
        select.appendChild(option);
    });

    // Restore previous selection if it's still in the list
    if (sortedTeachers.includes(currentVal)) {
        select.value = currentVal;
    }
}

// 2. Filter data and draw the cards
function renderCards(allStudents) {
    const container = document.getElementById('activeList');
    const filterVal = document.getElementById('teacherFilter')?.value || 'ALL';

    // Filter Logic with strict Role checking
    const filtered = allStudents.filter(s => {
        if (filterVal === 'ALL') return true;

        // Strict Logic based on Popup Selection
        if (CURRENT_ROLE_MODE === 'TTKB') {
            return s.ttkb_teacher === filterVal;
        } 
        else if (CURRENT_ROLE_MODE === 'BREAKOUT') {
            return s.breakout_teacher === filterVal;
        } 
        else {
            // 'ANY' mode (Show if matches either)
            return s.ttkb_teacher === filterVal || s.breakout_teacher === filterVal;
        }
    });

    // Clear current view
    container.innerHTML = '';
    ACTIVE_DATA.clear();

    if (filtered.length === 0) {
        container.innerHTML = `<div class="tip">No students match this filter.</div>`;
        return;
    }

    // Draw Cards
    filtered.forEach(s => {
        const startMs = new Date(s.start_time).getTime();
        const limitMs = (s.limit_minutes || 0) * 60 * 1000;
        ACTIVE_DATA.set(s.student_email, { startMs, limitMs });

        const card = document.createElement('div');
        card.className = 'active-card';

        const isUpcoming = s.status === 'upcoming';

        let tagHtml = '';
        if (isUpcoming) {
            tagHtml = `<div class="upcoming-tag"><span class="upcoming-dot"></span> UPCOMING</div>`;
        } else {
            tagHtml = `<div class="live-tag"><span class="pulse"></span> LIVE</div>`;
        }

        const labelUsed = isUpcoming ? "Starts In" : "Time Used";
        const labelLeft = isUpcoming ? "Duration" : "Time Left";
        const usedId = isUpcoming ? `starts_${escapeHtml(s.student_email)}` : `used_${escapeHtml(s.student_email)}`;

        card.innerHTML = `
        <div class="card-header">
            <div class="student-main">
                <h3 title="${escapeHtml(s.student_name)}">${escapeHtml(s.student_name)}</h3>
                <span class="email" title="${escapeHtml(s.student_email)}">${escapeHtml(s.student_email)}</span>
            </div>
            ${tagHtml}
        </div>

        <div class="timers-row">
            <div class="timer-box used">
                <span class="label">${labelUsed}</span>
                <span class="time-val" id="${usedId}">00:00:00</span>
            </div>
            <div class="timer-box left">
                <span class="label">${labelLeft}</span>
                <span class="time-val" id="left_${escapeHtml(s.student_email)}">--:--</span>
            </div>
        </div>

        <div class="details-container">
            <div class="info-pill ttkb">
                <div class="info-icon"><i class="fa-solid fa-chalkboard-user"></i></div>
                <div class="info-content">
                    <span class="info-label">TTKB Teacher</span>
                    <span class="info-val" title="${escapeHtml(s.ttkb_teacher)}">${escapeHtml(s.ttkb_teacher)}</span>
                </div>
            </div>

            <div class="info-pill breakout">
                <div class="info-icon"><i class="fa-solid fa-users-viewfinder"></i></div>
                <div class="info-content">
                    <span class="info-label">Breakout</span>
                    <span class="info-val" title="${escapeHtml(s.breakout_teacher)}">${escapeHtml(s.breakout_teacher)}</span>
                </div>
            </div>
        </div>

        <div class="card-footer">
            <i class="fa-solid fa-flag"></i> 
            <span>Reported by <strong>${escapeHtml(s.reporter_name)}</strong></span>
        </div>
      `;
        container.appendChild(card);
    });

    if (!window._timerLoop) startTimerLoop();
}


// --- POPUP LOGIC ---

function openRoleModal(teacherName) {
    const modal = document.getElementById('roleFilterModal');
    const title = document.getElementById('roleModalTitle');
    if (title) title.textContent = `Filter: ${teacherName}`;
    
    if (modal) {
        // Use Flexbox with explicit centering
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
    }
}

function closeRoleModal() {
    const modal = document.getElementById('roleFilterModal');
    if (modal) modal.style.display = 'none';
    
    // If canceled, reset dropdown to All Teachers or just leave it
    // Let's reset to ALL to avoid confusion if they didn't pick a filter
    // const select = document.getElementById('teacherFilter');
    // if(select) select.value = 'ALL'; 
    // renderCards(ALL_DATA);
}

function applyRoleFilter(role) {
    CURRENT_ROLE_MODE = role; // 'TTKB', 'BREAKOUT', or 'ANY'
    closeRoleModal();
    renderCards(ALL_DATA);
}


/* =========================================
   SCREENSHOT & R2 UPLOAD LOGIC
   ========================================= */

document.addEventListener('DOMContentLoaded', () => {
    // Attach listener to the new button
const btn = document.getElementById('screenshotBtn');
    if (btn) {
        // CHANGED: Open popup instead of taking screenshot immediately
        btn.addEventListener('click', openScreenshotModal);
    }
});

async function handleScreenshotFlow() {
    const btn = document.getElementById('screenshotBtn');
    const overlay = document.getElementById('loadingOverlay');
    
    try {
        // 1. Show Overlay & Disable Button
        btn.disabled = true;
        overlay.style.display = 'flex';

        // Small delay to allow the browser to render the overlay before freezing for screenshot
        await new Promise(r => setTimeout(r, 100));

        // 2. Take Screenshot (Use document.body for full capture as per our previous fix)
        // Note: The overlay has z-index 10000, but snapshotElementToBlob hides elements 
        // that are not part of the main content usually, OR we rely on the fact 
        // that we capture the underlying document structure.
        
        // IMPORTANT: We temporarily hide the overlay opacity for the screenshot itself
        // so it doesn't appear in the picture, but keep it in DOM so layout doesn't shift.
        overlay.style.opacity = '0';
        
        const blob = await snapshotElementToBlob(document.body);
        
        // Bring overlay back immediately visually (though user won't notice the flicker)
        overlay.style.opacity = '1';

        if (!blob) throw new Error('Failed to capture screenshot');

        // 3. Upload to Cloudflare R2
        const publicUrl = await uploadBlobToWasabi(blob);

        // 4. Copy to Clipboard
        await navigator.clipboard.writeText(publicUrl);

        // 5. Success Toast
        showToast("Link copied to clipboard! Ready to paste.");

    } catch (err) {
        console.error('Screenshot error:', err);
        alert('Failed to upload screenshot. Please check console.');
    } finally {
        // 6. Reset UI
        overlay.style.display = 'none';
        btn.disabled = false;
    }
}

// Helper: Show a nice toast message
function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = `<i class="fa-solid fa-check-circle"></i> ${message}`;

    container.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Helper: Converts DOM element to PNG Blob using html2canvas
 */
async function snapshotElementToBlob(sourceEl) {
    if (typeof html2canvas === 'undefined') {
        throw new Error('html2canvas library not loaded');
    }

    // Capture the exact width of the user's screen to prevent layout shifts
    const viewportWidth = document.documentElement.clientWidth;

    const canvas = await html2canvas(document.body, {
        scale: 2, // 2x is optimal for Retina displays without lag
        useCORS: true,
        logging: false,
        backgroundColor: '#f6f7fb',
        
        // Force the screenshot layout to match your current screen exactly
        windowWidth: viewportWidth,
        
        // Hide the button from the screenshot
        ignoreElements: (node) => {
            return node.id === 'screenshotBtn' || node.id === 'roleFilterModal';
        },

        // INJECT STYLES INSIDE THE CAMERA (Invisible to user)
        onclone: (clonedDoc) => {
            const style = clonedDoc.createElement('style');
            style.innerHTML = `
                /* 1. Reset Card styling for sharpness */
                .active-card {
                    background-color: #ffffff !important;
                    border: 1px solid #cbd5e1 !important; 
                    box-shadow: none !important;
                    opacity: 1 !important;
                    transform: none !important;
                    /* Fix layout shifts */
                    padding-left: 16px !important; 
                    padding-right: 16px !important;
                }
                
                /* 2. Fix Faded Text / Opacity Issues */
                .active-card * {
                    opacity: 1 !important;
                    filter: none !important;
                    text-shadow: none !important;
                    -webkit-text-fill-color: initial !important;
                }

                /* 3. Enforce Solid Colors */
                h3, .time-val, .info-val, strong { 
                    color: #0f172a !important; 
                }
                p, .email, .label, .info-label, .info-icon { 
                    color: #64748b !important; 
                }

                /* 4. Restore Tag/Icon Colors */
                .ttkb .info-icon { color: #0284c7 !important; }
                .breakout .info-icon { color: #7c3aed !important; }
                .live-tag { color: #166534 !important; background-color: #dcfce7 !important; }
                .upcoming-tag { color: #c2410c !important; background-color: #fff7ed !important; }
            `;
            clonedDoc.head.appendChild(style);
            
            // Force sharp text rendering
            clonedDoc.documentElement.style.webkitFontSmoothing = 'antialiased';
        }
    });

    return new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png', 1.0);
    });
}

/**
 * Helper: Gets presigned URL from Netlify function and uploads to R2
 */
async function uploadBlobToWasabi(blob) {
    // 1. Get Presigned URL
    // Note: Assuming presign-wasabi.js is in your netlify/functions folder
    const presignRes = await fetch('/api/cal-presign-wasabi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext: 'png' })
    });

    if (!presignRes.ok) throw new Error('Failed to get upload URL');
    
    const presign = await presignRes.json();
    
    // Support different naming conventions from your other app
    const uploadUrl = presign.uploadUrl || presign.signedUrl || presign.url;
    const publicUrl = presign.publicUrl || presign.wasabiUrl || presign.cdnUrl;

    if (!uploadUrl || !publicUrl) throw new Error('Invalid server response');

    // 2. Upload to R2 (PUT)
    const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: blob
    });

    if (!putRes.ok) throw new Error('Failed to upload image to Cloudflare R2');

    return publicUrl;
}


/* =========================================
   LOGIN HANDLERS
   ========================================= */

function setupPasswordToggle() {
    const toggle = document.getElementById('togglePwd');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        const pwd = document.getElementById('password');
        pwd.type = pwd.type === 'password' ? 'text' : 'password';
    });
}

function setupLoginHandler() {
    const btn = document.getElementById('login');
    if (!btn) return;

    const submit = async () => {
        const msgEl = document.getElementById('message');
        msgEl.textContent = '';

        if (!client) return;

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
            // Login success: Reload page to trigger initApp again or just reload
            window.location.reload();
        }
    };

    btn.addEventListener('click', submit);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
    });
}


/* =========================================
   SCREENSHOT CONFIRMATION POPUP
   ========================================= */

function openScreenshotModal() {
    const modal = document.getElementById('screenshotConfirmModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
    }
}

function closeScreenshotModal() {
    const modal = document.getElementById('screenshotConfirmModal');
    if (modal) modal.style.display = 'none';
}

function confirmScreenshot() {
    // 1. Close the popup first
    closeScreenshotModal();

    // 2. Wait 200ms to ensure popup is completely invisible, then take the picture
    setTimeout(() => {
        handleScreenshotFlow();
    }, 200);
}