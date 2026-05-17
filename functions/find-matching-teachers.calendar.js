// netlify/functions/find-matching-teachers.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/find-matching-teachers', async (req, res) => {
try {
    const { day_of_week, time_local } = (req.body || {});
    if (typeof day_of_week !== 'number' || !time_local) {
      return res.status(400).json({ error: 'Missing day_of_week or time_local' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Server not configured (missing env vars)' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Query availability that covers the requested slot
    const { data, error } = await supabase
      .from('teacher_availability')
      .select('teacher_email')
      .eq('day_of_week', day_of_week)
      .lte('time_start', time_local)
      .gt('time_end', time_local);

    if (error) throw error;

    const emails = [...new Set((data || [])
      .map(r => r.teacher_email)
      .filter(Boolean))].sort();

    return res.status(200).json({ ok: true, emails });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
  });
};
