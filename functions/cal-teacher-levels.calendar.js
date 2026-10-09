/* cal-teacher-levels.calendar.js — the levels a teacher may teach, for the Teacher Calendars cards  (9 Oct 2026)

   TWO ENDPOINTS, both behind a Supabase token, both ADMIN / SUPER ADMIN ONLY:
     GET  /cal-teacher-levels-list        { ok, role, canEdit:true, me,
                                            levels: [{ name, group, students }],   every level, grouped
                                            groups: [{ key, label, levels:[names] }],
                                            assignments: { "<teacher email>": [names] } }
     POST /cal-teacher-levels-save        body { teacherEmail, levels: [names] }
                                          REPLACES that teacher's set. Reply { ok, teacherEmail, levels, added, removed }.
   A Teacher gets 403 on both. The page then draws no badge at all — the badge is for admins only.

   THE TABLE IS THE ONE THE CALENDAR ALREADY CHECKS AGAINST: public.level_assignments, one row per
   (teacher_email, class_name). check-level-assignment.calendar.js reads it when a teacher is put on a
   student ("Level Mismatch" popup on calendar.tansinh.info); the levelassignment app writes it too.
   Nothing new is created here.

   WHERE THE LIST OF LEVELS COMES FROM: every distinct danh_sach_hv.cap_lop_hoc (the level every student
   has today) plus every class_name already given to any teacher. That is exactly the set the mismatch
   check compares against, so a level that appears here is one that can matter. A level no student has
   yet and no teacher holds does not appear. If the school ever keeps a dedicated table of levels, read
   it in levelNames() below — one function, nothing else changes.

   GROUPS follow the SAME rules as groupLevelsByCategory() in calendar's script.js (the mismatch popup),
   so a level sits under the same heading on both pages. The order and the English labels are this
   file's own; they match the picker on writing.tansinh.info.

   SAVE IS A DIFF, NOT A WIPE: rows to add are inserted, rows to drop are deleted, nothing else is
   touched. So a failed insert leaves the old set intact (there is no transaction in supabase-js).
   A name that is not in the known list is refused with 400 — the picker can only send known names,
   so a stranger cannot invent one.

   THE GATE IS WRITTEN HERE, NOT BORROWED, the same shape as cal-contracts.calendar.js: it depends on
   nothing but @supabase/supabase-js and the .env the server already loaded. It FAILS CLOSED:
   no token -> 401, wrong role -> 403, database unreachable -> 500 and refuse. Verified tokens are
   cached for 120 s and the cache EVICTS.

   LOGS one line per change: "[cal-levels] SAVED <email> n=<total> +<added> -<removed> by <who>".
   Nothing secret is ever printed.

   Loaded from server.js with:  require("./routes/cal-teacher-levels.calendar")(app);
   (patch-server-require-levels.py puts that line in, after cal-offhistory, before app.listen.)      */

module.exports = function (app) {
  const { createClient } = require('@supabase/supabase-js');

  const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const ROLES = ['Admin', 'Super Admin'];              // exact case, as in user_roles (like RECORD_ROLES)
  const TABLE = 'level_assignments';                  // teacher_email, class_name
  const STUDENTS = 'danh_sach_hv';                    // cap_lop_hoc = the student's level
  const CACHE_MS = 120 * 1000;
  const PAGE = 1000;                                  // PostgREST answers at most 1000 rows per request
  const MAX_LEVELS = 200;

  let sb = null;
  function db() {
    if (!sb) {
      if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
      sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    return sb;
  }

  /* ---------- the gate (same shape as cal-contracts) ---------- */
  const tokenCache = new Map();                      // token -> { who, exp }
  function evict() {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.exp <= now) tokenCache.delete(k);
    if (tokenCache.size > 500) tokenCache.clear();   // never grow for ever
  }
  async function roleOf(email) {
    const low = String(email || '').toLowerCase();
    let { data, error } = await db().from('user_roles').select('role').eq('email', email).limit(1);
    if (error) throw error;
    if (!data || !data.length) {
      ({ data, error } = await db().from('user_roles').select('role').eq('email', low).limit(1));
      if (error) throw error;
    }
    return data && data.length ? String(data[0].role || '') : '';
  }
  /* returns { email, role } or sends the refusal itself and returns null */
  async function gate(req, res) {
    try {
      const h = String(req.headers.authorization || '');
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (!token) { res.status(401).json({ error: 'Please sign in first.', signin: true }); return null; }
      evict();
      let who = tokenCache.get(token)?.who;
      if (!who) {
        const { data, error } = await db().auth.getUser(token);
        if (error || !data || !data.user || !data.user.email) {
          res.status(401).json({ error: 'Your session has expired. Please sign in again.', signin: true }); return null;
        }
        who = { email: data.user.email, role: await roleOf(data.user.email) };
        tokenCache.set(token, { who, exp: Date.now() + CACHE_MS });
      }
      if (!ROLES.includes(who.role)) {
        res.status(403).json({ error: 'Only an Admin can see or change level assignments.', role: who.role || null });
        return null;
      }
      return who;
    } catch (e) {
      console.error('[cal-levels] gate error:', e.message || e);
      res.status(500).json({ error: 'Could not check who you are. Try again.' });
      return null;
    }
  }

  /* ---------- the groups: the SAME rules as groupLevelsByCategory() in calendar's script.js ---------- */
  const GROUPS = [
    ['PRE-STARTERS', 'Pre-Starters'], ['STARTERS', 'Starters'], ['MOVERS', 'Movers'], ['FLYERS', 'Flyers'],
    ['KET', 'KET'], ['TEST PREP', 'Test Prep'], ['IELTS', 'IELTS'], ['B1', 'B1'], ['B2', 'B2'],
    ['INTERACTION', 'Interaction'], ['TIỂU HỌC', 'Tiểu Học'], ['THCS/THPT', 'THCS / THPT'],
    ['BUSINESS 1', 'Business 1'], ['BUSINESS 2', 'Business 2'], ['TOEIC', 'TOEIC'], ['OTHERS', 'Others']
  ];
  function groupOf(level) {
    const u = String(level).toUpperCase();
    if (u.includes('PRE_STARTERS') || u.includes('PRE-STARTERS')) return 'PRE-STARTERS';
    if (u.includes('STARTERS')) return 'STARTERS';
    if (u.includes('MOVERS')) return 'MOVERS';
    if (u.includes('FLYERS')) return 'FLYERS';
    if (u.includes('KET')) return 'KET';
    if (u.startsWith('B1') || u === 'B1A' || u === 'B1B') return 'B1';
    if (u.startsWith('B2') || u === 'B2A' || u === 'B2B') return 'B2';
    if (u.includes('IELTS')) return 'IELTS';
    if (u.includes('TEST_PREP') || u.includes('TEST-PREP')) return 'TEST PREP';
    if (u.includes('INTERACTION')) return 'INTERACTION';
    if (u.includes('TIEU_HOC') || u.includes('TIEU-HOC') || u.includes('TIỂU')) return 'TIỂU HỌC';
    if (u.includes('THCS') || u.includes('THPT')) return 'THCS/THPT';
    if (u.includes('BUSINESS1') || u === 'BUSINESS1A' || u === 'BUSINESS1B') return 'BUSINESS 1';
    if (u.includes('BUSINESS2') || u === 'BUSINESS2A' || u === 'BUSINESS2B') return 'BUSINESS 2';
    if (u.includes('TOEIC')) return 'TOEIC';
    return 'OTHERS';
  }
  /* "IELTS_6.0" sorts after "IELTS_5.5": compare the number inside the name when both have one */
  function levelSort(a, b) {
    const na = /(\d+(?:\.\d+)?)/.exec(a), nb = /(\d+(?:\.\d+)?)/.exec(b);
    if (na && nb && a.slice(0, na.index) === b.slice(0, nb.index)) {
      const d = parseFloat(na[1]) - parseFloat(nb[1]); if (d) return d;
    }
    return a.localeCompare(b, 'vi');
  }

  /* ---------- reading ---------- */
  async function allRows(table, cols) {                      // every row, 1000 at a time
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db().from(table).select(cols).range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
      if (from > 50 * PAGE) break;                             // belt and braces
    }
    return out;
  }
  const clean = (s) => String(s == null ? '' : s).trim();
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')) && String(s).length <= 254;

  /* the known levels, with how many students sit at each; plus every assignment row */
  async function levelNames() {
    const students = await allRows(STUDENTS, 'cap_lop_hoc');
    const count = new Map();
    for (const r of students) { const n = clean(r.cap_lop_hoc); if (n) count.set(n, (count.get(n) || 0) + 1); }
    const rows = await allRows(TABLE, 'teacher_email,class_name');
    for (const r of rows) { const n = clean(r.class_name); if (n && !count.has(n)) count.set(n, 0); }
    const levels = [...count.keys()].sort(levelSort).map(name => ({ name, group: groupOf(name), students: count.get(name) }));
    return { levels, rows };
  }
  function groupList(levels) {
    const by = new Map(GROUPS.map(([k]) => [k, []]));
    for (const l of levels) by.get(l.group).push(l.name);
    return GROUPS.filter(([k]) => by.get(k).length).map(([key, label]) => ({ key, label, levels: by.get(key) }));
  }

  /* ---------- GET /cal-teacher-levels-list ---------- */
  app.get('/cal-teacher-levels-list', async (req, res) => {
    const who = await gate(req, res); if (!who) return;
    try {
      const { levels, rows } = await levelNames();
      const assignments = {};
      for (const r of rows) {
        const e = clean(r.teacher_email).toLowerCase(), n = clean(r.class_name);
        if (!e || !n) continue;
        (assignments[e] = assignments[e] || []).push(n);
      }
      for (const e of Object.keys(assignments)) assignments[e] = [...new Set(assignments[e])].sort(levelSort);
      res.json({ ok: true, role: who.role, canEdit: true, me: who.email, levels, groups: groupList(levels), assignments });
    } catch (e) {
      console.error('[cal-levels] list failed:', e.message || e);
      res.status(500).json({ error: 'Could not load the level assignments.' });
    }
  });

  /* ---------- POST /cal-teacher-levels-save ---------- */
  app.post('/cal-teacher-levels-save', async (req, res) => {
    const who = await gate(req, res); if (!who) return;
    try {
      const b = req.body || {};
      const email = clean(b.teacherEmail).toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ error: 'teacherEmail is not an email address.' });
      if (!Array.isArray(b.levels)) return res.status(400).json({ error: 'levels must be a list.' });
      if (b.levels.length > MAX_LEVELS) return res.status(400).json({ error: `At most ${MAX_LEVELS} levels.` });

      const { levels, rows } = await levelNames();
      const known = new Set(levels.map(l => l.name));
      const wanted = new Set();
      for (const x of b.levels) {
        const n = clean(x);
        if (!n) continue;
        if (!known.has(n)) return res.status(400).json({ error: `Unknown level: "${n.slice(0, 60)}". Reload the page and try again.` });
        wanted.add(n);
      }

      // this teacher's rows, matched on the email in ANY case; keep the casing the rows already use
      const mine = rows.filter(r => clean(r.teacher_email).toLowerCase() === email);
      const storedAs = mine.length ? clean(mine[0].teacher_email) : email;
      const have = new Set(mine.map(r => clean(r.class_name)).filter(Boolean));
      const toAdd = [...wanted].filter(n => !have.has(n));
      const toDrop = [...have].filter(n => !wanted.has(n));

      if (toAdd.length) {
        const { error } = await db().from(TABLE).insert(toAdd.map(n => ({ teacher_email: storedAs, class_name: n })));
        if (error) throw error;                                 // nothing was removed yet: the old set is intact
      }
      if (toDrop.length) {
        const spellings = [...new Set(mine.map(r => clean(r.teacher_email)))];      // exact matches only: no ilike, no wildcards
        const { error } = await db().from(TABLE).delete().in('teacher_email', spellings).in('class_name', toDrop);
        if (error) throw error;
      }
      const after = [...wanted].sort(levelSort);
      console.log(`[cal-levels] SAVED ${email} n=${after.length} +${toAdd.length} -${toDrop.length} by ${who.email}`);
      res.json({ ok: true, teacherEmail: email, levels: after, added: toAdd.length, removed: toDrop.length });
    } catch (e) {
      console.error('[cal-levels] save failed:', e.message || e);
      res.status(500).json({ error: 'Could not save: ' + String(e.message || e).slice(0, 160) });
    }
  });
};
