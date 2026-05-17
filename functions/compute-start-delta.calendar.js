// Converted from netlify/functions/compute-start-delta.js (ESM -> CJS)
const { createClient } = require('@supabase/supabase-js');

// Normalize "8", "8:00", "8:00 am", "08:00", "08:00:30" -> "HH:MM" (24h) or null
function normalizeHHMM(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase().replace(/\./g, ':');
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  let min = parseInt(m[2] ?? '0', 10);
  const ap = m[4];

  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;

  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function formatHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

module.exports = function(app) {
  app.post('/compute-start-delta', async (req, res) => {
    try {
      // Verify user
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;

      if (!SUPABASE_URL || !SERVICE_ROLE) {
        return res.status(500).json({ error: 'Missing server env vars' });
      }
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

      const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
      const { data: authUser, error: authErr } = await admin.auth.getUser(token);
      if (authErr || !authUser?.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Input
      const body = req.body || {};
      const startIso = String(body.start_time_iso || '').trim();
      const scheduleTimes = Array.isArray(body.schedule_times) ? body.schedule_times : [];
      const tz = String(body.tz || 'Asia/Bangkok');

      if (!startIso) {
        return res.status(400).json({ error: 'start_time_iso required' });
      }

      // Pick earliest "HH:MM" from provided scheduleTimes
      const normalized = scheduleTimes
        .map(normalizeHHMM)
        .filter(Boolean);

      // If no schedule times provided, treat as On time
      if (!normalized.length) {
        const data = { label: 'On time', hhmmss: '00:00:00', early_start: null, late_start: null };
        return res.status(200).json({ data });
      }

      const toMinutes = (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
      };
      const earliest = normalized.reduce((best, cur) => (toMinutes(cur) < toMinutes(best) ? cur : best), normalized[0]);

      // Get the YYYY-MM-DD for the start time in Bangkok (no DST there)
      const ymdBangkok = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(startIso)); // "YYYY-MM-DD"

      // Build schedule timestamp (Bangkok local clock -> absolute instant)
      // Bangkok is always +07:00
      const schedMs = new Date(`${ymdBangkok}T${earliest}:00+07:00`).getTime();
      const actualMs = new Date(startIso).getTime();

      const deltaMs = actualMs - schedMs; // >0 late, <0 early
      let label = 'On time';
      let hhmmss = '00:00:00';
      let early = null;
      let late = null;

      if (Math.abs(deltaMs) <= 999) {
        label = 'On time';
        hhmmss = '00:00:00';
      } else if (deltaMs < 0) {
        label = 'Early';
        hhmmss = formatHMS(Math.abs(deltaMs));
        early = hhmmss;
      } else {
        label = 'Late';
        hhmmss = formatHMS(deltaMs);
        late = hhmmss;
      }

      const data = { label, hhmmss, early_start: early, late_start: late };
      return res.status(200).json({ data });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Server error' });
    }
  });
};
