// netlify/functions/check-level-assignment.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/check-level-assignment', async (req, res) => {
try {
    const { teacherEmail, studentEmail } = (req.body || {});

    if (!teacherEmail || !studentEmail) {
      return res.status(400).json({ ok: false, error: 'Missing teacherEmail or studentEmail' });
    }

    const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Get student's level from danh_sach_hv
    const { data: student, error: sErr } = await supabase
      .from('danh_sach_hv')
      .select('cap_lop_hoc')
      .eq('email', studentEmail)
      .maybeSingle();

    if (sErr) throw sErr;

    const studentLevel = student?.cap_lop_hoc || '';

    // If student has no level assigned, allow assignment
    if (!studentLevel) {
      return res.status(200).json({ ok: true, allowed: true, studentLevel: '', allowedLevels: [] });
    }

    // 2) Get teacher's allowed levels from level_assignments
    const { data: assignments, error: aErr } = await supabase
      .from('level_assignments')
      .select('class_name')
      .eq('teacher_email', teacherEmail);

    if (aErr) throw aErr;

    const allowedLevels = (assignments || []).map(a => a.class_name);

    // 3) Check if student's level is in teacher's allowed levels
    const allowed = allowedLevels.includes(studentLevel);

    return res.status(200).json({
        ok: true,
        allowed,
        studentLevel,
        allowedLevels
      });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
  });
};
