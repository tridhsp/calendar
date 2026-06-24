// netlify/functions/teacher-blocks-update.js
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
  app.post('/teacher-blocks-update', async (req, res) => {
try {
    const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
    const { block_id, teacher_email, start_time, minutes } = (req.body || {});

    if (!block_id || !teacher_email || !start_time || !minutes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1) Load the block
    const { data: block, error: bErr } = await supabase
      .from('teacher_blocks')
      .select('id, availability_id, day_of_week, start_time, end_time, teacher_email')
      .eq('id', block_id)
      .maybeSingle();

    if (bErr || !block) {
      return res.status(404).json({ error: 'Block not found' });
    }
    if (block.teacher_email !== teacher_email) {
      return res.status(403).json({ error: 'Block belongs to a different teacher' });
    }

    // 2) Load availability row to enforce window + day
    const { data: avail, error: aErr } = await supabase
      .from('teacher_availability')
      .select('id, day_of_week, time_start, time_end, teacher_email')
      .eq('id', block.availability_id)
      .maybeSingle();

    if (aErr || !avail) {
      return res.status(404).json({ error: 'Availability not found for this block' });
    }
    if (avail.teacher_email !== teacher_email) {
      return res.status(403).json({ error: 'Availability belongs to a different teacher' });
    }
    if (Number(avail.day_of_week) !== Number(block.day_of_week)) {
      return res.status(400).json({ error: 'Day mismatch with availability' });
    }

    // 3) Validate new time inside availability window
    const sMin = timeToMin(start_time);
    const eMin = sMin + Number(minutes);
    const aStart = timeToMin(avail.time_start);
    const aEnd = timeToMin(avail.time_end);
    if (sMin < aStart || eMin > aEnd) {
      return res.status(400).json({ error: 'New time is outside availability window' });
    }
    const end_time = minToTime(eMin);

    // 4) Overlap check: same teacher + day, excluding this block
    const { data: others, error: oErr } = await supabase
      .from('teacher_blocks')
      .select('id, start_time, end_time')
      .eq('teacher_email', teacher_email)
      .eq('day_of_week', block.day_of_week)
      .neq('id', block_id);

    if (oErr) {
      return res.status(500).json({ error: oErr.message });
    }

    const overlaps = (others || []).some((row) => {
      const os = timeToMin(row.start_time);
      const oe = timeToMin(row.end_time);
      // overlap if not (end <= os || oe <= start)
      return !(eMin <= os || oe <= sMin);
    });
    if (overlaps) {
      return res.status(400).json({ error: 'Time overlaps another block' });
    }

    // 5) Update
    const { data: updated, error: uErr } = await supabase
      .from('teacher_blocks')
      .update({ start_time, end_time })
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
