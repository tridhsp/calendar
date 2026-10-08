/* cal-offhistory.calendar.js — teacher absences, joined with their FIXED hours  (8 Oct 2026)

   Feeds two things on teachers.tansinh.info (teachercalendar.html, module teachercontract.js):
     - the line "Có GV xin nghỉ hôm nay" at the top of the board, and a chip on the teacher's card
     - the sidebar page "Lịch sử nghỉ": every absence per teacher, with the ones that fall on fixed
       hours marked, and a count per teacher (who reports off often, who never does)

   WHERE AN ABSENCE COMES FROM (the offday.tansinh.info app):
     offdays           one row per run of dates: person_type 'teacher', person_email, off_from, off_to,
                       created_by, created_at. Written by POST /offdays-crud.
     meeting_offdays   one row per SHIFT the admin ticked in the shift picker: teacher_email, off_date,
                       start_time, end_time, meeting_content_id. Written by POST /sync-meeting-offdays.
     A date can have shifts (partial day) or none (the whole day is off). Both tables are read with
     select('*') so a column this file does not know about can never break the read.

   THE FIXED RULE:  fixed hours live in teacher_fixed_hours (teacher_email, day_of_week 0 = Sun, time_start,
     time_end). An absence HITS the fixed hours when one of its shifts overlaps a fixed range on that weekday;
     a whole-day absence hits when that weekday has any fixed range at all. Nothing is stored: it is
     computed on every call against the CURRENT fixed hours (so history reflects today's rule, not the
     rule on the day — good enough for "who keeps their fixed hours", and no table, no cron).

   GET /cal-offday-history?from=YYYY-MM-DD&to=YYYY-MM-DD     (defaults: 90 days back, 60 days ahead; max 400)
     Admin / Super Admin: every teacher.  Teacher: only their own rows.  Any other role: 403.
     -> { from, to, today, canSeeAll,
          entries:  [{ email, name, date, dow, whole, shifts: [{start, end, mcid}], fixed: [{start, end}],
                       hit, created_by, created_at }]            one per teacher per date, newest first
          teachers: [{ email, name, days, hits, last, whole }] }  one per teacher, most days first

   Today is VIETNAM's today (UTC+7), whatever the box's zone. Times are "HH:MM".
   Needs in .env: SUPABASE_URL (or SUPABASE_INTERNAL_URL) and SUPABASE_SERVICE_KEY. Nothing new.      */
const { createClient } = require('@supabase/supabase-js');

const SEE_ALL = ['Admin', 'Super Admin'];
const SEE_OWN = ['Teacher'];
const MAX_DAYS = 400;

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
  let transport; try { transport = require('ws'); } catch (e) { transport = undefined; }
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: transport ? { transport } : undefined });
  return _sb;
}
async function who(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')); if (!m) return null;
  const { data, error } = await sb().auth.getUser(m[1]);
  if (error || !data || !data.user || !data.user.email) return null;
  const email = String(data.user.email).toLowerCase();
  const { data: ur } = await sb().from('user_roles').select('role').ilike('email', email).limit(1).maybeSingle();
  return { email, role: ur && ur.role ? String(ur.role) : '' };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const vnToday = () => ymd(new Date(Date.now() + 7 * 3600 * 1000));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dowOf = (s) => new Date(s + 'T00:00:00Z').getUTCDay();                 // 0 = Sunday, like teacher_availability
const hm = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? `${pad(m[1])}:${m[2]}` : ''; };
const toMin = (t) => { const s = hm(t); return s ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) : NaN; };
const overlap = (a, b, c, d) => a < d && c < b;
const lower = (s) => String(s || '').trim().toLowerCase();

module.exports = function (app) {
  app.get('/cal-offday-history', async (req, res) => {
    try {
      const me = await who(req);
      if (!me) return res.status(401).json({ error: 'Please sign in first.' });
      const canSeeAll = SEE_ALL.includes(me.role);
      if (!canSeeAll && !SEE_OWN.includes(me.role)) return res.status(403).json({ error: 'No access.' });

      const today = vnToday();
      let from = isYmd(req.query.from) ? req.query.from : addDays(today, -90);
      let to = isYmd(req.query.to) ? req.query.to : addDays(today, 60);
      if (to < from) [from, to] = [to, from];
      if ((new Date(to) - new Date(from)) / 86400000 > MAX_DAYS) from = addDays(to, -MAX_DAYS);

      // 1. the three tables. offdays: any run of dates that touches the window. meeting_offdays: dates in the window.
      let q1 = sb().from('offdays').select('*').eq('person_type', 'teacher').lte('off_from', to).gte('off_to', from);
      let q2 = sb().from('meeting_offdays').select('*').gte('off_date', from).lte('off_date', to);
      let q3 = sb().from('teacher_fixed_hours').select('teacher_email, day_of_week, time_start, time_end');
      if (!canSeeAll) { q1 = q1.ilike('person_email', me.email); q2 = q2.ilike('teacher_email', me.email); q3 = q3.ilike('teacher_email', me.email); }
      const [r1, r2, r3] = await Promise.all([q1, q2, q3]);
      for (const r of [r1, r2, r3]) if (r.error) throw r.error;

      // 2. fixed ranges per teacher per weekday
      const fixed = new Map();                                                   // email -> dow -> [{s, e, start, end}]
      for (const r of (r3.data || [])) {
        const email = lower(r.teacher_email), s = toMin(r.time_start), e = toMin(r.time_end), dow = Number(r.day_of_week);
        if (!email || isNaN(s) || isNaN(e) || e <= s) continue;
        if (!fixed.has(email)) fixed.set(email, new Map());
        const byDow = fixed.get(email); if (!byDow.has(dow)) byDow.set(dow, []);
        byDow.get(dow).push({ s, e, start: hm(r.time_start), end: hm(r.time_end) });
      }
      const fixedOn = (email, date) => (fixed.get(email) || new Map()).get(dowOf(date)) || [];

      // 3. one entry per teacher per date: the offdays runs expanded day by day, then the shifts laid on top
      const entries = new Map();                                                 // key email|date
      const entryOf = (email, date) => {
        const k = `${email}|${date}`;
        if (!entries.has(k)) entries.set(k, { email, name: '', date, dow: dowOf(date), whole: true, shifts: [], fixed: fixedOn(email, date).map(f => ({ start: f.start, end: f.end })), hit: false, created_by: null, created_at: null, ids: [] });
        return entries.get(k);
      };
      for (const r of (r1.data || [])) {
        const email = lower(r.person_email); if (!email) continue;
        const a = String(r.off_from || '').slice(0, 10), b = String(r.off_to || r.off_from || '').slice(0, 10);
        if (!isYmd(a) || !isYmd(b)) continue;
        for (let d = a < from ? from : a; d <= b && d <= to; d = addDays(d, 1)) {
          const en = entryOf(email, d);
          if (r.created_by && !en.created_by) en.created_by = r.created_by;
          if (r.created_at && !en.created_at) en.created_at = r.created_at;
          if (r.id != null) en.ids.push(r.id);
        }
      }
      for (const r of (r2.data || [])) {
        const email = lower(r.teacher_email), d = String(r.off_date || '').slice(0, 10);
        if (!email || !isYmd(d)) continue;
        const en = entryOf(email, d);
        const start = hm(r.start_time), end = hm(r.end_time);
        if (start && end && !en.shifts.some(x => x.start === start && x.end === end)) en.shifts.push({ start, end, mcid: r.meeting_content_id ?? null });
        en.whole = false;
        if (r.created_at && !en.created_at) en.created_at = r.created_at;
      }
      // 4. the rule
      for (const en of entries.values()) {
        en.shifts.sort((x, y) => x.start.localeCompare(y.start));
        const fx = fixedOn(en.email, en.date);
        en.hit = en.whole ? fx.length > 0
          : en.shifts.some(sh => fx.some(f => overlap(toMin(sh.start), toMin(sh.end), f.s, f.e)));
      }
      // 5. names, from user_roles
      const emails = [...new Set([...entries.values()].map(e => e.email))];
      const names = new Map();
      if (emails.length) {
        const { data: ur } = await sb().from('user_roles').select('email, full_name').in('email', emails);
        for (const u of (ur || [])) if (u.email && u.full_name) names.set(lower(u.email), String(u.full_name));
      }
      const list = [...entries.values()].map(e => ({ ...e, name: names.get(e.email) || e.email.replace(/@.*$/, '') }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'vi'));
      // 6. per teacher
      const per = new Map();
      for (const e of list) {
        if (!per.has(e.email)) per.set(e.email, { email: e.email, name: e.name, days: 0, hits: 0, whole: 0, last: '' });
        const t = per.get(e.email); t.days++; if (e.hit) t.hits++; if (e.whole) t.whole++; if (e.date > t.last) t.last = e.date;
      }
      const teachers = [...per.values()].sort((a, b) => b.days - a.days || b.hits - a.hits || a.name.localeCompare(b.name, 'vi'));
      res.json({ from, to, today, canSeeAll, entries: list, teachers });
    } catch (e) {
      console.error('[cal-offhistory] failed:', e.message || e);
      res.status(500).json({ error: 'Could not read the absences: ' + (e.message || 'unknown error') });
    }
  });
};
