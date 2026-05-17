const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/reassign-after-teacher-change', async (req, res) => {
try {
    const { teacher_id } = (req.body || {});
    if (!teacher_id) {
      return res.status(400).send('Missing teacher_id');
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).send('Server not configured (missing env vars)');
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


    // 1) Latest availability ranges for this teacher
    const { data: ranges, error: rErr } = await supabase
      .from('teacher_availability')
      .select('day_of_week, time_start, time_end')
      .eq('teacher_id', teacher_id);
    if (rErr) throw rErr;

    const covers = (day, time) =>
      (ranges || []).some(r => r.day_of_week === day && r.time_start <= time && time < r.time_end);

    // 2) All schedules currently assigned to this teacher
    const { data: scheds, error: sErr } = await supabase
      .from('student_schedule')
      .select('id, day_of_week, time_local')
      .eq('assigned_teacher_id', teacher_id);
    if (sErr) throw sErr;

    let changed = 0, unmapped = 0;

    for (const sc of (scheds || [])) {
      // keep if still covered
      if (covers(sc.day_of_week, sc.time_local)) continue;

      // 3) Find replacements that cover this slot
      const { data: options, error: oErr } = await supabase
        .from('teacher_availability')
        .select('teacher_id')
        .eq('day_of_week', sc.day_of_week)
        .lte('time_start', sc.time_local)
        .gt('time_end', sc.time_local);
      if (oErr) throw oErr;

      const candidates = [...new Set((options || []).map(o => o.teacher_id))]
        .filter(id => id !== teacher_id);

      if (!candidates.length) {
        // No replacement → unassign
        const { error: uErr } = await supabase
          .from('student_schedule')
          .update({ assigned_teacher_id: null, teacher_email: null })
          .eq('id', sc.id);
        if (uErr) throw uErr;
        unmapped++;
        continue;
      }

      // Choose a stable default: alphabetical by teacher name
      let chosen = candidates[0];
      const { data: tRows, error: tErr } = await supabase
        .from('teachers')
        .select('id, name')
        .in('id', candidates)
        .order('name', { ascending: true });
      if (!tErr && tRows?.length) chosen = tRows[0].id;

      const { error: updErr } = await supabase
        .from('student_schedule')
        .update({ assigned_teacher_id: chosen, teacher_email: null })
        .eq('id', sc.id);
      if (updErr) throw updErr;
      changed++;
    }

    return res.status(200).json({ ok: true, changed, unmapped });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
  });
};
