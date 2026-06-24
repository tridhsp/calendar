// netlify/functions/search-teachers.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/cal-search-teachers', async (req, res) => {
try {
    const { q } = (req.body || {});

    const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured (missing env vars)' });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


    const { data, error } = await supabase
      .from('user_roles')
      .select('uid, email, full_name')
      .or(`email.ilike.%${q || ''}%,full_name.ilike.%${q || ''}%`)
      .order('email', { ascending: true })
      .limit(10);

    if (error) throw error;

    return res.status(200).json({ ok: true, rows: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
  });
};
