

module.exports = function(app) {
  app.post('/set-breakout-teacher-cal', async (req, res) => {
  try {
const { schedId, breakoutEmail } = (req.body || {});
    if (!schedId) {
      return res.status(400).json({ ok: false, error: 'Missing schedId' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);


    const { error } = await supabase
      .from('student_schedule')
      .update({ breakout_email: breakoutEmail })
      .eq('id', schedId);

    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
  });
};
