// netlify/functions/learn-complete.js
const { createClient } = require('@supabase/supabase-js');

module.exports = function(app) {
  app.post('/learn-complete', async (req, res) => {
let body;
  try {
    body = (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const student_email = (body.student_email || '').trim();
  const student_name = (body.student_name || '').trim();
  const nhan_xet_gv = (body.nhan_xet_gv || '').trim();
  const completed_by = (body.completed_by || '').trim(); // teacher email

  if (!student_email) return res.status(400).json({ error: 'student_email is required' });

  const SUPABASE_URL = (process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL);
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;


  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  // Helpers
  const fmtHMS = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  const bangkokYMD = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // "YYYY-MM-DD"

  const bangkokDow = () => {
    const w = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(new Date());
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[w] ?? 0;
  };

  const today = bangkokYMD();

  try {
    // 1) Get student's max minutes
    let maxMins = 25;
    {
      const { data: hvRow, error } = await db
        .from('danh_sach_hv')
        .select('max')
        .eq('email', student_email)
        .maybeSingle();
      if (error) throw error;
      if (hvRow && Number(hvRow.max)) maxMins = Number(hvRow.max);
    }

    // 2) 25-minute override if today has any buoi_phu slot
    let limitMins = maxMins;
    {
      const { data: slots, error } = await db
        .from('student_schedule')
        .select('buoi_phu')
        .eq('student_email', student_email)
        .eq('day_of_week', bangkokDow());
      if (error) throw error;
      const hasExtra = (slots || []).some(r => r && r.buoi_phu === true);
      if (hasExtra) limitMins = 25;
    }

    // 3) Find (or create) today’s joined row
    const { data: rows, error: findErr } = await db
      .from('learn_status_reports')
      .select('id,start_time')
      .eq('student_email', student_email)
      .eq('joined_status_today', today)
      .order('start_time', { ascending: false })
      .limit(1);
    if (findErr) throw findErr;

    let id, startIso;
    if (rows && rows.length) {
      id = rows[0].id;
      startIso = rows[0].start_time;
    } else {
      // fallback create if not joined (keeps behavior similar to your old code)
      const nowIso = new Date().toISOString();
      const { data: ins, error: insErr } = await db
        .from('learn_status_reports')
        .insert({
          student_email,
          student_name: student_name || student_email,
          start_time: nowIso,
          joined_status_today: today
        })
        .select('id,start_time')
        .single();
      if (insErr) throw insErr;
      id = ins.id;
      startIso = ins.start_time;
    }

    // 4) Compute server-side totals
    const now = new Date();
    const start = new Date(startIso || now.toISOString());
    const usedMs = Math.max(0, now.getTime() - start.getTime());
    const time_used = fmtHMS(usedMs);

    const totalMs = Math.max(0, limitMins * 60 * 1000);
    const leftMs = totalMs - usedMs;

    let time_left = null;
    let time_exceeded = null;
    if (leftMs >= 0) {
      time_left = fmtHMS(leftMs);
    } else {
      time_exceeded = fmtHMS(Math.abs(leftMs));
    }

    // 5) Save completion
    const completed_at = now.toISOString();
    const { error: updErr } = await db
      .from('learn_status_reports')
      .update({
        time_used,
        time_left,
        time_exceeded,
        nhan_xet_gv,
        email_gv_complete: completed_by || null,
        completed_at
      })
      .eq('id', id);
    if (updErr) throw updErr;

    // ===== Send Zalo completion message to student + guardians =====
    try {
      // Look up teacher full name from user_roles (fallback to email)
      let teacherFullName = completed_by || '';
      if (completed_by) {
        const { data: tr } = await db
          .from('user_roles')
          .select('full_name')
          .eq('email', completed_by)
          .maybeSingle();
        if (tr?.full_name) teacherFullName = tr.full_name;
      }

      const displayName = student_name || student_email;
      let zaloMsg = `HV ${displayName} đã hoàn thành buổi học hôm nay và đã được GV ${teacherFullName || 'phụ trách'} kiểm tra bài.`;
      if (nhan_xet_gv) {
        zaloMsg += `\n\nNhận xét ngắn gọn: ${nhan_xet_gv}`;
      }

      console.log('[Zalo-Complete] 🟡 sending Zalo for', student_email);
      await sendZaloToStudentAndGuardians(db, student_email, zaloMsg);
      console.log('[Zalo-Complete] 🟢 done');
    } catch (zaloErr) {
      console.error('[Zalo-Complete] error:', zaloErr);
    }

return res.status(200).json({
  ok: true,
  data: {
    id,                         // NEW
    student_email,              // NEW
    start_time: startIso,       // NEW
    time_used,
    time_left,
    time_exceeded,
    completed_at,
    email_gv_complete: completed_by || null, // NEW
    nhan_xet_gv,                // NEW
    limit_minutes: limitMins
  }
});

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  });
};


// ========== HELPER: Send Zalo to student + guardians ==========
async function sendZaloToStudentAndGuardians(supabase, studentEmail, message) {
  const { data: tokenRow } = await supabase
    .from('tokens')
    .select('access_token')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!tokenRow?.access_token) {
    console.error('[Zalo-Complete] No access token found');
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
    console.log('[Zalo-Complete] No contact found for:', studentEmail);
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
    console.log('[Zalo-Complete] No Zalo IDs for:', studentEmail);
    return;
  }

  const footer = `Nhờ Phụ huynh/ Học viên nhắn lại một tin để Zalo cho phép TANSINH tiếp tục gửi thông tin. Trân trọng!`;
  const finalText = `${message}\n\n${footer}`;

  for (const id of uniqueIds) {
    try {
      const zResp = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: token },
        body: JSON.stringify({
          recipient: { user_id: id },
          message: { text: finalText }
        })
      });
      const zJson = await zResp.json();

      const deliveryStatus = zResp.ok && (!zJson.error || zJson.error === 0) ? 'Success' : 'Zalo hết hạn';
      const bangkokIso = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
      await supabase.from('zalo_status').upsert({
        oa_id: oaId,
        recipient_id: id,
        recipient_name: contact.ten_hv || studentEmail,
        status: deliveryStatus,
        created_at: bangkokIso
      }, { onConflict: 'oa_id,recipient_id' });

      if (!zResp.ok || (zJson.error && zJson.error !== 0)) {
        console.error('[Zalo-Complete] send error', id, zJson);
      }
    } catch (err) {
      console.error(`[Zalo-Complete] Network error for ${id}:`, err.message);
    }
  }
}