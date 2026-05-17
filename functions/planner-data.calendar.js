// netlify/functions/planner-data.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};



module.exports = function(app) {
  app.post('/planner-data', async (req, res) => {
try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { teacher_email } = (req.body || {});
    if (!teacher_email) {
      return res.status(400).json({ error: 'teacher_email is required' });
    }

    // 1) availability ranges
    const { data: ranges, error: rErr } = await supabase
      .from('teacher_availability')
      .select('id, day_of_week, time_start, time_end, timezone, teacher_id, teacher_email')
      .eq('teacher_email', teacher_email);

    if (rErr) {
      return res.status(500).json({ error: rErr.message });
    }

// 2) blocks (include temp assignment fields)
    const { data: allBlocks, error: bErr } = await supabase
      .from('teacher_blocks')
      .select('id, availability_id, day_of_week, start_time, end_time, student_email, teacher_email, student_id, is_temp_assignment, temp_weeks_remaining, temp_start_date')
      .eq('teacher_email', teacher_email);

    if (bErr) {
      return res.status(500).json({ error: bErr.message });
    }

    // Find and delete expired temp assignments
    const today = new Date();
    const expiredIds = [];
    const blocks = [];

    for (const b of (allBlocks || [])) {
      // If not a temp assignment, always keep
      if (!b.is_temp_assignment) {
        blocks.push(b);
        continue;
      }
      
      // If temp assignment but no start date or weeks, keep it (fallback)
      if (!b.temp_start_date || !b.temp_weeks_remaining) {
        blocks.push(b);
        continue;
      }
      
      // Calculate weeks passed since temp_start_date
      const startDate = new Date(b.temp_start_date);
      const diffTime = today - startDate;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      const weeksPassed = Math.floor(diffDays / 7);
      
      // Check if expired
      if (weeksPassed >= b.temp_weeks_remaining) {
        // Mark for deletion
        expiredIds.push(b.id);
      } else {
        // Keep this block
        blocks.push(b);
      }
    }

// Delete expired blocks from database (extra safety: only delete temp assignments)
    if (expiredIds.length > 0) {
      const { error: delErr } = await supabase
        .from('teacher_blocks')
        .delete()
        .in('id', expiredIds)
        .eq('is_temp_assignment', true);
      
      if (delErr) {
        console.warn('Failed to delete expired temp blocks:', delErr.message);
        // Don't fail the whole request, just log the warning
      }
    }

    // 3) assigned students for the day
    const { data: assigned, error: aErr } = await supabase
      .from('student_schedule')
      .select('student_email, day_of_week')
      .eq('teacher_email', teacher_email)
      .not('student_email', 'is', null);

    if (aErr) {
      return res.status(500).json({ error: aErr.message });
    }

    // 4) names map: emails seen in blocks + assigned
    const emailsFromBlocks = (blocks || []).map(b => b.student_email).filter(Boolean);
    const emailsFromAssigned = (assigned || []).map(a => a.student_email).filter(Boolean);
    const allEmails = Array.from(new Set([...emailsFromBlocks, ...emailsFromAssigned]));

    let names = [];
    if (allEmails.length) {
      const { data: nameRows, error: nErr } = await supabase
        .from('user_roles')
        .select('email, full_name')
        .in('email', allEmails);

      if (nErr) {
        return res.status(500).json({ error: nErr.message });
      }
      names = nameRows || [];
    }

    return res.status(200).json({ ranges, blocks, assigned, names });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
  });
};
