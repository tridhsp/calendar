// netlify/functions/teacher-blocks-set-student.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};



module.exports = function(app) {
  app.post('/teacher-blocks-set-student', async (req, res) => {
try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { block_id, teacher_email, student_email } = (req.body || {});

    if (!block_id || !teacher_email) {
      return res.status(400).json({ error: 'block_id and teacher_email are required' });
    }

    // empty string is allowed? we’ll treat empty as null = unassigned
    const nextEmail = (student_email || '').trim() || null;

    // 1) Load the block and verify ownership
    const { data: block, error: bErr } = await supabase
      .from('teacher_blocks')
      .select('id, teacher_email')
      .eq('id', block_id)
      .maybeSingle();

    if (bErr || !block) {
      return res.status(404).json({ error: 'Block not found' });
    }
    if (block.teacher_email !== teacher_email) {
      return res.status(403).json({ error: 'Block belongs to a different teacher' });
    }

    // 2) Update only the student_email field
    const { data: updated, error: uErr } = await supabase
      .from('teacher_blocks')
      .update({ student_email: nextEmail })
      .eq('id', block_id)
      .select()
      .maybeSingle();

    if (uErr) {
      return res.status(500).json({ error: uErr.message });
    }

    return res.status(200).json({ ok: true, block: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
  });
};
