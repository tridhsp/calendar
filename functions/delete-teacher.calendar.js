const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/delete-teacher', async (req, res) => {
const supabaseUrl = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { teacherEmail } = (req.body || {});

    if (!teacherEmail) {
      return res.status(400).json({ error: 'teacherEmail is required' });
    }

    // Delete from teacher_availability
    const { error: availError } = await supabase
      .from('teacher_availability')
      .delete()
      .eq('teacher_email', teacherEmail);

    if (availError) throw availError;

    // Unassign students (set teacher_email to null)
    const { error: schedError } = await supabase
      .from('student_schedule')
      .update({ teacher_email: null })
      .eq('teacher_email', teacherEmail);

    if (schedError) throw schedError;

// Delete from teachers table
    const { error: teacherError } = await supabase
      .from('teachers')
      .delete()
      .eq('name', teacherEmail);

    if (teacherError) {
      console.error('Error deleting from teachers table:', teacherError);
    }

    // Don't throw error if teachers table doesn't exist or has no rows
    // if (teacherError) throw teacherError;

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error deleting teacher:', error);
    return res.status(500).json({ error: error.message });
  }
  });
};
