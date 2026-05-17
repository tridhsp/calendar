const { createClient } = require('@supabase/supabase-js');

// 1. Timezone Helpers
function getBangkokDate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
}

function bangkokYMD() {
    const d = getBangkokDate();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function bangkokDOW() {
    return getBangkokDate().getDay(); // 0=Sun
}

function getBangkokMinutes() {
    const d = getBangkokDate();
    return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(t) {
    if (!t) return -1;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

module.exports = function(app) {
  app.get('/get-active-students', async (req, res) => {
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    try {
        const today = bangkokYMD();
        const dow = bangkokDOW();
        const nowMins = getBangkokMinutes();

        // --- A. FETCH ACTIVE SESSIONS (Joined) ---
        const { data: reports, error: rErr } = await supabase
            .from('learn_status_reports')
            .select('student_email, student_name, start_time, check_in_teacher')
            .eq('joined_status_today', today)
            .is('email_gv_complete', null);

        if (rErr) throw rErr;

        // Set of emails already active (to avoid duplicates)
        const activeEmails = new Set(reports.map(r => r.student_email));

        // --- B. FETCH SCHEDULES (For Details & Upcoming Check) ---
        // CORRECTED: Removed 'student_name' from this select because it doesn't exist in student_schedule
        const { data: schedules, error: sErr } = await supabase
            .from('student_schedule')
            .select('student_email, teacher_email, breakout_email, buoi_phu, time_local')
            .eq('day_of_week', dow);

        if (sErr) throw sErr;

// --- C. IDENTIFY UPCOMING STUDENTS ---
        const upcomingStudents = [];
        const LOOKAHEAD_MINS = 15;

        (schedules || []).forEach(sched => {
            // 1. Skip if already active
            if (activeEmails.has(sched.student_email)) return;

            // 2. Check time window
            const sMins = timeToMinutes(sched.time_local);
            const diff = sMins - nowMins;

            // Condition: Starts in 0 to 20 mins
            if (diff >= 0 && diff <= LOOKAHEAD_MINS) {
                upcomingStudents.push({
                    type: 'upcoming',
                    student_email: sched.student_email,
                    student_name: null, // Will be filled by profile lookup later
                    start_time: null, 
                    sched_time: sched.time_local,
                    check_in_teacher: null,
                    sched_data: sched
                });
            }
        });

        // --- D. PREPARE ALL EMAILS FOR LOOKUP ---
        const combinedList = [
            ...reports.map(r => ({ ...r, type: 'active' })),
            ...upcomingStudents
        ];

        if (combinedList.length === 0) {
            return res.status(200).json({ ok: true, data: [] });
        }

        const allEmails = combinedList.map(r => r.student_email);

        // --- E. FETCH PROFILES (Max Mins / Names) ---
        // We get the name from here (ten_hv)
        const { data: profiles } = await supabase
            .from('danh_sach_hv')
            .select('email, max, ten_hv')
            .in('email', allEmails);
        
        const profileMap = new Map((profiles || []).map(p => [p.email, p]));

        // --- F. RESOLVE TEACHER NAMES ---
        const teacherEmails = new Set();
        
        const scheduleMap = new Map();
        (schedules || []).forEach(s => scheduleMap.set(s.student_email, s));

        combinedList.forEach(item => {
            if (item.check_in_teacher) teacherEmails.add(item.check_in_teacher);
            
            const s = item.type === 'upcoming' ? item.sched_data : scheduleMap.get(item.student_email);
            if (s) {
                if (s.teacher_email) teacherEmails.add(s.teacher_email);
                if (s.breakout_email) teacherEmails.add(s.breakout_email);
                item._sched = s; 
            }
        });

        let nameMap = new Map();
        if (teacherEmails.size > 0) {
            const { data: users } = await supabase
                .from('user_roles')
                .select('email, full_name')
                .in('email', Array.from(teacherEmails));
            (users || []).forEach(u => nameMap.set(u.email, u.full_name || u.email));
        }

        // --- G. BUILD FINAL RESPONSE ---
        const result = combinedList.map(r => {
            const sched = r._sched || {};
            const prof = profileMap.get(r.student_email) || {};
            
            // Name Priority: Profile Name (ten_hv) > Report Name > Email
            const finalName = prof.ten_hv || r.student_name || r.student_email;

            let limit = 0;
            if (sched.buoi_phu) limit = 25;
            else if (prof.max) limit = parseInt(prof.max, 10);

            let virtualStartTime = r.start_time;
            if (r.type === 'upcoming') {
                virtualStartTime = `${today}T${r.sched_time}:00+07:00`; 
            }

            return {
                status: r.type, 
                student_email: r.student_email,
                student_name: finalName,
                start_time: virtualStartTime, 
                limit_minutes: limit,
                reporter_name: nameMap.get(r.check_in_teacher) || r.check_in_teacher || '—',
                ttkb_teacher: nameMap.get(sched.teacher_email) || sched.teacher_email || '—',
                breakout_teacher: nameMap.get(sched.breakout_email) || sched.breakout_email || '—'
            };
        });

        return res.status(200).json({ ok: true, data: result });

    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
  });
};
