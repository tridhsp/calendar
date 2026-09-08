// save-student-schedule.calendar.js
//
// Rewritten Sep 8 2026. Same endpoint, same request body, same response keys,
// plus a few new ones. The diff is now a PURE function (planChanges) so it can
// be unit-tested without a database — run `node save-student-schedule.calendar.js --selftest`.
//
// WHAT WAS WRONG BEFORE (all measured, see calendar-app notes):
//   1. time_local is `time without time zone`, so Postgres returns "18:30:00"
//      while an edited or new row from the page arrives as "18:30". The old
//      keyOf() compared them raw, so an edited row NEVER matched its existing
//      row. It then went through delete + insert, and the insert carried no
//      teacher_email — the teacher silently vanished from that slot.
//   2. The old "move" step greedily grabbed the NEAREST same-day row. Adding a
//      second lesson on a day could move the existing row (and its teacher) to
//      the new time and re-insert the original time with no teacher.
//   3. Every error collapsed to a bare 500 with the message thrown away on the
//      client. Now the response carries the real message and a step name.
//   4. Deleting the last day was refused with 400 even when the quota allowed
//      it. Now allowed when the body says allowEmpty: true (the client's quota
//      gate still governs whether that is sensible).

// @supabase/supabase-js is required lazily inside the handler, so this file
// can be loaded and self-tested from anywhere (e.g. /tmp) without node_modules.

// ---------------------------------------------------------------- helpers --

// "18:30:00" -> "18:30", "8:5" -> "08:05", "" -> ""
function normTime(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) return '';
  const [h = '0', m = '0'] = s.split(':');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMin(t) {
  const [h = 0, m = 0] = normTime(t).split(':').map(Number);
  return h * 60 + m;
}

function keyOf(r) {
  return `${Number(r.day_of_week)}|${normTime(r.time_local)}|${r.buoi_phu ? 1 : 0}`;
}

function slotOf(r) {
  return `${Number(r.day_of_week)}|${normTime(r.time_local)}`;
}

// ------------------------------------------------------------ the planner --
//
// existing: rows from the DB for this student
// desired : rows from the page
// Returns a plan of DB operations. Nothing here touches the network.
//
function planChanges(existing, desired, tz) {
  const ex = (existing || []).map(r => ({ ...r, time_local: normTime(r.time_local) }));
  const want = (desired || []).map(r => ({
    day_of_week: Number(r.day_of_week),
    time_local: normTime(r.time_local),
    buoi_phu: !!r.buoi_phu,
    sessions_per_day: Math.max(1, Number(r.sessions_per_day) || 1),
    timezone: r.timezone || tz,
  })).filter(r => r.time_local && Number.isInteger(r.day_of_week));

  const exByKey = new Map(ex.map(r => [keyOf(r), r]));
  const wantByKey = new Map(want.map(r => [keyOf(r), r]));

  const plan = { tzFix: [], numberUpdate: [], move: [], toggle: [], delete: [], insert: [], carried: [] };
  const consumed = new Set();      // existing ids already accounted for

  // 1. Unchanged slots: sync timezone and sessions_per_day in place.
  for (const r of ex) {
    const w = wantByKey.get(keyOf(r));
    if (!w) continue;
    consumed.add(r.id);
    if ((r.timezone || '') !== tz) plan.tzFix.push(r.id);
    if (Number(r.sessions_per_day) !== w.sessions_per_day) {
      plan.numberUpdate.push({ id: r.id, sessions_per_day: w.sessions_per_day });
    }
  }

  // 2. Toggles: same day + time, only buoi_phu flipped -> UPDATE, keep teacher.
  for (const w of want) {
    if (exByKey.has(keyOf(w))) continue;
    const flipped = ex.find(r => !consumed.has(r.id) && slotOf(r) === slotOf(w) && !!r.buoi_phu !== w.buoi_phu);
    if (flipped) {
      consumed.add(flipped.id);
      plan.toggle.push({ id: flipped.id, buoi_phu: w.buoi_phu, sessions_per_day: w.sessions_per_day });
    }
  }

  // 3. Moves: a desired slot with no match, paired with an UNKEPT existing row
  //    on the same day and same buoi_phu -> UPDATE time in place, keep teacher.
  //    Only rows that are genuinely unkept are candidates, so adding a second
  //    lesson on a day can no longer steal the existing one.
  const unmatchedWant = want.filter(w => !exByKey.has(keyOf(w)) && !plan.toggle.some(t => slotOf(ex.find(r => r.id === t.id)) === slotOf(w)));
  for (const w of unmatchedWant) {
    const cands = ex
      .filter(r => !consumed.has(r.id) && Number(r.day_of_week) === w.day_of_week && !!r.buoi_phu === w.buoi_phu)
      .sort((a, b) => Math.abs(timeToMin(a.time_local) - timeToMin(w.time_local)) - Math.abs(timeToMin(b.time_local) - timeToMin(w.time_local)));
    if (cands[0]) {
      consumed.add(cands[0].id);
      plan.move.push({ id: cands[0].id, time_local: w.time_local, sessions_per_day: w.sessions_per_day, from: cands[0].time_local });
    }
  }

  // 4. Whatever is still unconsumed is gone.
  for (const r of ex) if (!consumed.has(r.id)) plan.delete.push(r.id);

  // 5. Whatever is still unmatched is new. If an unkept row with the same
  //    buoi_phu is being deleted (a lesson moved to ANOTHER day), carry its
  //    teacher across instead of losing it — and say so, because the teacher's
  //    availability on the new day is not checked here.
  const deletedRows = ex.filter(r => plan.delete.includes(r.id));
  const usedDonor = new Set();
  for (const w of unmatchedWant) {
    if (plan.move.some(m => m.time_local === w.time_local && Number(ex.find(r => r.id === m.id).day_of_week) === w.day_of_week)) continue;
    const row = { ...w };
    const donor = deletedRows.find(r => !usedDonor.has(r.id) && !!r.buoi_phu === w.buoi_phu && (r.teacher_email || r.breakout_email))
    if (donor) {
      usedDonor.add(donor.id);
      row.teacher_email = donor.teacher_email || null;
      row.breakout_email = donor.breakout_email || null;
      plan.carried.push({ from: `${donor.day_of_week}|${donor.time_local}`, to: slotOf(w), teacher_email: donor.teacher_email || null });
    }
    plan.insert.push(row);
  }

  return plan;
}

// ----------------------------------------------------------- the route --

module.exports = function (app) {
  app.post('/save-student-schedule', async (req, res) => {
    let step = 'parse';
    try {
      const body = req.body || {};
      const studentEmail = String(body.studentEmail || '').trim();
      const tz = body.tz || 'Asia/Ho_Chi_Minh';
      const desired = Array.isArray(body.desired) ? body.desired : [];
      const statusVal = body.statusVal;
      const currentUserId = String(body.currentUserId || '').trim();
      const allowEmpty = body.allowEmpty === true;

      if (!currentUserId) return res.status(401).json({ ok: false, step, error: 'Not signed in (missing currentUserId)' });
      if (!studentEmail) return res.status(400).json({ ok: false, step, error: 'Missing studentEmail' });
      if (!desired.length && !allowEmpty) {
        return res.status(400).json({ ok: false, step, error: 'No schedule rows provided (send allowEmpty:true to clear the schedule)' });
      }

      const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.SUPABASE_URL;
      const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
      if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return res.status(500).json({ ok: false, step, error: 'Server not configured (missing env vars)' });
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

      step = 'status';
      if (statusVal !== null && statusVal !== undefined && statusVal !== '') {
        const { error } = await supabase.from('danh_sach_hv').update({ status: Number(statusVal) }).eq('email', studentEmail);
        if (error) throw error;
      }

      step = 'load';
      const { data: existing, error: selErr } = await supabase
        .from('student_schedule')
        .select('id, day_of_week, time_local, buoi_phu, timezone, teacher_email, breakout_email, assigned_teacher_id, sessions_per_day')
        .eq('student_email', studentEmail);
      if (selErr) throw selErr;

      const plan = planChanges(existing, desired, tz);

      // Order matters: in-place updates first, deletes before inserts.
      step = 'tzFix';
      if (plan.tzFix.length) {
        const { error } = await supabase.from('student_schedule').update({ timezone: tz }).in('id', plan.tzFix);
        if (error) throw error;
      }
      step = 'numberUpdate';
      for (const u of plan.numberUpdate) {
        const { error } = await supabase.from('student_schedule').update({ sessions_per_day: u.sessions_per_day }).eq('id', u.id);
        if (error) throw error;
      }
      step = 'toggle';
      for (const t of plan.toggle) {
        const { error } = await supabase.from('student_schedule').update({ buoi_phu: t.buoi_phu, timezone: tz, sessions_per_day: t.sessions_per_day }).eq('id', t.id);
        if (error) throw error;
      }
      step = 'move';
      for (const m of plan.move) {
        const { error } = await supabase.from('student_schedule').update({ time_local: m.time_local, timezone: tz, sessions_per_day: m.sessions_per_day }).eq('id', m.id);
        if (error) throw error;
      }
      step = 'delete';
      if (plan.delete.length) {
        const { error } = await supabase.from('student_schedule').delete().in('id', plan.delete);
        if (error) throw error;
      }
      step = 'insert';
      if (plan.insert.length) {
        const rows = plan.insert.map(r => ({ student_email: studentEmail, created_by: currentUserId, ...r }));
        const { error } = await supabase.from('student_schedule').insert(rows);
        if (error) throw error;
      }

      return res.status(200).json({
        ok: true,
        updatedTz: plan.tzFix.length,
        numberUpdated: plan.numberUpdate.length,
        toggled: plan.toggle.length,
        moved: plan.move.length,
        deleted: plan.delete.length,
        inserted: plan.insert.length,
        carried: plan.carried,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      console.error(`[save-student-schedule] step=${step} ${msg}`, err?.code || '', err?.details || '');
      return res.status(500).json({ ok: false, step, error: msg, code: err?.code || null, details: err?.details || null });
    }
  });
};

module.exports.planChanges = planChanges;
module.exports.normTime = normTime;

// --------------------------------------------------------------- selftest --
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const tz = 'Asia/Ho_Chi_Minh';
  const row = (id, d, t, bp = false, teacher = null, extra = {}) =>
    ({ id, day_of_week: d, time_local: t, buoi_phu: bp, timezone: tz, teacher_email: teacher, sessions_per_day: 1, ...extra });
  const want = (d, t, bp = false, n = 1) => ({ day_of_week: d, time_local: t, buoi_phu: bp, sessions_per_day: n });
  let n = 0;
  const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

  t('DB "18:30:00" vs page "18:30" is UNCHANGED, not delete+insert', () => {
    const p = planChanges([row('a', 1, '18:30:00', false, 'gv@x')], [want(1, '18:30')], tz);
    assert.deepStrictEqual([p.delete.length, p.insert.length, p.move.length], [0, 0, 0]);
  });
  t('adding a second lesson on the same day does NOT move the first one', () => {
    const p = planChanges([row('a', 1, '18:00:00', false, 'gv@x')], [want(1, '19:00'), want(1, '18:00')], tz);
    assert.deepStrictEqual(p.move, []);
    assert.strictEqual(p.insert.length, 1);
    assert.strictEqual(p.insert[0].time_local, '19:00');
    assert.strictEqual(p.delete.length, 0);
  });
  t('changing a time on the same day is a MOVE that keeps the row (and its teacher)', () => {
    const p = planChanges([row('a', 1, '18:00:00', false, 'gv@x')], [want(1, '19:30')], tz);
    assert.strictEqual(p.move.length, 1);
    assert.strictEqual(p.move[0].id, 'a');
    assert.strictEqual(p.move[0].time_local, '19:30');
    assert.deepStrictEqual([p.delete.length, p.insert.length], [0, 0]);
  });
  t('flipping buoi_phu is a TOGGLE, not delete+insert', () => {
    const p = planChanges([row('a', 1, '18:00:00', false, 'gv@x')], [want(1, '18:00', true)], tz);
    assert.strictEqual(p.toggle.length, 1);
    assert.deepStrictEqual([p.delete.length, p.insert.length, p.move.length], [0, 0, 0]);
  });
  t('moving a lesson to ANOTHER day carries the teacher and reports it', () => {
    const p = planChanges([row('a', 2, '18:00:00', false, 'gv@x')], [want(3, '18:00')], tz);
    assert.strictEqual(p.delete.length, 1);
    assert.strictEqual(p.insert.length, 1);
    assert.strictEqual(p.insert[0].teacher_email, 'gv@x');
    assert.strictEqual(p.carried.length, 1);
  });
  t('removing a day deletes only that row', () => {
    const p = planChanges([row('a', 1, '18:00:00'), row('b', 3, '18:00:00')], [want(1, '18:00')], tz);
    assert.deepStrictEqual(p.delete, ['b']);
    assert.strictEqual(p.insert.length, 0);
  });
  t('empty desired deletes everything', () => {
    const p = planChanges([row('a', 1, '18:00:00'), row('b', 3, '18:00:00')], [], tz);
    assert.deepStrictEqual(p.delete.sort(), ['a', 'b']);
  });
  t('sessions_per_day change on an unchanged slot is an in-place number update', () => {
    const p = planChanges([row('a', 1, '18:00:00', false, 'gv@x')], [want(1, '18:00', false, 2)], tz);
    assert.deepStrictEqual(p.numberUpdate, [{ id: 'a', sessions_per_day: 2 }]);
    assert.deepStrictEqual([p.delete.length, p.insert.length], [0, 0]);
  });
  t('stale timezone on an unchanged slot is fixed in place', () => {
    const p = planChanges([row('a', 1, '18:00:00', false, null, { timezone: 'UTC' })], [want(1, '18:00')], tz);
    assert.deepStrictEqual(p.tzFix, ['a']);
  });
  t('a desired row with no time is ignored', () => {
    const p = planChanges([], [want(1, '')], tz);
    assert.strictEqual(p.insert.length, 0);
  });
  console.log(`\nSELFTEST PASSED (${n} cases)`);
}
