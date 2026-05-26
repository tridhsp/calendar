// netlify/functions/student-minutes.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};



module.exports = function(app) {
  app.post('/student-minutes', async (req, res) => {
try {
    const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
    const { email } = (req.body || {});
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const { data, error } = await supabase
      .from('danh_sach_hv')
      .select('status')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const raw = data?.status;
    const minutes = Number(raw);
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : null;

    return res.status(200).json({ minutes: safeMinutes });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
  });
};
