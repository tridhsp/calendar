// Converted from netlify/functions/user-role-suggest.js (ESM -> CJS)
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/user-role-suggest', async (req, res) => {
    try {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_ROLE) {
        return res.status(500).json({ error: 'Missing server env vars' });
      }

      const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

      // Validate token (ensures only logged-in users can call this)
      const { data: authUser, error: authErr } = await admin.auth.getUser(token);
      if (authErr || !authUser?.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { q = '', exclude_emails = [] } = req.body || {};
      const query = String(q || '').trim();
      const exclude = Array.isArray(exclude_emails) ? exclude_emails.map(e => String(e || '').toLowerCase()) : [];

      if (query.length < 4) {
        return res.status(200).json({ data: [] });
      }

      // Search user_roles by full_name
      const { data, error } = await admin
        .from('user_roles')
        .select('full_name,email')
        .ilike('full_name', `%${query}%`)
        .order('full_name', { ascending: true })
        .limit(8);

      if (error) {
        return res.status(400).json({ error: error.message || 'Query failed' });
      }

      // Filter out emails already on the page (case-insensitive)
      const filtered = (data || []).filter(r => !exclude.includes(String(r.email || '').toLowerCase()));

      return res.status(200).json({ data: filtered });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};
