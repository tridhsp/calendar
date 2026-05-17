// Converted from netlify/functions/save-teacher-schedule.mjs (ESM -> CJS)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/save-teacher-schedule', async (req, res) => {
    try {
      const body = req.body || {};
      const teacherEmail = (body.teacherEmail || '').trim();
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const userToken = body.userToken || null;

      if (!teacherEmail) {
        return res.status(400).send('Missing teacherEmail');
      }
      if (!rows.length) {
        return res.status(400).send('No time ranges provided');
      }

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;

      if (!SUPABASE_URL || !SERVICE_ROLE) {
        const missing = [
          !SUPABASE_URL ? 'SUPABASE_URL' : null,
          !SERVICE_ROLE ? 'SUPABASE_SERVICE_KEY' : null,
        ]
          .filter(Boolean)
          .join(', ');
        return res.status(500).send(`Server not configured: missing ${missing}`);
      }

      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Figure out who is saving (from the access token you send us)
      let actorUid = null;
      let actorEmail = null;
      if (userToken) {
        const { data: userData, error: userErr } =
          await supabase.auth.getUser(userToken);
        if (!userErr && userData?.user) {
          actorUid = userData.user.id || null;
          actorEmail = userData.user.email || null;
        }
        if (actorUid && !actorEmail) {
          const { data: ur } = await supabase
            .from('user_roles')
            .select('email')
            .eq('uid', actorUid)
            .maybeSingle();
          actorEmail = ur?.email || null;
        }
      }

      // Get or create teacher row (teachers.name = email)
      const { data: existing, error: selErr } = await supabase
        .from('teachers')
        .select('id')
        .eq('name', teacherEmail)
        .maybeSingle();
      if (selErr) throw selErr;

      let teacherId = existing?.id || null;
      if (!teacherId) {
        const { data: created, error: insErr } = await supabase
          .from('teachers')
          .insert({ name: teacherEmail, created_by: actorUid, email: teacherEmail })
          .select('id')
          .single();
        if (insErr) throw insErr;
        teacherId = created.id;
      } else {
        // Update email if it was missing
        await supabase
          .from('teachers')
          .update({ email: teacherEmail })
          .eq('id', teacherId);
      }

      // Replace all availability for this teacher
      const { error: delErr } = await supabase
        .from('teacher_availability')
        .delete()
        .eq('teacher_id', teacherId);
      if (delErr) throw delErr;

      // Look up teacher full name by email (optional)
      let teacherFullName = null;
      try {
        const { data: urName } = await supabase
          .from('user_roles')
          .select('full_name')
          .eq('email', teacherEmail)
          .maybeSingle();
        teacherFullName = urName?.full_name || null;
      } catch {}

      // Build rows for insert
      const payload = rows
        .filter(
          (r) =>
            r &&
            typeof r.day_of_week === 'number' &&
            r.time_start &&
            r.time_end
        )
        .map((r) => ({
          teacher_id: teacherId,
          teacher_email: teacherEmail,
          teacher_name: teacherFullName,
          creator_email: actorEmail,
          created_by: actorUid,
          day_of_week: r.day_of_week,
          time_start: r.time_start,
          time_end: r.time_end,
          timezone: r.timezone || 'Asia/Ho_Chi_Minh',
        }));

      if (!payload.length) {
        return res.status(400).send('No valid rows to insert');
      }

      const { data: inserted, error: ins2Err } = await supabase
        .from('teacher_availability')
        .insert(payload)
        .select('id');
      if (ins2Err) throw ins2Err;

      return res.status(200).json({
        ok: true,
        teacherId,
        inserted: inserted?.length || 0,
      });
    } catch (e) {
      return res.status(500).send(String(e?.message || e));
    }
  });
};
