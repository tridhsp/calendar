// learn-testprep-status.calendar.js
// After a teacher clicks Complete, the learntoday page asks this route:
//   "Is this learner in Test_Prep, and have they been scored today?"
// READ-ONLY — it changes nothing in the database.

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Start of "today" in Bangkok (UTC+7), as an instant we can compare created_at against.
function bangkokTodayStartISO() {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // "YYYY-MM-DD" in Bangkok
  return new Date(`${ymd}T00:00:00+07:00`).toISOString();
}

module.exports = function (app) {
  app.post('/learn-testprep-status', async (req, res) => {
    try {
      const student_email = String((req.body && req.body.student_email) || '').trim();
      if (!student_email) {
        return res.status(400).json({ ok: false, error: 'Missing student_email' });
      }

      const sb = getSupabase();

      // 1) Look up the learner's level + name.
      const { data: hv, error: hvErr } = await sb
        .from('danh_sach_hv')
        .select('ten_hv, cap_lop_hoc')
        .eq('email', student_email)
        .maybeSingle();
      if (hvErr) throw hvErr;

      const student_name = (hv && hv.ten_hv) ? String(hv.ten_hv).trim() : '';
      const cap_lop_hoc = (hv && hv.cap_lop_hoc) ? String(hv.cap_lop_hoc).trim() : '';

      // 2) Is this a Test_Prep level? (same rule the app already uses elsewhere)
      const lvl = cap_lop_hoc.toUpperCase();
      const isTestPrep = lvl.includes('TEST_PREP') || lvl.includes('TEST-PREP');

      // Not Test_Prep -> nothing to warn about; tell the page to do nothing.
      if (!isTestPrep) {
        return res.status(200).json({
          ok: true, isTestPrep: false, scoredToday: null, student_name, cap_lop_hoc
        });
      }

      // 3) Scored today? The score app stores the learner by EMAIL in its "learner"
      //    field, so we match on email (and on name too, just in case).
      const candidates = [student_email];
      if (student_name && student_name !== student_email) candidates.push(student_name);

      const { data: scored, error: scErr } = await sb
        .from('score_results')
        .select('id')
        .in('learner', candidates)
        .gte('created_at', bangkokTodayStartISO())
        .limit(1);
      if (scErr) throw scErr;

      const scoredToday = !!(scored && scored.length);

      return res.status(200).json({
        ok: true, isTestPrep: true, scoredToday, student_name, cap_lop_hoc
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });
};
