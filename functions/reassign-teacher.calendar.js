// Converted from netlify/functions/reassign-teacher.mjs (ESM -> CJS)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/reassign-teacher', async (req, res) => {
    try {
      const { teacherEmail } = req.body || {};
      if (!teacherEmail) {
        return res.status(400).send('Missing teacherEmail');
      }

      const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_ROLE) {
        return res.status(500).send('Server not configured');
      }

      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false }
      });

      // Get this teacher's latest availability ranges
      const { data: ranges, error: rErr } = await supabase
        .from('teacher_availability')
        .select('day_of_week, time_start, time_end, teacher_email')
        .eq('teacher_email', teacherEmail);

      if (rErr) throw rErr;

      // Helper: is a time within any range for the teacher?
      const covers = (day, time) => {
        for (const r of ranges || []) {
          if (r.day_of_week === day && r.time_start <= time && time < r.time_end) return true;
        }
        return false;
      };

      // All schedule rows currently assigned to this teacher
      const { data: scheds, error: sErr } = await supabase
        .from('student_schedule')
        .select('id, day_of_week, time_local, teacher_email')
        .eq('teacher_email', teacherEmail);

      if (sErr) throw sErr;

      let changed = 0, unmapped = 0;

      for (const sc of scheds || []) {
        if (covers(sc.day_of_week, sc.time_local)) continue; // still covered, do nothing

        // Find other teachers who cover this slot
        const { data: options, error: oErr } = await supabase
          .from('teacher_availability')
          .select('teacher_email')
          .eq('day_of_week', sc.day_of_week)
          .lte('time_start', sc.time_local)
          .gt('time_end', sc.time_local);

        if (oErr) continue;

        const candidates = Array.from(new Set((options || []).map(o => o.teacher_email)))
          .filter(e => e && e !== teacherEmail)
          .sort((a, b) => a.localeCompare(b));

        if (!candidates.length) {
          // No replacement → unassign
          await supabase.from('student_schedule')
            .update({ teacher_email: null })
            .eq('id', sc.id);
          unmapped++;
          continue;
        }

        const chosenEmail = candidates[0];

        const { error: updErr } = await supabase
          .from('student_schedule')
          .update({ teacher_email: chosenEmail })
          .eq('id', sc.id);

        if (!updErr) changed++;
      }

      return res.status(200).json({ changed, unmapped });
    } catch (e) {
      return res.status(500).send(String(e?.message || e));
    }
  });
};
