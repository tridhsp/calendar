// netlify/functions/teacher-blocks-clear-range.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};



module.exports = function(app) {
  app.post('/teacher-blocks-clear-range', async (req, res) => {
try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { availability_id, teacher_email } = (req.body || {});

    if (!availability_id || !teacher_email) {
      return res.status(400).json({ error: 'availability_id and teacher_email are required' });
    }

    // Verify the availability belongs to this teacher
    const { data: avail, error: aErr } = await supabase
      .from('teacher_availability')
      .select('id, teacher_email')
      .eq('id', availability_id)
      .maybeSingle();

    if (aErr || !avail) {
      return res.status(404).json({ error: 'Availability not found' });
    }
    if (avail.teacher_email !== teacher_email) {
      return res.status(403).json({ error: 'Availability belongs to a different teacher' });
    }

    // Delete all blocks in this availability range
    const { error: dErr, count } = await supabase
      .from('teacher_blocks')
      .delete({ count: 'exact' })
      .eq('availability_id', availability_id);

    if (dErr) {
      return res.status(500).json({ error: dErr.message });
    }

    return res.status(200).json({ ok: true, deleted: count || 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
  });
};
