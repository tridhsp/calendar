// Uses new Netlify env vars: SUPABASE_URL and SUPABASE_ANON_KEY

module.exports = function(app) {
  app.get('/cal-supabase-credentials', async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY;

  return res.status(200).json({
      SUPABASE_URL,
      ANON_PUBLIC_KEY
    });
  });
};
