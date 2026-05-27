const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/get-user-email', async (req, res) => {
const supabaseUrl = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);


  try {
    const uid = req.query.uid;

    if (!uid) {
      return res.status(400).json({ error: 'uid is required' });
    }

    const { data, error } = await supabase
      .from('user_roles')
      .select('email')
      .eq('uid', uid)
      .maybeSingle();

    if (error) throw error;

    return res.status(200).json({ email: data?.email || null });

  } catch (error) {
    console.error('Error fetching user email:', error);
    return res.status(500).json({ error: error.message });
  }
  });
};
