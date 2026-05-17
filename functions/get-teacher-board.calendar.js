const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.get('/get-teacher-board', async (req, res) => {
  // Only allow GET requests
const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Fetch availability ranges
    const { data: ranges, error: rErr } = await supabase
      .from('teacher_availability')
      .select('id, teacher_email, teacher_name, day_of_week, time_start, time_end, timezone');

    if (rErr) throw rErr;

    // Get unique emails
    const emails = Array.from(new Set((ranges || []).map(r => r.teacher_email).filter(Boolean)));
    const teachers = emails.map(email => ({ id: email, name: email }));

    // Get full names from user_roles
    let fullNames = {};
    if (emails.length) {
      const { data: urows } = await supabase
        .from('user_roles')
        .select('email, full_name')
        .in('email', emails);
      
      if (urows) {
        fullNames = Object.fromEntries(urows.map(r => [r.email, r.full_name || r.email]));
      }
    }

    // Get student statuses
    const { data: danh, error: sErr } = await supabase
      .from('danh_sach_hv')
      .select('email, status');

    // Get student schedules
    const { data: scheds, error: cErr } = await supabase
      .from('student_schedule')
      .select('id, student_email, day_of_week, time_local, teacher_email');

    return res.status(200).json({
        teachers: teachers || [],
        ranges: ranges || [],
        statuses: danh || [],
        schedules: scheds || [],
        fullNames: fullNames
      });

  } catch (error) {
    console.error('Error fetching teacher board:', error);
    return res.status(500).json({ error: error.message });
  }
  });
};
