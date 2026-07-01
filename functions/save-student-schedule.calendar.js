// netlify/functions/save-student-schedule.js
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function keyOf(row) {
    return `${row.day_of_week}|${row.time_local}|${row.buoi_phu ? 1 : 0}`;
}

function timeToMin(t) {
    const [h = 0, m = 0] = String(t || '').split(':').map(Number);
    return h * 60 + m;
}

module.exports = function(app) {
  app.post('/save-student-schedule', async (req, res) => {
try {
        const body = (req.body || {});
        const studentEmail = (body.studentEmail || '').trim();
        const tz = body.tz || 'Asia/Ho_Chi_Minh';
        const desired = Array.isArray(body.desired) ? body.desired : [];
        const statusVal = body.statusVal;
        const currentUserId = (body.currentUserId || '').trim();
        if (!currentUserId) {
            return res.status(401).json({ ok: false, error: 'Not signed in (missing currentUserId)' });
        }


        if (!studentEmail) {
            return res.status(400).json({ ok: false, error: 'Missing studentEmail' });
        }
        if (!desired.length) {
            return res.status(400).json({ ok: false, error: 'No schedule rows provided' });
        }

        const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
        const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
        if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
            return res.status(500).json({ ok: false, error: 'Server not configured (missing env vars)' });
        }

        const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


        // 0) optional status update
        if (statusVal !== null && statusVal !== undefined && statusVal !== '') {
            await supabase.from('danh_sach_hv').update({ status: Number(statusVal) }).eq('email', studentEmail);
        }

        // 1) Load existing rows for this student
        const { data: existing, error: selErr } = await supabase
            .from('student_schedule')
            .select('id, day_of_week, time_local, buoi_phu, timezone, teacher_email, assigned_teacher_id, sessions_per_day')
            .eq('student_email', studentEmail);

        if (selErr) throw selErr;

        const existingArr = existing || [];
        const desiredArr = desired.map(r => ({
            day_of_week: Number(r.day_of_week),
            time_local: String(r.time_local),
            buoi_phu: !!r.buoi_phu,
            sessions_per_day: Math.max(1, Number(r.sessions_per_day) || 1),
            timezone: r.timezone || tz
        }));

        // 2) Build maps
        const existingByKey = new Map(existingArr.map(r => [keyOf(r), r]));
        const desiredByKey = new Map(desiredArr.map(r => [keyOf(r), r]));

        // 3) Unchanged: fix timezone only
        const unchangedNeedingTz = existingArr
            .filter(r => desiredByKey.has(keyOf(r)) && (r.timezone || '') !== tz)
            .map(r => r.id);

        let updatedTz = 0;
        if (unchangedNeedingTz.length) {
            const { error: tzErr } = await supabase
                .from('student_schedule')
                .update({ timezone: tz })
                .in('id', unchangedNeedingTz);
            if (tzErr) throw tzErr;
            updatedTz = unchangedNeedingTz.length;
        }

        // 3b) Unchanged slot but the number (sessions_per_day) changed -> update
        //     just the number. sessions_per_day is intentionally NOT part of keyOf,
        //     so a number-only change looks "unchanged" here; we sync it without
        //     deleting/recreating the row, so any teacher assignment is preserved.
        let numberUpdated = 0;
        for (const r of existingArr) {
            if (!desiredByKey.has(keyOf(r))) continue;
            const want = desiredByKey.get(keyOf(r));
            if (Number(r.sessions_per_day) !== Number(want.sessions_per_day)) {
                const { error: nErr } = await supabase
                    .from('student_schedule')
                    .update({ sessions_per_day: want.sessions_per_day })
                    .eq('id', r.id);
                if (nErr) throw nErr;
                numberUpdated++;
            }
        }

        // 4) Moves (same day & buoi_phu, time changed)
        const timeChangedDesired = desiredArr.filter(r => !existingByKey.has(keyOf(r)));
        const oldNotKept = existingArr.filter(r => !desiredByKey.has(keyOf(r)));
        const usedOldIds = new Set();

        const toMove = [];
        for (const want of timeChangedDesired) {
            const candidates = oldNotKept
                .filter(or => or.day_of_week === want.day_of_week && (!!or.buoi_phu) === (!!want.buoi_phu) && !usedOldIds.has(or.id))
                .sort((a, b) => Math.abs(timeToMin(a.time_local) - timeToMin(want.time_local)) - Math.abs(timeToMin(b.time_local) - timeToMin(want.time_local)));
            if (candidates[0]) {
                usedOldIds.add(candidates[0].id);
                toMove.push({ id: candidates[0].id, newTime: want.time_local, n: want.sessions_per_day });
            }
        }

        let moved = 0;
        for (const m of toMove) {
            const { error: mvErr } = await supabase
                .from('student_schedule')
                .update({ time_local: m.newTime, timezone: tz, sessions_per_day: m.n })
                .eq('id', m.id);
            if (mvErr) throw mvErr;
            // keep in-memory data in sync after move
            const movedRow = existingArr.find(e => e.id === m.id);
            if (movedRow) movedRow.time_local = m.newTime;
            moved++;
        }


        // 4a) Toggles (same day & time, only buoi_phu changed) -> UPDATE instead of INSERT
        let toggled = 0;
        for (const want of desiredArr) {
            const sameSlot = existingArr.find(e =>
                e.day_of_week === want.day_of_week &&
                String(e.time_local) === String(want.time_local) &&
                (!!e.buoi_phu) !== (!!want.buoi_phu)  // flipped
            );
            if (sameSlot) {
                const { error: tgErr } = await supabase
                    .from('student_schedule')
                    .update({ buoi_phu: want.buoi_phu, timezone: tz, sessions_per_day: want.sessions_per_day })
                    .eq('id', sameSlot.id);
                if (tgErr) throw tgErr;

                // keep in-memory view in sync so later steps don't try to insert a duplicate
                sameSlot.buoi_phu = want.buoi_phu;
                toggled++;
            }
        }

        // 5) Delete removed rows FIRST (before insert to avoid duplicate key)
        const movedIds = new Set(toMove.map(r => r.id));
        const toggledIds = new Set();
        for (const e of existingArr) {
            const sameSlotDesired = desiredArr.find(d =>
                d.day_of_week === e.day_of_week &&
                String(d.time_local) === String(e.time_local)
            );
            if (sameSlotDesired && (!!e.buoi_phu) !== (!!sameSlotDesired.buoi_phu)) {
                toggledIds.add(e.id);
            }
        }

        const toDeleteIds = existingArr
            .filter(r => !desiredByKey.has(keyOf(r)) && !movedIds.has(r.id) && !toggledIds.has(r.id))
            .map(r => r.id);

        let deleted = 0;
        if (toDeleteIds.length) {
            const { error: delErr } = await supabase
                .from('student_schedule')
                .delete()
                .in('id', toDeleteIds);
            if (delErr) throw delErr;
            deleted = toDeleteIds.length;
        }

        // Remove deleted rows from in-memory array
        const deletedIdSet = new Set(toDeleteIds);
        const remainingArr = existingArr.filter(r => !deletedIdSet.has(r.id));

        // 6) Insert brand-new rows (after deletes, so no duplicate key conflict)
        const currentSlots = new Set(
            remainingArr.map(r => `${r.day_of_week}|${r.time_local}`)
        );

        const toInsert = desiredArr
            .filter(r => !currentSlots.has(`${r.day_of_week}|${r.time_local}`))
            .map(r => ({ student_email: studentEmail, created_by: currentUserId, ...r }));

        let inserted = 0;
        if (toInsert.length) {
            const { error: insErr } = await supabase.from('student_schedule').insert(toInsert);
            if (insErr) throw insErr;
            inserted = toInsert.length;
        }

        return res.status(200).json({ ok: true, updatedTz, moved, inserted, deleted, toggled, numberUpdated });
    } catch (err) {
        return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
};
