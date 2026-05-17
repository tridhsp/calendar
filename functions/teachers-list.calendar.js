const { createClient } = require('@supabase/supabase-js');
module.exports = function(app) {
  app.post('/teachers-list', async (req, res) => {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await supabase.from('teacher_availability').select('teacher_email').not('teacher_email', 'is', null);
      if (error) return res.status(500).json({ error: error.message });
      const emails = Array.from(new Set((data || []).map(r => r.teacher_email))).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
      return res.status(200).json({ emails });
    } catch (err) { return res.status(500).json({ error: err.message || 'Unexpected error' }); }
  });
};
