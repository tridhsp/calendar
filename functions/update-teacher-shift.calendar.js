const { createClient } = require('@supabase/supabase-js');
// === tansinh teacher-role BEGIN (5 Oct 2026) ===
// Each free range is registered as one role. Unknown values are stored as null (= not set).
const TEACHER_ROLES = ['breakout', 'ttkb', 'supporter', 'mix'];
function normRole(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return TEACHER_ROLES.includes(s) ? s : null; }
// === tansinh teacher-role END ===

module.exports = function(app) {
  app.post('/update-teacher-shift', async (req, res) => {
const supabaseUrl = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);


  try {
    const { action, availId, timeStart, timeEnd, role } = (req.body || {}); // tansinh teacher-role

    if (!availId) {
      return res.status(400).json({ error: 'availId is required' });
    }

    if (action === 'update') {
      if (!timeStart || !timeEnd) {
        return res.status(400).json({ error: 'timeStart and timeEnd are required for update' });
      }

      const { error } = await supabase
        .from('teacher_availability')
        .update({ time_start: timeStart, time_end: timeEnd, ...(role !== undefined ? { role: normRole(role) } : {}) }) // tansinh teacher-role
        .eq('id', availId);

      if (error) throw error;

      return res.status(200).json({ success: true, action: 'updated' });

    } else if (action === 'delete') {
      const { error } = await supabase
        .from('teacher_availability')
        .delete()
        .eq('id', availId);

      if (error) throw error;

      return res.status(200).json({ success: true, action: 'deleted' });

    } else {
      return res.status(400).json({ error: 'Invalid action. Use "update" or "delete"' });
    }

  } catch (error) {
    console.error('Error updating teacher shift:', error);
    return res.status(500).json({ error: error.message });
  }
  });
};
