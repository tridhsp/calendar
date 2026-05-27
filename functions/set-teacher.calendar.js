// netlify/functions/set-teacher.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/set-teacher', async (req, res) => {
try {
    const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }


    const { schedId, teacherEmail } = (req.body || {});
    if (!schedId) {
      return res.status(400).json({ ok: false, error: 'schedId is required' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Load the schedule row for day/time info
    const { data: sched, error: sErr } = await supabase
      .from('student_schedule')
      .select('id, day_of_week, time_local')
      .eq('id', schedId)
      .maybeSingle();

    if (sErr) throw sErr;
    if (!sched) {
      return res.status(404).json({ ok: false, error: 'Schedule not found' });
    }

    // Unassign
    if (teacherEmail == null || teacherEmail === '') {
      const { error: uErr } = await supabase
        .from('student_schedule')
        .update({ teacher_email: null, assigned_teacher_id: null })
        .eq('id', schedId);

      if (uErr) throw uErr;
      return res.status(200).json({ ok: true, unassigned: true });
    }

    // Assign — verify teacher exists
    const { data: teacher, error: tErr } = await supabase
      .from('teachers')
      .select('id')
      .eq('name', teacherEmail) // your app stores the teacher's EMAIL in teachers.name
      .maybeSingle();
    if (tErr) throw tErr;
    if (!teacher) {
      return res.status(400).json({ ok: false, error: 'Teacher not found' });
    }

    // Check availability covers this day/time
    const { data: avail, error: aErr } = await supabase
      .from('teacher_availability')
      .select('id')
      .eq('teacher_id', teacher.id)
      .eq('day_of_week', sched.day_of_week)
      .lte('time_start', sched.time_local)
      .gt('time_end', sched.time_local);

    if (aErr) throw aErr;
    if (!avail || avail.length === 0) {
      return res.status(400).json({ ok: false, error: 'Teacher is not available at this time' });
    }

    // Update schedule with teacher email (and clear assigned_teacher_id)
    const { error: updErr } = await supabase
      .from('student_schedule')
      .update({ teacher_email: teacherEmail, assigned_teacher_id: null })
      .eq('id', schedId);
    if (updErr) throw updErr;

    // Optional: return a label to show (full name if available)
    let label = teacherEmail;
    const { data: ur } = await supabase
      .from('user_roles')
      .select('full_name')
      .eq('email', teacherEmail)
      .maybeSingle();
    if (ur?.full_name) label = ur.full_name;

    return res.status(200).json({ ok: true, teacherEmail, label });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
  });
};
