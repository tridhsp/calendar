// netlify/functions/save-teacher-availability.js
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

module.exports = function(app) {
  app.post('/save-teacher-availability', async (req, res) => {
try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok:false, error:'Server not configured' });
    }


    const { teacherEmail, ranges, currentUserId, runReassign = true } = (req.body || {});
    if (!teacherEmail || !Array.isArray(ranges) || ranges.length === 0) {
      return res.status(400).json({ ok:false, error:'teacherEmail and ranges are required' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ensure teacher row (teachers.name stores EMAIL)
    let teacherId = null;
    const { data: existing, error: selErr } = await supabase
      .from('teachers').select('id').eq('name', teacherEmail).maybeSingle();
    if (selErr) throw selErr;

    if (existing?.id) {
      teacherId = existing.id;
    } else {
      const { data: created, error: insErr } = await supabase
        .from('teachers')
        .insert({ name: teacherEmail, created_by: currentUserId || null })
        .select('id').single();
      if (insErr) throw insErr;
      teacherId = created.id;
    }

    // derive creator email (optional)
    let creatorEmail = null;
    if (currentUserId) {
      const { data: ur } = await supabase
        .from('user_roles').select('email').eq('uid', currentUserId).maybeSingle();
      creatorEmail = ur?.email || null;
    }

    // wipe + insert availability
    const { error: delErr } = await supabase.from('teacher_availability').delete().eq('teacher_id', teacherId);
    if (delErr) throw delErr;

    const payload = ranges
      .filter(r => r && r.day_of_week != null && r.time_start && r.time_end)
      .map(r => ({
        teacher_id: teacherId,
        teacher_email: teacherEmail,
        creator_email: creatorEmail,
        created_by: currentUserId || null,
        day_of_week: r.day_of_week,
        time_start: r.time_start,
        time_end: r.time_end,
        timezone: r.timezone || 'Asia/Ho_Chi_Minh'
      }));

    if (!payload.length) {
      return res.status(400).json({ ok:false, error:'No valid ranges' });
    }

    const { error: insAvailErr } = await supabase.from('teacher_availability').insert(payload);
    if (insAvailErr) throw insAvailErr;

    // optional: reassign via local Express endpoint
    let changed = 0, unmapped = 0;
    if (runReassign) {
      {
        const rsp = await fetch(`http://localhost:3111/reassign-after-teacher-change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teacher_id: teacherId })
        });
        const out = await rsp.json().catch(() => ({}));
        if (rsp.ok && out?.ok) {
          changed = out.changed || 0;
          unmapped = out.unmapped || 0;
        }
      }
    }

    return res.status(200).json({ ok:true, teacherId, inserted: payload.length, changed, unmapped });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
  });
};
