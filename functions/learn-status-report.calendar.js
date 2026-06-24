// netlify/functions/learn-status-report.js (ESM)
const { createClient } = require('@supabase/supabase-js');

/* -------- Time + parsing helpers (Bangkok, UTC+7) -------- */
function bangkokNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 7 * 60 * 60000);
}
function bangkokYMD(d = bangkokNow()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function bangkokDOW(d = bangkokNow()) { return d.getDay(); } // Sun=0..Sat=6
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
function hhmmToMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function formatHMS(totalMs) {
  const s = Math.max(0, Math.floor(totalMs / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

module.exports = function(app) {
  app.post('/learn-status-report', async (req, res) => {
try {
    const {
      student_email,
      student_name: provided_name,
      hinh_chup_meeting
    } = (req.body || {});


    if (!student_email) {
      return res.status(400).send('Missing student_email');
    }

    const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY; // keep secret
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).send('Server not configured (missing env vars)');
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


    // --- Require & verify bearer token; map to staff email ---
const authz = req.headers['authorization'] || '';
const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
if (!token) {
  return res.status(401).send('Missing bearer token');
}

// Who's calling? Prefer user_roles.email, fallback to auth email
let check_in_teacher = null;
try {
  const { data: authUser, error: auErr } = await supabase.auth.getUser(token);
  if (auErr || !authUser?.user) {
    return res.status(401).send('Invalid token');
  }
  const uid = authUser.user.id;
  const authEmail = authUser.user.email || '';
  const { data: ur } = await supabase
    .from('user_roles')
    .select('email')
    .eq('uid', uid)
    .maybeSingle();
  check_in_teacher = (ur?.email || authEmail || null);
} catch {
  return res.status(401).send('Auth lookup failed');
}



    // Derive student_name from DB if not provided
    let student_name = provided_name || null;
    try {
      const { data: hv, error: hvErr } = await supabase
        .from('danh_sach_hv')
        .select('ten_hv')
        .eq('email', student_email)
        .maybeSingle();
      if (!hvErr && hv?.ten_hv) student_name = hv.ten_hv;
    } catch (_) { }
    if (!student_name) student_name = student_email;

    // Server times/dates (Bangkok “today” stamp)
    const startIsoNow = new Date().toISOString();
    const todayBangkok = bangkokYMD();
    const dow = bangkokDOW();

    // Find earliest scheduled time today from schedule + makeups
    let times = [];
    try {
      const { data: schedRows } = await supabase
        .from('student_schedule')
        .select('time_local')
        .eq('student_email', student_email)
        .eq('day_of_week', dow);
      (schedRows || []).forEach(r => {
        const n = normalizeHHMM(r.time_local);
        if (n) times.push(n);
      });
    } catch (_) { }
    try {
      const { data: makeups } = await supabase
        .from('offdays_makeup_classes')
        .select('makeup_start_time')
        .eq('person_email', student_email)
        .eq('makeup_date', todayBangkok)
        .eq('no_makeup', false);
      (makeups || []).forEach(r => {
        const n = normalizeHHMM(r.makeup_start_time);
        if (n) times.push(n);
      });
    } catch (_) { }

    let early_start = null;
    let late_start = null;
    if (times.length) {
      const earliest = times.sort((a, b) => hhmmToMinutes(a) - hhmmToMinutes(b))[0];
      const scheduledMs = Date.parse(`${todayBangkok}T${earliest}:00+07:00`);
      const actualMs = Date.parse(startIsoNow);
      const delta = actualMs - scheduledMs; // >0 late, <0 early
      if (Math.abs(delta) >= 1000) {
        if (delta < 0) early_start = formatHMS(Math.abs(delta));
        else late_start = formatHMS(delta);
      }
    }

    // Idempotency: reuse open row for today if exists (not completed yet)
    let retId = null;
    let retStartIso = startIsoNow;

    try {
      const { data: existing } = await supabase
        .from('learn_status_reports')
        .select('id,start_time')
        .eq('student_email', student_email)
        .eq('joined_status_today', todayBangkok)
        .is('email_gv_complete', null)
        .order('start_time', { ascending: false })
        .limit(1);

      if (existing && existing.length) {
        retId = existing[0].id;
        retStartIso = existing[0].start_time || retStartIso;
      }
    } catch (_) { }

    if (retId) {
      // Update existing row (do not change start_time)
      const { error: updErr } = await supabase
        .from('learn_status_reports')
        .update({
          check_in_teacher: check_in_teacher || null,
          hinh_chup_meeting: hinh_chup_meeting || null,
          early_start,
          late_start
        })
        .eq('id', retId);
      if (updErr) {
        return res.status(500).json({ error: updErr.message });
      }
    } else {
      // Insert new row
      const { data: ins, error: insErr } = await supabase
        .from('learn_status_reports')
        .insert([{
          student_email,
          student_name,
          start_time: startIsoNow,
          check_in_teacher: check_in_teacher || null,
          hinh_chup_meeting: hinh_chup_meeting || null,
          joined_status_today: todayBangkok,
          early_start,
          late_start
        }])
        .select('id,start_time')
        .single();
      if (insErr) {
        return res.status(500).json({ error: insErr.message });
      }
      retId = ins.id;
      retStartIso = ins.start_time || retStartIso;
    }

    // ===== Send Zalo to student + guardians =====
    try {
      const bkNow = bangkokNow();
      const timeStr = String(bkNow.getHours()).padStart(2, '0') + ':' + String(bkNow.getMinutes()).padStart(2, '0');

      let zaloMsg = '';
      if (late_start) {
        // Parse HH:MM:SS to minutes
        const parts = late_start.split(':').map(Number);
        const lateMins = (parts[0] || 0) * 60 + (parts[1] || 0) + (parts[2] > 0 ? 1 : 0);
        zaloMsg = `HV ${student_name} đã tham gia học trễ ${lateMins} phút. (Vào lúc ${timeStr})`;
      } else if (early_start) {
        const parts = early_start.split(':').map(Number);
        const earlyMins = (parts[0] || 0) * 60 + (parts[1] || 0);
        zaloMsg = `HV ${student_name} đã tham gia học sớm ${earlyMins} phút so với giờ học. (Vào lúc ${timeStr})`;
      } else {
        zaloMsg = `HV ${student_name} đã tham gia học lúc ${timeStr}.`;
      }

      // Look up the teacher's full name (fallback to email)
      let teacherFullName = check_in_teacher || '';
      if (check_in_teacher) {
        try {
          const { data: tr } = await supabase
            .from('user_roles')
            .select('full_name')
            .eq('email', check_in_teacher)
            .maybeSingle();
          if (tr?.full_name) teacherFullName = tr.full_name;
        } catch (_) { }
      }

      if (teacherFullName) {
        zaloMsg += `\n\nBạn đã tham gia meeting Breakout của GV ${teacherFullName}.`;
      }

      if (hinh_chup_meeting) {
        zaloMsg += `\n\nĐây là hình ảnh bạn đã tham gia meeting: ${hinh_chup_meeting}`;
      }

      // AWAIT so Netlify doesn't kill the function before Zalo finishes
      console.log('[Zalo-Join] 🟡 calling sendZaloToStudentAndGuardians...');
      try {
        await sendZaloToStudentAndGuardians(supabase, student_email, zaloMsg);
        console.log('[Zalo-Join] 🟢 sendZaloToStudentAndGuardians finished');
      } catch (err) {
        console.error('[Zalo-Join] ❌ sender threw:', err);
      }
    } catch (zaloErr) {
      console.error('[Zalo-Join] Error building message:', zaloErr);
    }

    return res.status(200).json({
        ok: true,
        data: {
          id: retId,
          student_email,                 // NEW
          student_name,                  // NEW
          start_time: retStartIso,
          early_start,
          late_start,
          joined_status_today: todayBangkok,   // NEW
          check_in_teacher: check_in_teacher || null, // NEW
          hinh_chup_meeting: hinh_chup_meeting || null // NEW
        }
      });

  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
  });
};

// ========== HELPER: Send Zalo to student + guardians ==========
async function sendZaloToStudentAndGuardians(supabase, studentEmail, message) {
  console.log('[Zalo-Join] ▶ ENTER sendZaloToStudentAndGuardians for:', studentEmail);

  const { data: tokenRow } = await supabase
    .from('tokens')
    .select('access_token')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log('[Zalo-Join] token loaded?', !!tokenRow?.access_token);

  if (!tokenRow?.access_token) {
    console.error('[Zalo-Join] No access token found');
    return;
  }

  const token = tokenRow.access_token;
  const oaId = process.env.ZALO_OA_ID;

  const { data: contact } = await supabase
    .from('students_contact_info')
    .select('email, zalo_key, guardian_key1_m, guardian_key2_c, guardian_key3_other, ten_hv')
    .eq('email', studentEmail)
    .maybeSingle();

  if (!contact) {
    console.log('[Zalo-Join] No contact found for:', studentEmail);
    return;
  }

  const receiverIds = [
    contact.zalo_key,
    contact.guardian_key1_m,
    contact.guardian_key2_c,
    contact.guardian_key3_other
  ].filter(Boolean);

  const uniqueIds = [...new Set(receiverIds)];
  if (!uniqueIds.length) {
    console.log('[Zalo-Join] No Zalo IDs for:', studentEmail);
    return;
  }

  const footer = `Nhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép TANSINH tiếp tục gửi thông tin. Trân trọng!`;
  const finalText = `${message}\n\n${footer}`;

  for (const id of uniqueIds) {
    try {
      console.log('[Zalo-Join] 📤 about to fetch Zalo API for user_id:', id);
      const resp = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: token },
        body: JSON.stringify({
          recipient: { user_id: id },
          message: { text: finalText }
        })
      });
      console.log('[Zalo-Join] ✅ Zalo API responded status:', resp.status);
      const json = await resp.json();

      const deliveryStatus = resp.ok && (!json.error || json.error === 0) ? 'Success' : 'Zalo hết hạn';
      const bangkokIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
      await supabase.from('zalo_status').upsert({
        oa_id: oaId,
        recipient_id: id,
        recipient_name: contact.ten_hv || studentEmail,
        status: deliveryStatus,
        created_at: bangkokIso
      }, { onConflict: 'oa_id,recipient_id' });

      if (!resp.ok || (json.error && json.error !== 0)) {
        console.error('[Zalo-Join] send error', id, json);
      }
    } catch (err) {
      console.error(`[Zalo-Join] Network error for ${id}:`, err.message);
    }
  }
}