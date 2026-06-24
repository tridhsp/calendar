// netlify/functions/learn-short-report.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/learn-short-report', async (req, res) => {
// Parse JSON body
  let body;
  try {
    body = (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const student_email = String(body.student_email || '').trim();
  const student_name = String(body.student_name || '').trim();
  const textRaw = String(body.text || '').trim();

  if (!student_email || !textRaw) {
    return res.status(400).json({ error: 'student_email and text are required' });
  }

  // Optional: small length cap to avoid absurd payloads
  const text = textRaw.slice(0, 4000);

  // Env + admin client
  // Env + admin client
  const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);


  // ── Authn: read & verify bearer token ────────────────────────────────────────
  const authz = req.headers.authorization || req.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const { data: authUser, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authUser?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Map uid -> staff email in user_roles; fallback to auth email
  const uid = authUser.user.id;
  const authEmail = authUser.user.email || '';
  const { data: ur } = await admin
    .from('user_roles')
    .select('email')
    .eq('uid', uid)
    .maybeSingle();

  const created_by = (ur?.email || authEmail || '').trim();

  // ── Date (Bangkok) ──────────────────────────────────────────────────────────
  const todayBangkok = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // "YYYY-MM-DD"

  try {
    // Find existing row for today
    const { data: row, error: selErr } = await admin
      .from('learn_status_reports_bc_ngan')
      .select('id, bc_ngan, created_by')
      .eq('student_email', student_email)
      .eq('joined_status_today', todayBangkok)
      .maybeSingle();
    if (selErr) throw selErr;

    if (row?.id) {
      // Append to arrays
      const nextBc = [...(row.bc_ngan || []), text];
      const nextBy = [...(row.created_by || []), created_by];

      const { error: updErr } = await admin
        .from('learn_status_reports_bc_ngan')
        .update({ bc_ngan: nextBc, created_by: nextBy })
        .eq('id', row.id);
      if (updErr) throw updErr;

      return res.status(200).json({ ok: true, mode: 'append', created_by });
    } else {
      // First note today → create
      const { error: insErr } = await admin
        .from('learn_status_reports_bc_ngan')
        .insert({
          student_email,
          student_name: student_name || student_email,
          joined_status_today: todayBangkok,
          bc_ngan: [text],
          created_by: [created_by],
        });
      if (insErr) throw insErr;

      return res.status(200).json({ ok: true, mode: 'insert', created_by });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  });
};

