// cal-student-quota.calendar.js
// Returns a student's required MAIN / EXTRA weekly session counts from danh_sach_hv.
// Used by the Calendar app to validate a schedule BEFORE it is saved.
//
// No Authorization header required — this matches the sibling Calendar endpoints
// (e.g. cal-search-students, save-student-schedule) which are called with no token.
// It is protected by being behind the app login + Cloudflare, and it only ever
// returns two harmless numbers. It reads the DB with the service key, same as the
// documented VM 102 pattern.

const { createClient } = require('@supabase/supabase-js');

module.exports = function (app) {
  // One client, reused across requests (fast private path when available).
  const supabase = createClient(
    (process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL),
    process.env.SUPABASE_SERVICE_KEY,
    { realtime: { transport: require('ws') } }
  );

  app.post('/cal-student-quota', async (req, res) => {
    try {
      const email = (req.body && req.body.email ? String(req.body.email) : '').trim();
      if (!email) {
        return res.status(400).json({ ok: false, error: 'Missing email' });
      }

      const { data, error } = await supabase
        .from('danh_sach_hv')
        .select('email, buoi_hoc_chinh, buoi_hoc_phu')
        .eq('email', email)
        .limit(1);

      if (error) throw error;

      // Student not found in danh_sach_hv at all.
      if (!data || data.length === 0) {
        return res.json({ ok: true, found: false, main: null, extra: null });
      }

      const row = data[0];
      // Treat null / undefined / '' as "not set". Everything else -> a number.
      const norm = (v) =>
        (v === null || v === undefined || String(v).trim() === '') ? null : Number(v);

      return res.json({
        ok: true,
        found: true,
        main: norm(row.buoi_hoc_chinh),
        extra: norm(row.buoi_hoc_phu)
      });
    } catch (e) {
      console.error('[cal-student-quota] error:', (e && e.message) ? e.message : e);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });
};
