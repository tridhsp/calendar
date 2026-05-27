const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/teacher-blocks-delete', async (req, res) => {
  // Only allow POST
try {
    const { block_id, teacher_email } = (req.body || {});

    // Validate inputs
    if (!block_id || !teacher_email) {
      return res.status(400).json({ error: 'Missing block_id or teacher_email' });
    }

    // Create Supabase client
    const supabase = createClient(
      (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL),
      process.env.SUPABASE_SERVICE_KEY
    );

    // Verify the block belongs to this teacher before deleting
    const { data: existing, error: fetchError } = await supabase
      .from('teacher_blocks')
      .select('id')
      .eq('id', block_id)
      .eq('teacher_email', teacher_email)
      .single();

    if (fetchError || !existing) {
      return res.status(403).json({ error: 'Block not found or unauthorized' });
    }

    // Delete the block
    const { error: deleteError } = await supabase
      .from('teacher_blocks')
      .delete()
      .eq('id', block_id);

    if (deleteError) {
      console.error('Delete error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete block' });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Function error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  });
};
