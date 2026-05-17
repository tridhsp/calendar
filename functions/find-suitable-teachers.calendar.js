// netlify/functions/find-suitable-teachers.js
const { createClient } = require('@supabase/supabase-js');

function timeToMin(t) {
  const [h = 0, m = 0] = String(t || '').split(':').map(Number);
  return h * 60 + m;
}

function minToHHMM(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function buildTimelineSegments(breakoutStudents, hvMap, hvNameMap, windowStart, windowEnd) {
  const studentRanges = [];
  for (const s of breakoutStudents) {
    const sStart = timeToMin(s.time_local);
    const sDur = s.buoi_phu ? 25 : (hvMap[s.student_email] || 25);
    const sEnd = sStart + sDur;
    if (sStart < windowEnd && sEnd > windowStart) {
      studentRanges.push({
        email: s.student_email,
        name: hvNameMap[s.student_email] || s.student_email.split('@')[0],
        start: sStart, end: sEnd, duration: sDur, buoiPhu: !!s.buoi_phu,
        role: s._role || ''
      });
    }
  }

  const timePoints = new Set([windowStart, windowEnd]);
  for (const sr of studentRanges) {
    if (sr.start >= windowStart && sr.start < windowEnd) timePoints.add(sr.start);
    if (sr.end > windowStart && sr.end <= windowEnd) timePoints.add(sr.end);
  }
  const sorted = Array.from(timePoints).sort((a, b) => a - b);

  const segments = [];
  let peakCount = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i];
    const segEnd = sorted[i + 1];
    const present = studentRanges.filter(sr => sr.start < segEnd && sr.end > segStart);
    const count = present.length;
    if (count > peakCount) peakCount = count;
    segments.push({
      start: minToHHMM(segStart), end: minToHHMM(segEnd),
      startMin: segStart, endMin: segEnd,
      duration: segEnd - segStart, count,
      students: present.map(sr => ({
        name: sr.name, email: sr.email,
        time: minToHHMM(sr.start), endTime: minToHHMM(sr.end),
        duration: sr.duration, buoiPhu: sr.buoiPhu,
        role: sr.role
      }))
    });
  }

  let suitability, suitabilityLabel;
  if (peakCount <= 3) {
    suitability = 'good';
    suitabilityLabel = 'Phù hợp — GV có thể quản lý tốt';
  } else if (peakCount <= 6) {
    suitability = 'ok';
    suitabilityLabel = 'Chấp nhận được — GV sẽ hơi đông lúc cao điểm';
  } else {
    suitability = 'overload';
    suitabilityLabel = 'Quá tải — GV đã có quá nhiều HV cùng lúc';
  }

  return {
    segments, peakCount, suitability, suitabilityLabel,
    allStudents: studentRanges.map(sr => ({
      name: sr.name, email: sr.email,
      time: minToHHMM(sr.start), endTime: minToHHMM(sr.end),
      duration: sr.duration, buoiPhu: sr.buoiPhu,
      role: sr.role
    }))
  };
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

module.exports = function(app) {
  app.post('/find-suitable-teachers', async (req, res) => {
try {
    const { day_of_week, time_local, student_email } = (req.body || {});

    if (day_of_week == null || !time_local) {
      return res.status(400).json({ ok: false, error: 'Missing day_of_week or time_local' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const targetMin = timeToMin(time_local);

    // 1) Find all teachers with availability covering this day/time
    const { data: avail, error: aErr } = await supabase
      .from('teacher_availability')
      .select('teacher_email, time_start, time_end')
      .eq('day_of_week', day_of_week)
      .lte('time_start', time_local)
      .gt('time_end', time_local);

    if (aErr) throw aErr;

    const candidateEmails = [...new Set((avail || []).map(a => a.teacher_email).filter(Boolean))];

    if (!candidateEmails.length) {
      return res.status(200).json({ ok: true, breakoutTeachers: [], ttkbTeachers: [] });
    }

    // 1b) Get department info from meeting_content to know who is CURRENTLY a Breakout teacher
    //     - Recurring shifts (is_one_time = false) always count
    //     - One-time shifts only count if the date is today or in the future
    const todayYMD = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0]; // Bangkok time

    const { data: mcRows, error: mcErr } = await supabase
      .from('meeting_content')
      .select('teacher_email, department, is_one_time, work_date, start_time, end_time');
    if (mcErr) throw mcErr;

    const breakoutDeptEmails = new Set();
    const supporterDeptEmails = new Set();
    const ttkbDeptEmails = new Set();
    for (const row of (mcRows || [])) {
      const dept = (row.department || '').trim().toLowerCase();

      const isOneTime = row.is_one_time === true || row.is_one_time === 1 ||
        String(row.is_one_time).toLowerCase() === 'true' ||
        String(row.is_one_time).toLowerCase() === 't';

      // Skip expired one-time shifts
      if (isOneTime) {
        const rowDate = String(row.work_date || '').slice(0, 10);
        if (rowDate < todayYMD) continue;
      }

      const email = (row.teacher_email || '').toLowerCase();
      if (dept === 'breakout' || dept === 'bm' || dept.includes('breakout')) {
        breakoutDeptEmails.add(email);
      }

      // For TTKB: only count if this shift is on the SAME day of week
      if (dept === 'ttkb' || dept === 'tt' || dept.includes('ttkb') || dept.includes('tương tác')) {
        const rowYMD = String(row.work_date || '').slice(0, 10);
        const [ry, rm, rd] = rowYMD.split('-').map(Number);
        const rowDow = new Date(ry, rm - 1, rd).getDay();
        if (isOneTime) {
          if (rowDow === Number(day_of_week)) ttkbDeptEmails.add(email);
        } else {
          if (rowDow === Number(day_of_week)) ttkbDeptEmails.add(email);
        }
      }

      // For Supporter/Mix: only count if this shift is on the SAME day of week
      if (dept === 'supporter' || dept === 'support' || dept === 'mix') {
        const rowYMD = String(row.work_date || '').slice(0, 10);
        const [ry, rm, rd] = rowYMD.split('-').map(Number);
        const rowDow = new Date(ry, rm - 1, rd).getDay();
        if (isOneTime) {
          // One-time: only if it falls on the target day_of_week
          if (rowDow === Number(day_of_week)) supporterDeptEmails.add(email);
        } else {
          // Recurring: only if the recurring DOW matches the target
          if (rowDow === Number(day_of_week)) supporterDeptEmails.add(email);
        }
      }
    }

    // Build time-aware department map: which department covers the student's SPECIFIC time?
    // A teacher can have TTKB 17-18 and Supporter 18-21 on the same day.
    const teacherDeptAtTargetTime = {};
    for (const row of (mcRows || [])) {
      const isOneTime = row.is_one_time === true || row.is_one_time === 1 ||
        String(row.is_one_time).toLowerCase() === 'true' ||
        String(row.is_one_time).toLowerCase() === 't';
      if (isOneTime) {
        const rowDate = String(row.work_date || '').slice(0, 10);
        if (rowDate < todayYMD) continue;
      }
      const email = (row.teacher_email || '').toLowerCase();
      const rowYMD = String(row.work_date || '').slice(0, 10);
      const [ry, rm, rd] = rowYMD.split('-').map(Number);
      const rowDow = new Date(ry, rm - 1, rd).getDay();
      if (rowDow !== Number(day_of_week)) continue;
      const shiftStart = String(row.start_time || '').slice(0, 5);
      const shiftEnd = String(row.end_time || '').slice(0, 5);
      if (shiftStart <= time_local && shiftEnd > time_local) {
        teacherDeptAtTargetTime[email] = (row.department || '').trim();
      }
    }
    

    // 2) Get ALL schedules on this day_of_week (for counting each teacher's load)
    const { data: allScheds, error: sErr } = await supabase
      .from('student_schedule')
      .select('student_email, teacher_email, breakout_email, time_local, buoi_phu')
      .eq('day_of_week', day_of_week);

    if (sErr) throw sErr;

    // 3) Get student max durations for overlap calculation
    const allStudentEmails = [...new Set((allScheds || []).map(s => s.student_email).filter(Boolean))];
    if (student_email && !allStudentEmails.includes(student_email)) {
      allStudentEmails.push(student_email);
    }

    const hvMap = {};
    const hvMinMap = {};
    const hvNameMap = {};
    if (allStudentEmails.length) {
      // Batch in chunks of 200 to avoid URL length limits
      for (let i = 0; i < allStudentEmails.length; i += 200) {
        const chunk = allStudentEmails.slice(i, i + 200);
        const { data: hvRows } = await supabase
          .from('danh_sach_hv')
          .select('email, min, max, status, ten_hv')
          .in('email', chunk);
        for (const h of (hvRows || [])) {
          hvMap[h.email] = Number(h.max) || Number(h.status) || 25;
          hvMinMap[h.email] = Number(h.status) || 25;
          hvNameMap[h.email] = h.ten_hv || h.email.split('@')[0];
        }
      }
    }

    // 4) Get teacher full names
    const { data: nameRows } = await supabase
      .from('user_roles')
      .select('email, full_name')
      .in('email', candidateEmails);

    const nameMap = {};
    for (const n of (nameRows || [])) nameMap[n.email] = n.full_name || n.email;

    // 5) Get teacher_blocks for TTKB free/busy analysis
    const { data: blocks, error: bErr } = await supabase
      .from('teacher_blocks')
      .select('teacher_email, day_of_week, start_time, end_time, student_email')
      .eq('day_of_week', day_of_week)
      .in('teacher_email', candidateEmails);

    if (bErr) throw bErr;

    // 6) Get availability window for each candidate (for shift display)
    const availWindowMap = {};
    for (const a of (avail || [])) {
      const e = a.teacher_email;
      if (!availWindowMap[e]) {
        availWindowMap[e] = { start: a.time_start, end: a.time_end };
      } else {
        if (a.time_start < availWindowMap[e].start) availWindowMap[e].start = a.time_start;
        if (a.time_end > availWindowMap[e].end) availWindowMap[e].end = a.time_end;
      }
    }

    // Target student's duration
    const targetDuration = hvMap[student_email] || 25;
    const targetEnd = targetMin + targetDuration;

// ====== BREAKOUT TEACHER ANALYSIS ======
    const breakoutTeachers = [];
    for (const email of candidateEmails.filter(e => breakoutDeptEmails.has(e.toLowerCase()))) {
      const emailLower = email.toLowerCase();

      // All students this teacher handles on this day (both as breakout AND as TTKB)
      const breakoutStudentsRaw = (allScheds || []).filter(s =>
        (s.breakout_email || '').toLowerCase() === emailLower ||
        (s.teacher_email || '').toLowerCase() === emailLower
      );
      // Tag each student with their role so the timeline can show TT vs BR
      const breakoutStudents = breakoutStudentsRaw.map(s => ({
        ...s,
        _role: (s.teacher_email || '').toLowerCase() === emailLower ? 'TT' : 'BR'
      }));

      const totalOnDay = breakoutStudents.length;

      // Build timeline analysis for the target student's learning window
      const timeline = buildTimelineSegments(breakoutStudents, hvMap, hvNameMap, targetMin, targetEnd);

      // Count at start time (how many students when target student arrives)
      const countAtStart = timeline.segments.length > 0 ? timeline.segments[0].count : 0;

      // Build human-readable reason with timeline insight
      let reason = '';
      if (timeline.allStudents.length === 0 && totalOnDay === 0) {
        reason = 'Chưa có HV breakout vào ngày này';
      } else if (timeline.allStudents.length === 0) {
        reason = `${totalOnDay} HV trong ngày, không ai trùng giờ này`;
      } else if (countAtStart <= 3 && timeline.peakCount <= 6) {
        reason = `Lúc bắt đầu: ${countAtStart} HV · Cao điểm: ${timeline.peakCount} HV · ${totalOnDay} HV cả ngày`;
      } else if (countAtStart <= 3 && timeline.peakCount >= 7) {
        reason = `Lúc bắt đầu chỉ ${countAtStart} HV, nhưng cao điểm lên ${timeline.peakCount} HV · ${totalOnDay} HV cả ngày`;
      } else {
        reason = `${timeline.allStudents.length} HV trùng giờ · cao điểm ${timeline.peakCount} · ${totalOnDay} HV cả ngày`;
      }

      const win = availWindowMap[email];
      const shift = win ? `${win.start.slice(0, 5)}–${win.end.slice(0, 5)}` : '';

      breakoutTeachers.push({
        email,
        name: nameMap[email] || email,
        shift,
        totalStudentsOnDay: totalOnDay,
        studentsAtTargetTime: timeline.allStudents.length,
        countAtStart,
        peakCount: timeline.peakCount,
        suitability: timeline.suitability,
        suitabilityLabel: timeline.suitabilityLabel,
        timeline: timeline.segments,
        overlappingNames: timeline.allStudents,
        reason
      });
    }

    // Sort: by suitability first, then by peak count, then fewer total
    breakoutTeachers.sort((a, b) => {
      const suitOrder = { good: 0, ok: 1, overload: 2 };
      const sa = suitOrder[a.suitability] ?? 1;
      const sb = suitOrder[b.suitability] ?? 1;
      if (sa !== sb) return sa - sb;
      if (a.peakCount !== b.peakCount) return a.peakCount - b.peakCount;
      return a.totalStudentsOnDay - b.totalStudentsOnDay;
    });

// ====== TTKB TEACHER ANALYSIS ======
    // Only show TTKB, Supporter, and Mix department teachers (not ALL teachers)
    const ttkbTeachers = [];
    const ttkbCandidateEmails = candidateEmails.filter(e => {
      const dept = (teacherDeptAtTargetTime[e.toLowerCase()] || '').toLowerCase();
      return dept === 'ttkb' || dept === 'tt' || dept.includes('ttkb') || dept.includes('tương tác') ||
             dept === 'supporter' || dept === 'support' || dept === 'mix';
    });

    for (const email of ttkbCandidateEmails) {
      const emailLower = email.toLowerCase();

      // Department label from the shift that covers the student's exact time
      const deptLabel = teacherDeptAtTargetTime[emailLower] || 'TTKB';

      // For Supporter/Mix: include BOTH TTKB students AND breakout students
      // so the timeline shows their full workload
      const isSupporterOrMix = ['supporter', 'support', 'mix'].includes(deptLabel.toLowerCase());
      const ttkbStudentsRaw = (allScheds || []).filter(s => {
        if ((s.teacher_email || '').toLowerCase() === emailLower) return true;
        if (isSupporterOrMix && (s.breakout_email || '').toLowerCase() === emailLower) return true;
        return false;
      });
      // Tag each student with their role so the timeline can show TT vs BR
      const ttkbStudents = ttkbStudentsRaw.map(s => ({
        ...s,
        _role: (s.teacher_email || '').toLowerCase() === emailLower ? 'TT' : 'BR'
      }));
      const totalTTKBOnDay = ttkbStudents.length;

      // Build timeline analysis using the same function as breakout
      const timeline = buildTimelineSegments(ttkbStudents, hvMinMap, hvNameMap, targetMin, targetEnd);
      const countAtStart = timeline.segments.length > 0 ? timeline.segments[0].count : 0;

      // Build reason
      let reason = '';
      if (timeline.allStudents.length === 0 && totalTTKBOnDay === 0) {
        reason = 'Chưa có HV TTKB vào ngày này';
      } else if (timeline.allStudents.length === 0) {
        reason = `${totalTTKBOnDay} HV trong ngày, không ai trùng giờ này`;
      } else {
        reason = `Lúc bắt đầu: ${countAtStart} HV · Cao điểm: ${timeline.peakCount} HV · ${totalTTKBOnDay} HV cả ngày`;
      }

      const win = availWindowMap[email];
      const shift = win ? `${win.start.slice(0, 5)}–${win.end.slice(0, 5)}` : '';

      // Find actual working shifts from meeting_content for this teacher on this day
      const teacherWorkShifts = (mcRows || []).filter(r => {
        if ((r.teacher_email || '').toLowerCase() !== emailLower) return false;
        const rowYMD = String(r.work_date || '').slice(0, 10);
        const [ry2, rm2, rd2] = rowYMD.split('-').map(Number);
        const rowDow = new Date(ry2, rm2 - 1, rd2).getDay();
        return rowDow === Number(day_of_week);
      }).map(r => ({
        start: String(r.start_time || '').slice(0, 5),
        end: String(r.end_time || '').slice(0, 5),
        department: (r.department || '').trim()
      }));

      // Compute combined work shift window from meeting_content
      let workStart = null, workEnd = null;
      for (const ws of teacherWorkShifts) {
        const wsStartMin = timeToMin(ws.start);
        const wsEndMin = timeToMin(ws.end);
        if (workStart === null || wsStartMin < workStart) workStart = wsStartMin;
        if (workEnd === null || wsEndMin > workEnd) workEnd = wsEndMin;
      }

      ttkbTeachers.push({
        email,
        name: nameMap[email] || email,
        shift,
        department: deptLabel,
        totalStudentsOnDay: totalTTKBOnDay,
        studentsAtTargetTime: timeline.allStudents.length,
        countAtStart,
        peakCount: timeline.peakCount,
        suitability: timeline.suitability,
        suitabilityLabel: timeline.suitabilityLabel,
        timeline: timeline.segments,
        overlappingNames: timeline.allStudents,
        reason,
        allDayStudents: ttkbStudents.map(s => ({
          email: s.student_email,
          name: hvNameMap[s.student_email] || s.student_email.split('@')[0],
          time: s.time_local,
          endTime: minToHHMM(timeToMin(s.time_local) + (s.buoi_phu ? 25 : (hvMinMap[s.student_email] || 25))),
          duration: s.buoi_phu ? 25 : (hvMinMap[s.student_email] || 25),
          buoiPhu: !!s.buoi_phu,
          role: s._role || ''
        })),
        shiftStart: win ? win.start.slice(0, 5) : null,
        shiftEnd: win ? win.end.slice(0, 5) : null,
        workShiftStart: workStart !== null ? minToHHMM(workStart) : null,
        workShiftEnd: workEnd !== null ? minToHHMM(workEnd) : null,
        workShifts: teacherWorkShifts
      });
    }

    // Sort: by suitability first, then by peak count, then fewer total
    ttkbTeachers.sort((a, b) => {
      const suitOrder = { good: 0, ok: 1, overload: 2 };
      const sa = suitOrder[a.suitability] ?? 1;
      const sb = suitOrder[b.suitability] ?? 1;
      if (sa !== sb) return sa - sb;
      if (a.peakCount !== b.peakCount) return a.peakCount - b.peakCount;
      return a.totalStudentsOnDay - b.totalStudentsOnDay;
    });
    // ====== SUPPORTER / MIX TEACHER ANALYSIS ======
    const supporterTeachers = [];
    // Only include teachers that are NOT already in breakout list
    const breakoutEmailSet = new Set(breakoutTeachers.map(t => t.email.toLowerCase()));
    for (const email of candidateEmails.filter(e => supporterDeptEmails.has(e.toLowerCase()) && !breakoutEmailSet.has(e.toLowerCase()))) {
      const emailLower = email.toLowerCase();

      // All students assigned to this teacher (breakout OR TTKB) on this day
      const breakoutStudentsRaw = (allScheds || []).filter(s =>
        (s.breakout_email || '').toLowerCase() === emailLower ||
        (s.teacher_email || '').toLowerCase() === emailLower
      );
      // Tag each student with their role so the timeline can show TT vs BR
      const breakoutStudents = breakoutStudentsRaw.map(s => ({
        ...s,
        _role: (s.teacher_email || '').toLowerCase() === emailLower ? 'TT' : 'BR'
      }));

      const totalOnDay = breakoutStudents.length;

      // Build timeline analysis
      const timeline = buildTimelineSegments(breakoutStudents, hvMap, hvNameMap, targetMin, targetEnd);
      const countAtStart = timeline.segments.length > 0 ? timeline.segments[0].count : 0;

      // Find their department label for THIS day
      const deptRow = (mcRows || []).find(r => {
        if ((r.teacher_email || '').toLowerCase() !== emailLower) return false;
        const d = (r.department || '').trim().toLowerCase();
        if (d !== 'supporter' && d !== 'support' && d !== 'mix') return false;
        const rYMD = String(r.work_date || '').slice(0, 10);
        const [ry2, rm2, rd2] = rYMD.split('-').map(Number);
        const rDow = new Date(ry2, rm2 - 1, rd2).getDay();
        return rDow === Number(day_of_week);
      });
      const deptLabel = deptRow ? (deptRow.department || '').trim() : 'Supporter';

      let reason = '';
      if (timeline.allStudents.length === 0 && totalOnDay === 0) {
        reason = 'Chưa có HV breakout vào ngày này';
      } else if (timeline.allStudents.length === 0) {
        reason = `${totalOnDay} HV trong ngày, không ai trùng giờ này`;
      } else {
        reason = `Lúc bắt đầu: ${countAtStart} HV · Cao điểm: ${timeline.peakCount} HV · ${totalOnDay} HV cả ngày`;
      }

      const win = availWindowMap[email];
      const shift = win ? `${win.start.slice(0, 5)}–${win.end.slice(0, 5)}` : '';

      supporterTeachers.push({
        email,
        name: nameMap[email] || email,
        shift,
        department: deptLabel,
        totalStudentsOnDay: totalOnDay,
        studentsAtTargetTime: timeline.allStudents.length,
        countAtStart,
        peakCount: timeline.peakCount,
        suitability: timeline.suitability,
        suitabilityLabel: timeline.suitabilityLabel,
        timeline: timeline.segments,
        overlappingNames: timeline.allStudents,
        reason
      });
    }

    supporterTeachers.sort((a, b) => {
      const suitOrder = { good: 0, ok: 1, overload: 2 };
      const sa = suitOrder[a.suitability] ?? 1;
      const sb = suitOrder[b.suitability] ?? 1;
      if (sa !== sb) return sa - sb;
      if (a.peakCount !== b.peakCount) return a.peakCount - b.peakCount;
      return a.totalStudentsOnDay - b.totalStudentsOnDay;
    });

    return res.status(200).json({ ok: true, breakoutTeachers, ttkbTeachers, supporterTeachers });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
  });
};
