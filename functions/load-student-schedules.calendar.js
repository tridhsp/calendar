// netlify/functions/load-student-schedules.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

module.exports = function(app) {
  app.get('/load-student-schedules', async (req, res) => {
try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured (missing env vars)' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


    // 1) Schedules
    const { data: scheds, error: sErr } = await supabase
      .from('student_schedule')
      .select('id, student_email, day_of_week, time_local, timezone, assigned_teacher_id, teacher_email, breakout_email, buoi_phu');
    if (sErr) throw sErr;

    // 2) Students (status + display name)
    const uniqEmails = Array.from(new Set((scheds || []).map(r => r.student_email))).filter(Boolean);
    let hvRows = [];
    if (uniqEmails.length) {
      const { data, error } = await supabase
        .from('danh_sach_hv')
      .select('email, status, ten_hv, cap_lop_hoc')
        .in('email', uniqEmails);
      if (!error) hvRows = data || [];
    }
    const hvByEmail = new Map(hvRows.map(r => [r.email, r]));
const students = uniqEmails
      .map(email => {
        const rec = hvByEmail.get(email) || {};
        return {
          email,
          status: rec.status ?? '',
          displayName: rec.ten_hv || email,
          cap_lop_hoc: rec.cap_lop_hoc || ''
        };
      })
      .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));

    // 3) Teachers - Get users with role = Teacher, Admin, or Super Admin from user_roles
    const { data: teacherUsers, error: tErr } = await supabase
      .from('user_roles')
      .select('email, full_name')
      .in('role', ['Teacher', 'Admin', 'Super Admin'])
      .order('full_name', { ascending: true });
    if (tErr) throw tErr;

    // Convert to the format expected by frontend (id, name)
    // Convert to the format expected by frontend (id, name)
    const teachers = (teacherUsers || []).map(t => ({
      id: t.email,
      name: t.email
    }));

    // 4) Availability
    const { data: availability, error: aErr } = await supabase
      .from('teacher_availability')
      .select('teacher_id, day_of_week, time_start, time_end');
    if (aErr) throw aErr;

    // 5) Teacher full names by email (for labels)
    const uniqTeacherEmails = Array.from(new Set(
      (scheds || [])
        .flatMap(r => [r.teacher_email, r.breakout_email])
        .filter(Boolean)
    ));

    const teacherNamesByEmail = {};
    const validTeacherEmails = new Set(); // emails that exist in user_roles with role=Teacher

    if (uniqTeacherEmails.length) {
      const { data: trows, error: terr } = await supabase
        .from('user_roles')
        .select('email, full_name, role')
        .in('email', uniqTeacherEmails);
      if (terr) throw terr;
      for (const r of (trows || [])) {
        // Consider valid if role is Teacher, Admin, or Super Admin
        if (r.role === 'Teacher' || r.role === 'Admin' || r.role === 'Super Admin') {
          teacherNamesByEmail[r.email] = r.full_name || r.email;
          validTeacherEmails.add(r.email);
        }
      }
    }

    // 6) AUTO-CLEANUP: Remove invalid teacher assignments
    // Find schedules where teacher_email or breakout_email is NOT in validTeacherEmails
    const invalidTeacherScheds = (scheds || []).filter(
      s => s.teacher_email && !validTeacherEmails.has(s.teacher_email)
    );
    const invalidBreakoutScheds = (scheds || []).filter(
      s => s.breakout_email && !validTeacherEmails.has(s.breakout_email)
    );

    // Clear invalid teacher_email assignments
    if (invalidTeacherScheds.length) {
      const ids = invalidTeacherScheds.map(s => s.id);
      await supabase
        .from('student_schedule')
        .update({ teacher_email: null })
        .in('id', ids);
      // Also update local data so UI shows corrected state
      for (const s of scheds) {
        if (s.teacher_email && !validTeacherEmails.has(s.teacher_email)) {
          s.teacher_email = null;
        }
      }
      console.log(`Cleaned up ${ids.length} invalid teacher_email assignments`);
    }

    // Clear invalid breakout_email assignments
    if (invalidBreakoutScheds.length) {
      const ids = invalidBreakoutScheds.map(s => s.id);
      await supabase
        .from('student_schedule')
        .update({ breakout_email: null })
        .in('id', ids);
      // Also update local data
      for (const s of scheds) {
        if (s.breakout_email && !validTeacherEmails.has(s.breakout_email)) {
          s.breakout_email = null;
        }
      }
      console.log(`Cleaned up ${ids.length} invalid breakout_email assignments`);
    }

    return res.status(200).json({
        ok: true,
        data: {
          schedules: scheds || [],
          students: students || [],
          teachers: teachers || [],
          availability: availability || [],
          teacherNamesByEmail // plain object; client will convert to Map
        }
      });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
  });
};
