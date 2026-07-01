// learn-testprep-noscore.calendar.js
// Saves the teacher's reason when a Test_Prep learner finished a learning day
// WITHOUT being scored. Writes ONLY to the new hv_test_prep_chua_lam_bai table.
// Requires the teacher's login, so the row records who actually marked it.

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY
  );
}

// Today's date in Bangkok, "YYYY-MM-DD".
function bangkokYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = function (app) {
  app.post('/learn-testprep-noscore', async (req, res) => {
    try {
      const sb = getSupabase();

      // --- Who is calling? Verify the login token, then map to their staff email. ---
      const authz = (req.headers && req.headers.authorization) || '';
      const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
      if (!token) return res.status(401).json({ ok: false, error: 'Missing bearer token' });

      const { data: authUser, error: authErr } = await sb.auth.getUser(token);
      if (authErr || !authUser || !authUser.user) {
        return res.status(401).json({ ok: false, error: 'Invalid token' });
      }
      const uid = authUser.user.id;
      const authEmail = authUser.user.email || '';
      const { data: ur } = await sb
        .from('user_roles')
        .select('email')
        .eq('uid', uid)
        .maybeSingle();
      const teacher_email = (((ur && ur.email) || authEmail) || '').trim();

      // --- Inputs ---
      const student_email = String((req.body && req.body.student_email) || '').trim();
      const ly_do = String((req.body && req.body.ly_do) || '').trim();
      if (!student_email) return res.status(400).json({ ok: false, error: 'Missing student_email' });
      if (!ly_do) return res.status(400).json({ ok: false, error: 'Missing reason' });

      // --- Fill in the learner's name + level for the log (nice for reports). ---
      let student_name = String((req.body && req.body.student_name) || '').trim();
      let cap_lop_hoc = '';
      const { data: hv } = await sb
        .from('danh_sach_hv')
        .select('ten_hv, cap_lop_hoc')
        .eq('email', student_email)
        .maybeSingle();
      if (hv) {
        if (!student_name && hv.ten_hv) student_name = String(hv.ten_hv).trim();
        if (hv.cap_lop_hoc) cap_lop_hoc = String(hv.cap_lop_hoc).trim();
      }

      // --- One row per student per learning day; re-submitting updates the reason. ---
      const row = {
        teacher_email,
        student_email,
        student_name: student_name || null,
        cap_lop_hoc: cap_lop_hoc || null,
        ngay_hoc: bangkokYMD(),
        ly_do
      };

      const { error: upErr } = await sb
        .from('hv_test_prep_chua_lam_bai')
        .upsert(row, { onConflict: 'student_email,ngay_hoc' });
      if (upErr) throw upErr;

      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });
};
