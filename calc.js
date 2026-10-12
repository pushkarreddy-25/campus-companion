(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Calc = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
  function calculateAttendancePercentage(attended, total) {
    if (
      typeof total !== 'number' ||
      typeof attended !== 'number' ||
      !Number.isFinite(total) ||
      !Number.isFinite(attended) ||
      total <= 0
    ) {
      return null;
    }
    return (attended / total) * 100;
  }

  function getAttendanceCounts(records, subjectId = null) {
    const list = Array.isArray(records) ? records : [];
    const filtered = subjectId
      ? list.filter((r) => r && r.subjectId === subjectId)
      : list;
    const attended = filtered.filter((r) => r && r.status === 'present').length;
    const absent = filtered.filter((r) => r && r.status === 'absent').length;
    const unsure = filtered.filter((r) => r && r.status === 'unsure').length;
    const cancelled = filtered.filter((r) => r && r.status === 'cancelled').length;
    const total = attended + absent;
    const percentage = calculateAttendancePercentage(attended, total);
    return {
      records: filtered,
      attended,
      absent,
      unsure,
      cancelled,
      total,
      percentage
    };
  }

  function calculateClassesToAttend(targetPercent, attended, total) {
    if (
      typeof targetPercent !== 'number' ||
      !Number.isFinite(targetPercent) ||
      targetPercent <= 0
    ) {
      return 0;
    }
    if (
      typeof total !== 'number' ||
      !Number.isFinite(total) ||
      total <= 0
    ) {
      return 0;
    }
    if (
      typeof attended !== 'number' ||
      !Number.isFinite(attended)
    ) {
      return 0;
    }
    if (attended / total >= targetPercent / 100) {
      return 0;
    }
    if (targetPercent >= 100) {
      return 'Not possible to recover';
    }

    const targetRatio = targetPercent / 100;
    const needed = Math.ceil((targetRatio * total - attended) / (1 - targetRatio));
    return Math.max(1, needed);
  }

  function calculateMissableClasses(targetPercent, attended, total) {
    if (
      typeof targetPercent !== 'number' ||
      !Number.isFinite(targetPercent) ||
      targetPercent <= 0 ||
      targetPercent > 100
    ) {
      return 0;
    }
    if (
      typeof total !== 'number' ||
      !Number.isFinite(total) ||
      total <= 0
    ) {
      return 0;
    }
    if (
      typeof attended !== 'number' ||
      !Number.isFinite(attended)
    ) {
      return 0;
    }
    const targetRatio = targetPercent / 100;
    if (attended / total < targetRatio) {
      return 0;
    }
    if (targetPercent === 100) {
      return 0;
    }

    const missable = Math.floor(attended / targetRatio - total);
    return Math.max(0, missable);
  }

  // Pure local date functions (No UTC/toISOString date logic)
  function formatLocalDate(date = new Date(), timeZone = null) {
    const d = date instanceof Date ? date : new Date(date);
    if (timeZone) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(d);
      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;
      return `${year}-${month}-${day}`;
    }
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseLocalDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return new Date();
    const parts = dateStr.split('-').map(Number);
    if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
      return new Date();
    }
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  }

  function getLocalWeekday(dateOrStr) {
    const d = typeof dateOrStr === 'string' ? parseLocalDate(dateOrStr) : new Date(dateOrStr);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[d.getDay()];
  }

  function shiftLocalDate(dateStr, dayDelta) {
    const d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + dayDelta);
    return formatLocalDate(d);
  }

  // Pure function: updates existing record on same subject & date; does NOT duplicate
  function markSlotAttendance(attendanceList, subjectId, dateStr, status) {
    const list = Array.isArray(attendanceList) ? [...attendanceList] : [];
    const index = list.findIndex(
      (e) => e && e.subjectId === subjectId && e.date === dateStr
    );

    if (index >= 0) {
      list[index] = {
        ...list[index],
        status
      };
    } else {
      list.push({
        id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        subjectId,
        date: dateStr,
        status
      });
    }
    return list;
  }

  // Pure function: calculates pending timetable lectures over the past N days grouped by date
  function getPendingLectures({
    timetable = [],
    attendance = [],
    onboardingDate = null,
    todayStr = formatLocalDate(),
    daysBack = 7
  }) {
    const slots = Array.isArray(timetable) ? timetable : [];
    const records = Array.isArray(attendance) ? attendance : [];
    const groups = [];

    for (let i = 1; i <= daysBack; i++) {
      const dateStr = shiftLocalDate(todayStr, -i);

      if (onboardingDate && dateStr < onboardingDate) {
        continue;
      }

      const weekday = getLocalWeekday(dateStr);
      const matchingSlots = slots.filter((slot) => {
        if (!slot || slot.day !== weekday) return false;
        if (slot.createdAt && dateStr < slot.createdAt) return false;
        // Check if attendance already recorded for this subject on dateStr
        const hasRecord = records.some(
          (entry) =>
            entry &&
            entry.subjectId === slot.subjectId &&
            entry.date === dateStr &&
            ['present', 'absent', 'unsure', 'cancelled'].includes(entry.status)
        );
        return !hasRecord;
      });

      if (matchingSlots.length > 0) {
        groups.push({
          dateStr,
          weekday,
          items: matchingSlots.map((slot) => ({
            slot,
            subjectId: slot.subjectId
          }))
        });
      }
    }

    const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0);
    return { groups, totalCount };
  }

  // Pure function: migrates previous schema and old backup files into modern structure
  function migrateSchema(data) {
    if (!data || typeof data !== 'object') {
      return { profile: null, subjects: [], attendance: [], timetable: [] };
    }

    const profile =
      data.profile && typeof data.profile === 'object' && data.profile.name
        ? {
            name: String(data.profile.name).trim(),
            branch: String(data.profile.branch || '').trim(),
            semester: String(data.profile.semester || '').trim(),
            onboardingDate: data.profile.onboardingDate || formatLocalDate()
          }
        : null;

    const subjects = Array.isArray(data.subjects)
      ? data.subjects.filter(
          (s) => s && typeof s.id === 'string' && typeof s.name === 'string'
        )
      : [];

    const attendance = Array.isArray(data.attendance)
      ? data.attendance.filter(
          (a) =>
            a &&
            typeof a.id === 'string' &&
            typeof a.subjectId === 'string' &&
            a.date &&
            a.status
        )
      : [];

    const timetable = Array.isArray(data.timetable)
      ? data.timetable.filter(
          (t) =>
            t &&
            typeof t.id === 'string' &&
            typeof t.subjectId === 'string' &&
            typeof t.day === 'string'
        )
      : [];

    return { profile, subjects, attendance, timetable };
  }

  return {
    calculateAttendancePercentage,
    getAttendanceCounts,
    calculateClassesToAttend,
    calculateMissableClasses,
    formatLocalDate,
    parseLocalDate,
    getLocalWeekday,
    shiftLocalDate,
    markSlotAttendance,
    getPendingLectures,
    migrateSchema
  };
});
