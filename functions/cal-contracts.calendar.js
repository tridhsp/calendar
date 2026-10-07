/* cal-contracts.calendar.js — contract dates for the teacher cards on calendar.tansinh.info  (7 Oct 2026)

   THREE ENDPOINTS, all behind a Supabase token:
     GET  /cal-contracts-list              every contract (Admin, Super Admin) or only your own (Teacher)
     POST /cal-contract-save               { teacherEmail, startDate, endDate, extension, extensionMonths, note }
     POST /cal-contract-delete             { teacherEmail }

   WHO MAY DO WHAT
     read   Teacher, Admin, Super Admin   (a Teacher gets ONLY the row for their own email)
     write  Admin, Super Admin
   The role comes from user_roles, by the email of the signed-in user. The three
   role strings are case-sensitive, exactly like RECORD_ROLES in the meeting gate.

   THE GATE IS WRITTEN HERE, NOT BORROWED, so this file depends on nothing but
   @supabase/supabase-js and the .env the server already loaded. It FAILS CLOSED:
   no token -> 401, unknown role -> 403, database unreachable -> 500 and refuse.
   Verified tokens are cached for 120 s and the cache EVICTS (unlike mtx-api's).

   TABLE: public.teacher_contracts (01-teacher-contracts.sql). RLS on, no policies,
   so only this server (service key) reads or writes it.

   LOGS one line per change: "[cal-contract] SAVED <email> <start>..<end> ext=<x> by <who>"
   and "[cal-contract] DELETED <email> by <who>". Nothing secret is ever printed.

   Loaded from server.js with:  require("./routes/cal-contracts.calendar")(app);
   (patch-server-require-contracts.py puts that line in, before app.listen).      */

module.exports = function (app) {
  const { createClient } = require('@supabase/supabase-js');

  const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const READ_ROLES = ['Teacher', 'Admin', 'Super Admin'];
  const WRITE_ROLES = ['Admin', 'Super Admin'];
  const EXT = ['yes', 'no', 'discuss'];
  const TABLE = 'teacher_contracts';
  const CACHE_MS = 120 * 1000;

  let sb = null;
  function db() {
    if (!sb) {
      if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
      sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    return sb;
  }

  /* ---------- the gate ---------- */
  const tokenCache = new Map();                      // token -> { who, exp }
  function evict() {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.exp <= now) tokenCache.delete(k);
    if (tokenCache.size > 500) tokenCache.clear();   // belt and braces: never grow for ever
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
  async function gate(req, res, need) {
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
        const email = data.user.email;
        const role = await roleOf(email);
        who = { email, role };
        tokenCache.set(token, { who, exp: Date.now() + CACHE_MS });
      }
      const allowed = need === 'write' ? WRITE_ROLES : READ_ROLES;
      if (!allowed.includes(who.role)) {
        res.status(403).json({ error: need === 'write' ? 'Only an Admin can change contract dates.' : 'Not allowed.', role: who.role || null });
        return null;
      }
      return who;
    } catch (e) {
      console.error('[cal-contract] gate error:', e.message || e);
      res.status(500).json({ error: 'Could not check who you are. Try again.' });
      return null;
    }
  }

  /* ---------- small checks ---------- */
  const isYmd = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')) && String(s).length <= 254;
  const pub = (r) => ({
    teacher_email: r.teacher_email, start_date: r.start_date, end_date: r.end_date,
    extension: r.extension, extension_months: r.extension_months, note: r.note,
    updated_by: r.updated_by, updated_at: r.updated_at
  });

  /* ---------- GET /cal-contracts-list ---------- */
  app.get('/cal-contracts-list', async (req, res) => {
    const who = await gate(req, res, 'read'); if (!who) return;
    try {
      const canEdit = WRITE_ROLES.includes(who.role);
      let q = db().from(TABLE).select('teacher_email,start_date,end_date,extension,extension_months,note,updated_by,updated_at');
      if (!canEdit) q = q.eq('teacher_email', String(who.email).toLowerCase());   // a Teacher sees only their own
      const { data, error } = await q.order('end_date', { ascending: true });
      if (error) throw error;
      res.json({ ok: true, role: who.role, canEdit, me: who.email, contracts: (data || []).map(pub) });
    } catch (e) {
      console.error('[cal-contract] list failed:', e.message || e);
      res.status(500).json({ error: 'Could not load contracts.' });
    }
  });

  /* ---------- POST /cal-contract-save ---------- */
  app.post('/cal-contract-save', async (req, res) => {
    const who = await gate(req, res, 'write'); if (!who) return;
    try {
      const b = req.body || {};
      const email = String(b.teacherEmail || '').trim().toLowerCase();
      const start = String(b.startDate || '').trim();
      const end = String(b.endDate || '').trim();
      const ext = EXT.includes(b.extension) ? b.extension : 'discuss';
      let months = b.extensionMonths == null || b.extensionMonths === '' ? null : Number(b.extensionMonths);
      const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;

      if (!isEmail(email)) return res.status(400).json({ error: 'teacherEmail is not an email address.' });
      if (!isYmd(start) || !isYmd(end)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
      if (end < start) return res.status(400).json({ error: 'The end date must not be before the start date.' });
      if (months != null && (!Number.isInteger(months) || months < 1 || months > 120)) return res.status(400).json({ error: 'extensionMonths must be a whole number from 1 to 120.' });
      if (ext !== 'yes') months = null;                                              // months only make sense when renewable

      const row = { teacher_email: email, start_date: start, end_date: end, extension: ext, extension_months: months, note, updated_by: who.email, updated_at: new Date().toISOString() };
      const { data, error } = await db().from(TABLE).upsert(row, { onConflict: 'teacher_email' }).select().limit(1);
      if (error) throw error;
      console.log(`[cal-contract] SAVED ${email} ${start}..${end} ext=${ext}${months ? '+' + months + 'mo' : ''} by ${who.email}`);
      res.json({ ok: true, contract: pub(data && data[0] ? data[0] : row) });
    } catch (e) {
      console.error('[cal-contract] save failed:', e.message || e);
      res.status(500).json({ error: 'Could not save the contract.' });
    }
  });

  /* ---------- POST /cal-contract-delete ---------- */
  app.post('/cal-contract-delete', async (req, res) => {
    const who = await gate(req, res, 'write'); if (!who) return;
    try {
      const email = String((req.body || {}).teacherEmail || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ error: 'teacherEmail is not an email address.' });
      const { error, count } = await db().from(TABLE).delete({ count: 'exact' }).eq('teacher_email', email);
      if (error) throw error;
      console.log(`[cal-contract] DELETED ${email} (${count || 0} row) by ${who.email}`);
      res.json({ ok: true, removed: count || 0 });
    } catch (e) {
      console.error('[cal-contract] delete failed:', e.message || e);
      res.status(500).json({ error: 'Could not remove the contract.' });
    }
  });
};
