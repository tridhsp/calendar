// netlify/functions/delete-student-schedules.js
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

module.exports = function(app) {
  app.post('/delete-student-schedules', async (req, res) => {
try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;

    const { email } = (req.body || {});

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok:false, error:'Server not configured' });
    }
    if (!email) {
      return res.status(400).json({ ok:false, error:'email is required' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // delete & return number of rows deleted
    const { data, error } = await supabase
      .from('student_schedule')
      .delete()
      .eq('student_email', email)
      .select('id');

    if (error) throw error;
    const deleted = Array.isArray(data) ? data.length : 0;

    return res.status(200).json({ ok:true, deleted });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
  });
};
