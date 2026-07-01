// netlify/functions/load-student-editor.js
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

module.exports = function(app) {
  app.post('/load-student-editor', async (req, res) => {
try {
    const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const { email } = (req.body || {});


    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok:false, error:'Server not configured' });
    }
    if (!email) {
      return res.status(400).json({ ok:false, error:'email is required' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: hv, error: hvErr } = await supabase
      .from('danh_sach_hv')
      .select('status').eq('email', email).maybeSingle();
    if (hvErr) throw hvErr;

    const { data: scheds, error: sErr } = await supabase
      .from('student_schedule')
      .select('day_of_week, time_local, buoi_phu, sessions_per_day')
      .eq('student_email', email)
      .order('day_of_week', { ascending: true })
      .order('time_local', { ascending: true });
    if (sErr) throw sErr;

    return res.status(200).json({
      ok: true,
      status: hv?.status ?? '',
      schedules: scheds || []
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
  });
};
