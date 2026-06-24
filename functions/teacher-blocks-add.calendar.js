// netlify/functions/teacher-blocks-add.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function timeToMin(t) {
  const [h = 0, m = 0] = String(t || '').split(':').map(Number);
  return h * 60 + m;
}
function minToTime(x) {
  const h = Math.floor(x / 60), m = x % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = function(app) {
  app.post('/teacher-blocks-add', async (req, res) => {
try {
    const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
   const { availability_id, teacher_email, day_of_week, start_time, minutes, student_email, userToken, is_temp_assignment, temp_weeks_remaining } = (req.body || {});

    if (!availability_id || !teacher_email || day_of_week == null || !start_time || !minutes || !student_email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

// Get creator's email from token
    let creatorEmail = null;
    if (userToken) {
      const { data: userData, error: userErr } = await supabase.auth.getUser(userToken);
      if (!userErr && userData?.user) {
        creatorEmail = userData.user.email || null;
      }
    }

    // 1) Validate availability
    const { data: avail, error: aErr } = await supabase
      .from('teacher_availability')
      .select('id, teacher_id, teacher_email, day_of_week, time_start, time_end')
      .eq('id', availability_id)
      .maybeSingle();

    if (aErr || !avail) {
      return res.status(404).json({ error: 'Availability not found' });
    }
    if (avail.teacher_email !== teacher_email) {
      return res.status(403).json({ error: 'Availability belongs to different teacher' });
    }
    if (Number(avail.day_of_week) !== Number(day_of_week)) {
      return res.status(400).json({ error: 'Day mismatch with availability' });
    }

    // 2) Validate time fits range
    const sMin = timeToMin(start_time);
    const eMin = sMin + Number(minutes);
    const aStart = timeToMin(avail.time_start);
    const aEnd = timeToMin(avail.time_end);
    if (sMin < aStart || eMin > aEnd) {
      return res.status(400).json({ error: 'Block must fit inside the availability range' });
    }

    const end_time = minToTime(eMin);

// 3) Insert block
    const insertRow = {
      teacher_id: avail.teacher_id,
      availability_id,
      day_of_week,
      start_time,
      end_time,
      student_email,
      teacher_email,
      created_by: creatorEmail,
      is_temp_assignment: is_temp_assignment || false,
      temp_weeks_remaining: temp_weeks_remaining || null,
      temp_start_date: is_temp_assignment ? new Date().toISOString().split('T')[0] : null
    };

    const { data: inserted, error: iErr } = await supabase
      .from('teacher_blocks')
      .insert([insertRow])
      .select()
      .maybeSingle();

    if (iErr) {
      return res.status(500).json({ error: iErr.message });
    }

    return res.status(200).json({ ok: true, block: inserted });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
  });
};
