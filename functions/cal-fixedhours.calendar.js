/* cal-fixedhours.calendar.js — fixed hours PER BLOCK for the Teacher Calendars page  (8 Oct 2026)

   One row per fixed range in public.teacher_fixed_hours:
       teacher_email · day_of_week (0 = Sun .. 6 = Sat, same as teacher_availability) · time_start · time_end
   Keyed by TIME, never by an availability row id: save-teacher-schedule re-creates those rows on every
   edit, so an id would go stale the first time a teacher changed their hours. A fixed range survives a
   re-cut of the blocks as long as it still falls inside one; the page ignores a range that falls outside
   every block, and drops it on the next save.

   GET  /cal-fixed-ranges-list                 any signed-in user. { ranges: [...every teacher's rows...] }
   POST /cal-fixed-ranges-save                 Admin or Super Admin only.
        body { teacherEmail, ranges: [{ day: 0-6, start: "HH:MM", end: "HH:MM" }, ...] }
        REPLACES that teacher's whole set (an empty list clears it). Overlapping or touching ranges of
        one day are merged before they are written. Reply { ok, teacherEmail, ranges: [rows] }.
   Both need a Supabase token in "Authorization: Bearer ...", exactly like cal-contracts-list.

   The old per-teacher flag (teacher_flags.fixed_hours, route cal-fixed-hours-set) is NOT touched here:
   the page calls that route itself after a save, so the flag reads true while at least one range exists.

   Logs:  [cal-fixed] SAVED n range(s) for <teacher> by <admin>      [cal-fixed] REFUSED ...
   Needs in .env: SUPABASE_URL (or SUPABASE_INTERNAL_URL) and SUPABASE_SERVICE_KEY. Nothing new.      */
const { createClient } = require('@supabase/supabase-js');

const TABLE = 'teacher_fixed_hours';
const EDIT_ROLES = ['Admin', 'Super Admin'];                         // exact case, as in user_roles
const MAX_RANGES = 60;

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
  let transport; try { transport = require('ws'); } catch (e) { transport = undefined; }     // the house pattern for node clients
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: transport ? { transport } : undefined });
  return _sb;
}

/* who is calling: { email, role } or null. The token is verified by Supabase itself. */
async function who(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')); if (!m) return null;
  const { data, error } = await sb().auth.getUser(m[1]);
  if (error || !data || !data.user || !data.user.email) return null;
  const email = String(data.user.email).toLowerCase();
  const { data: ur } = await sb().from('user_roles').select('role').ilike('email', email).limit(1).maybeSingle();
  return { email, role: ur && ur.role ? String(ur.role) : '' };
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hm) => { const m = HM.exec(String(hm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const hm = (t) => String(t || '').slice(0, 5);                      // "18:00:00" -> "18:00"

/* validate and merge the posted ranges -> [{day, s, e}] or a string explaining what is wrong */
function clean(list) {
  if (!Array.isArray(list)) return 'ranges must be a list';
  if (list.length > MAX_RANGES) return `too many ranges (${list.length}, max ${MAX_RANGES})`;
  const out = [];
  for (const r of list) {
    const day = Number(r && r.day), s = toMin(r && r.start), e = toMin(r && r.end);
    if (!Number.isInteger(day) || day < 0 || day > 6) return `bad day: ${r && r.day}`;
    if (isNaN(s) || isNaN(e)) return `bad time in ${JSON.stringify(r)} (want HH:MM)`;
    if (e <= s) return `end must be after start: ${r.start}-${r.end}`;
    out.push({ day, s, e });
  }
  out.sort((a, b) => a.day - b.day || a.s - b.s);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.day === r.day && r.s <= last.e) last.e = Math.max(last.e, r.e); else merged.push({ ...r });
  }
  return merged;
}

module.exports = function (app) {

  app.get('/cal-fixed-ranges-list', async (req, res) => {
    try {
      const me = await who(req);
      if (!me) return res.status(401).json({ error: 'Please sign in first.' });
      const { data, error } = await sb().from(TABLE)
        .select('teacher_email, day_of_week, time_start, time_end')
        .order('teacher_email').order('day_of_week').order('time_start');
      if (error) throw error;
      res.json({ ranges: (data || []).map(r => ({ teacher_email: String(r.teacher_email).toLowerCase(), day_of_week: r.day_of_week, time_start: hm(r.time_start), time_end: hm(r.time_end) })) });
    } catch (e) {
      console.error('[cal-fixed] list failed:', e.message || e);
      res.status(500).json({ error: 'Could not read the fixed hours.' });
    }
  });

  app.post('/cal-fixed-ranges-save', async (req, res) => {
    try {
      const me = await who(req);
      if (!me) return res.status(401).json({ error: 'Please sign in first.' });
      if (!EDIT_ROLES.includes(me.role)) {
        console.log(`[cal-fixed] REFUSED save by ${me.email} (${me.role || 'no role'})`);
        return res.status(403).json({ error: 'Only an Admin can change fixed hours.' });
      }
      const teacherEmail = String((req.body && req.body.teacherEmail) || '').trim().toLowerCase();
      if (!teacherEmail || !teacherEmail.includes('@')) return res.status(400).json({ error: 'teacherEmail is missing.' });
      const ranges = clean(req.body && req.body.ranges);
      if (typeof ranges === 'string') return res.status(400).json({ error: ranges });

      const rows = ranges.map(r => ({ teacher_email: teacherEmail, day_of_week: r.day, time_start: fmt(r.s), time_end: fmt(r.e), updated_by: me.email }));
      const del = await sb().from(TABLE).delete().eq('teacher_email', teacherEmail);
      if (del.error) throw del.error;
      let saved = [];
      if (rows.length) {
        const ins = await sb().from(TABLE).insert(rows).select('teacher_email, day_of_week, time_start, time_end');
        if (ins.error) throw ins.error;
        saved = ins.data || [];
      }
      console.log(`[cal-fixed] SAVED ${saved.length} range(s) for ${teacherEmail} by ${me.email}: ${saved.map(r => `${r.day_of_week} ${hm(r.time_start)}-${hm(r.time_end)}`).join(', ') || '(none)'}`);
      res.json({ ok: true, teacherEmail, ranges: saved.map(r => ({ teacher_email: teacherEmail, day_of_week: r.day_of_week, time_start: hm(r.time_start), time_end: hm(r.time_end) })) });
    } catch (e) {
      console.error('[cal-fixed] save failed:', e.message || e);
      res.status(500).json({ error: 'Save failed: ' + (e.message || 'unknown error') });
    }
  });
};
