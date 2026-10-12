const assert = require('assert');
const {
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
} = require('./calc.js');
const { filterResources, validateResourceFile, sanitizeFileName } = require('./library-utils.js');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failCount++;
  }
}

runTest('Library filters match search and every selected filter', () => {
  const resources = [
    { title: 'DBMS Notes', subject: 'DBMS', academic_year: '2025-26', uploader_name: 'A', branch: 'CSE', year: '2', semester: '4', resource_type: 'notes' },
    { title: 'Networks PYQ', subject: 'Networks', academic_year: '2024-25', uploader_name: 'B', branch: 'ECE', year: '2', semester: '4', resource_type: 'pyq' }
  ];
  assert.strictEqual(filterResources(resources, { query: 'dbms', branch: 'CSE', subject: 'DBMS', resourceType: 'notes' }).length, 1);
  assert.strictEqual(filterResources(resources, { branch: 'CSE', subject: 'Networks' }).length, 0);
});

runTest('Library file validation accepts only PDFs at or below 10 MB', () => {
  assert.strictEqual(validateResourceFile({ name: 'notes.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 }), true);
  assert.strictEqual(validateResourceFile({ name: 'notes.exe', type: 'application/pdf', size: 10 }), false);
  assert.strictEqual(validateResourceFile({ name: 'notes.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }), false);
});

runTest('Library storage filename removes unsafe characters', () => {
  const path = sanitizeFileName('../Paid Notes (final).pdf', 'fixed-id');
  assert.strictEqual(path, 'paid-notes-final-fixed-id.pdf');
  assert.ok(!path.includes('/'));
});

// 1. 30 Present / 10 Absent = 75%
runTest('30 Present / 10 Absent gives 75%', () => {
  const records = [
    ...Array(30).fill({ status: 'present' }),
    ...Array(10).fill({ status: 'absent' })
  ];
  const stats = getAttendanceCounts(records);
  assert.strictEqual(stats.attended, 30);
  assert.strictEqual(stats.absent, 10);
  assert.strictEqual(stats.total, 40);
  assert.strictEqual(stats.percentage, 75);

  const directPercent = calculateAttendancePercentage(30, 40);
  assert.strictEqual(directPercent, 75);
});

// 2. Zero records = no percentage, no NaN
runTest('Zero records gives no percentage and no NaN', () => {
  const emptyRecords = [];
  const stats = getAttendanceCounts(emptyRecords);
  assert.strictEqual(stats.total, 0);
  assert.strictEqual(stats.percentage, null, 'percentage should be null when total is 0');
  assert.ok(!Number.isNaN(stats.percentage), 'percentage must not be NaN');

  const directPercent = calculateAttendancePercentage(0, 0);
  assert.strictEqual(directPercent, null);
  assert.ok(!Number.isNaN(directPercent));
});

// 3. Not sure excluded from total and percentage calculation
runTest('"Not sure" entries are excluded from total counted and percentage', () => {
  const records = [
    { status: 'present' },
    { status: 'present' },
    { status: 'present' },
    { status: 'absent' },
    { status: 'unsure' },
    { status: 'unsure' }
  ];
  const stats = getAttendanceCounts(records);
  assert.strictEqual(stats.attended, 3);
  assert.strictEqual(stats.absent, 1);
  assert.strictEqual(stats.unsure, 2);
  assert.strictEqual(stats.total, 4, 'total should be present + absent only (4)');
  assert.strictEqual(stats.percentage, 75);
});

// 3b. Cancelled entries excluded from total counted and percentage
runTest('"Cancelled" entries are excluded from total counted and percentage', () => {
  const records = [
    { status: 'present' },
    { status: 'present' },
    { status: 'cancelled' },
    { status: 'cancelled' }
  ];
  const stats = getAttendanceCounts(records);
  assert.strictEqual(stats.attended, 2);
  assert.strictEqual(stats.absent, 0);
  assert.strictEqual(stats.cancelled, 2);
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.percentage, 100);
});

// 4. 28/40 with 75% target gives correct classes to attend (8)
runTest('28/40 with 75% target gives the correct classes to attend (8)', () => {
  const needed = calculateClassesToAttend(75, 28, 40);
  assert.strictEqual(needed, 8);
});

// 5. 33/40 with 75% target gives correct missable classes (4)
runTest('33/40 with 75% target gives the correct missable classes (4)', () => {
  const missable = calculateMissableClasses(75, 33, 40);
  assert.strictEqual(missable, 4);
});

runTest('33/40 with 75% target requires no additional classes to attend', () => {
  const needed = calculateClassesToAttend(75, 33, 40);
  assert.strictEqual(needed, 0);
});

// 6. Target 100% does not return Infinity or NaN
runTest('Target 100% does not return Infinity or NaN', () => {
  const resultRecover = calculateClassesToAttend(100, 9, 10);
  assert.notStrictEqual(resultRecover, Infinity, 'Must not return Infinity');
  assert.ok(!Number.isNaN(resultRecover), 'Must not return NaN');
  assert.strictEqual(resultRecover, 'Not possible to recover');

  const resultPerfect = calculateClassesToAttend(100, 10, 10);
  assert.strictEqual(resultPerfect, 0);

  const missable100 = calculateMissableClasses(100, 10, 10);
  assert.notStrictEqual(missable100, Infinity);
  assert.ok(!Number.isNaN(missable100));
  assert.strictEqual(missable100, 0);

  const zeroRecordRecover = calculateClassesToAttend(100, 0, 0);
  assert.notStrictEqual(zeroRecordRecover, Infinity);
  assert.ok(!Number.isNaN(zeroRecordRecover));
  assert.strictEqual(zeroRecordRecover, 0);
});

// 7. Invalid inputs handling
runTest('Invalid inputs do not cause NaN or crashes', () => {
  assert.strictEqual(calculateClassesToAttend(NaN, 10, 20), 0);
  assert.strictEqual(calculateClassesToAttend(-50, 10, 20), 0);
  assert.strictEqual(calculateMissableClasses(NaN, 10, 20), 0);
  assert.strictEqual(calculateMissableClasses(150, 10, 20), 0);
  assert.strictEqual(calculateAttendancePercentage(NaN, 20), null);
});

// 8. No duplicate entry when marking the same slot twice on the same date
runTest('No duplicate entry when marking the same slot twice on the same date', () => {
  let attendance = [];
  const subjectId = 'sub-dbms';
  const dateStr = '2026-10-10';

  // First mark Present
  attendance = markSlotAttendance(attendance, subjectId, dateStr, 'present');
  assert.strictEqual(attendance.length, 1);
  assert.strictEqual(attendance[0].status, 'present');

  // Mark same slot on same date as Absent (must update, NOT duplicate)
  attendance = markSlotAttendance(attendance, subjectId, dateStr, 'absent');
  assert.strictEqual(attendance.length, 1, 'Array length must still be 1 (no duplicate)');
  assert.strictEqual(attendance[0].status, 'absent');

  // Mark same slot on same date as Cancelled (must update, NOT duplicate)
  attendance = markSlotAttendance(attendance, subjectId, dateStr, 'cancelled');
  assert.strictEqual(attendance.length, 1, 'Array length must still be 1 (no duplicate)');
  assert.strictEqual(attendance[0].status, 'cancelled');
});

// 9. Pending list correct for a fake "today"
runTest('Pending list correct for a fake "today"', () => {
  // Fake today is Saturday, 2026-10-10
  const fakeToday = '2026-10-10';
  assert.strictEqual(getLocalWeekday(fakeToday), 'saturday');

  // Friday is 2026-10-09, Thursday is 2026-10-08
  const timetable = [
    { id: 'slot-fri', subjectId: 'sub-os', day: 'friday', time: '10:00 AM', createdAt: '2026-10-01' },
    { id: 'slot-thu', subjectId: 'sub-dbms', day: 'thursday', time: '11:00 AM', createdAt: '2026-10-01' }
  ];

  // Attendance only has an entry for Thursday 2026-10-08
  const attendance = [
    { id: 'rec-1', subjectId: 'sub-dbms', date: '2026-10-08', status: 'present' }
  ];

  const { groups, totalCount } = getPendingLectures({
    timetable,
    attendance,
    onboardingDate: '2026-10-01',
    todayStr: fakeToday,
    daysBack: 7
  });

  // Thursday 2026-10-08 is already attended, so only Friday 2026-10-09 should be pending
  assert.strictEqual(totalCount, 1, 'Should find exactly 1 pending lecture');
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].dateStr, '2026-10-09');
  assert.strictEqual(groups[0].weekday, 'friday');
  assert.strictEqual(groups[0].items[0].subjectId, 'sub-os');
});

// 10. Pending excludes dates before onboarding/slot creation
runTest('Pending excludes dates before onboarding/slot creation', () => {
  const fakeToday = '2026-10-10'; // Saturday
  // Tuesday was 2026-10-06, Thursday was 2026-10-08, Friday was 2026-10-09

  const timetable = [
    // Slot 1: created 2026-10-05, but student onboarded on 2026-10-07
    { id: 'slot-tue', subjectId: 'sub-math', day: 'tuesday', createdAt: '2026-10-05' },
    // Slot 2: created 2026-10-09 (Friday) for Thursday lectures
    { id: 'slot-thu', subjectId: 'sub-ai', day: 'thursday', createdAt: '2026-10-09' },
    // Slot 3: created 2026-10-07 for Friday lectures
    { id: 'slot-fri', subjectId: 'sub-os', day: 'friday', createdAt: '2026-10-07' }
  ];

  const { groups, totalCount } = getPendingLectures({
    timetable,
    attendance: [],
    onboardingDate: '2026-10-07', // Onboarded on Wednesday
    todayStr: fakeToday,
    daysBack: 7
  });

  // Tuesday (2026-10-06) is before onboarding (2026-10-07) -> excluded!
  // Thursday (2026-10-08) is before slot creation (2026-10-09) -> excluded!
  // Friday (2026-10-09) is on/after onboarding AND on/after slot creation -> included!
  assert.strictEqual(totalCount, 1, 'Only Friday should be included');
  assert.strictEqual(groups[0].dateStr, '2026-10-09');
  assert.strictEqual(groups[0].items[0].subjectId, 'sub-os');
});

// 11. Local-date handling around 23:30 and 00:30 IST
runTest('Local-date handling around 23:30 and 00:30 IST without UTC shifts', () => {
  // 23:30 IST on Oct 10 corresponds to 18:00 UTC Oct 10
  const date2330IST = new Date('2026-10-10T18:00:00.000Z');
  // 00:30 IST on Oct 11 corresponds to 19:00 UTC Oct 10
  const date0030IST = new Date('2026-10-10T19:00:00.000Z');

  const formatted2330 = formatLocalDate(date2330IST, 'Asia/Kolkata');
  const formatted0030 = formatLocalDate(date0030IST, 'Asia/Kolkata');

  // Both dates must accurately reflect the local date in IST
  assert.strictEqual(formatted2330, '2026-10-10', '23:30 IST must be 2026-10-10');
  assert.strictEqual(formatted0030, '2026-10-11', '00:30 IST must be 2026-10-11');

  // Verify that UTC .toISOString() would have given the wrong date (2026-10-10 for both)
  assert.strictEqual(date0030IST.toISOString().slice(0, 10), '2026-10-10', 'toISOString() produces wrong date for 00:30 IST');

  // Shift local date helper tests
  assert.strictEqual(shiftLocalDate('2026-10-10', -1), '2026-10-09');
  assert.strictEqual(shiftLocalDate('2026-10-10', 1), '2026-10-11');
});

// 12. Migration of an old-schema object and an old exported backup file into new schema
runTest('Migration of an old-schema object and old exported backup file without losing data', () => {
  // Legacy object from previous schema (no profile object)
  const legacyStorage = {
    subjects: [
      { id: 'sub-legacy-1', name: 'Legacy Operating Systems', target: 75, code: 'CS302' },
      { id: 'sub-legacy-2', name: 'Legacy Computer Networks', target: 80, code: 'CS303' }
    ],
    attendance: [
      { id: 'rec-legacy-1', subjectId: 'sub-legacy-1', date: '2026-10-01', status: 'present' },
      { id: 'rec-legacy-2', subjectId: 'sub-legacy-1', date: '2026-10-02', status: 'absent' }
    ]
  };

  const migratedStorage = migrateSchema(legacyStorage);
  assert.strictEqual(migratedStorage.subjects.length, 2, 'All legacy subjects must be preserved');
  assert.strictEqual(migratedStorage.attendance.length, 2, 'All legacy attendance records must be preserved');
  assert.strictEqual(migratedStorage.profile, null, 'Profile is correctly null for legacy data without profile');
  assert.deepStrictEqual(migratedStorage.timetable, [], 'Timetable initialized as empty array');

  // Old exported backup file format
  const oldBackup = {
    app: 'Campus Companion',
    version: 1,
    exportedAt: '2026-10-05',
    profile: {
      name: 'Rohan Gupta',
      branch: 'CSE',
      semester: 'Sem 4'
    },
    subjects: [
      { id: 'sub-1', name: 'Machine Learning', target: 75 }
    ],
    attendance: [
      { id: 'rec-1', subjectId: 'sub-1', date: '2026-10-04', status: 'present' }
    ]
  };

  const migratedBackup = migrateSchema(oldBackup);
  assert.strictEqual(migratedBackup.profile.name, 'Rohan Gupta');
  assert.strictEqual(migratedBackup.subjects.length, 1);
  assert.strictEqual(migratedBackup.attendance.length, 1);
  assert.ok(migratedBackup.profile.onboardingDate, 'Onboarding date assigned if missing');
  assert.deepStrictEqual(migratedBackup.timetable, []);
});

// 14. Pending badge count equals list length and today's slots not counted
runTest("Pending badge count equals list items length and today's slots not counted", () => {
  const fakeToday = '2026-10-10'; // Saturday
  assert.strictEqual(getLocalWeekday(fakeToday), 'saturday');

  const timetable = [
    // Slot today (Saturday) - must NEVER be counted in pending
    { id: 'slot-sat', subjectId: 'sub-ai', day: 'saturday', createdAt: '2026-10-10' },
    // Slot yesterday (Friday) - should be counted
    { id: 'slot-fri', subjectId: 'sub-db', day: 'friday', createdAt: '2026-10-09' },
    // Slot 2 days ago (Thursday) - should be counted
    { id: 'slot-thu', subjectId: 'sub-os', day: 'thursday', createdAt: '2026-10-08' }
  ];

  const attendance = [];

  const { groups, totalCount } = getPendingLectures({
    timetable,
    attendance,
    onboardingDate: '2026-10-01',
    todayStr: fakeToday,
    daysBack: 7
  });

  // Calculate actual rendered card count across all groups
  const renderedListLength = groups.reduce((sum, g) => sum + g.items.length, 0);

  // Badge count must equal list length exactly
  assert.strictEqual(totalCount, renderedListLength, 'Badge totalCount must equal list length');
  assert.strictEqual(totalCount, 2, 'Must have exactly 2 pending lectures (Friday and Thursday)');

  // Confirm today's slots are not in any group
  const hasTodayGroup = groups.some((g) => g.dateStr === fakeToday || g.weekday === 'saturday');
  assert.strictEqual(hasTodayGroup, false, "Today's slots must not be in pending list");
});

// 15. Pending count is 0 after marking all lectures (Present, Absent, Cancelled, Not sure)
runTest('Pending count is 0 after marking all lectures (Present, Absent, Cancelled, Not sure)', () => {
  const fakeToday = '2026-10-10'; // Saturday

  const timetable = [
    { id: 'slot-fri', subjectId: 'sub-1', day: 'friday', createdAt: '2026-10-01' },
    { id: 'slot-thu', subjectId: 'sub-2', day: 'thursday', createdAt: '2026-10-01' },
    { id: 'slot-wed', subjectId: 'sub-3', day: 'wednesday', createdAt: '2026-10-01' },
    { id: 'slot-tue', subjectId: 'sub-4', day: 'tuesday', createdAt: '2026-10-01' }
  ];

  // All 4 lectures are marked with distinct statuses: Present, Absent, Cancelled, Unsure
  const attendance = [
    { id: 'a1', subjectId: 'sub-1', date: '2026-10-09', status: 'present' },
    { id: 'a2', subjectId: 'sub-2', date: '2026-10-08', status: 'absent' },
    { id: 'a3', subjectId: 'sub-3', date: '2026-10-07', status: 'cancelled' },
    { id: 'a4', subjectId: 'sub-4', date: '2026-10-06', status: 'unsure' }
  ];

  const { groups, totalCount } = getPendingLectures({
    timetable,
    attendance,
    onboardingDate: '2026-10-01',
    todayStr: fakeToday,
    daysBack: 7
  });

  assert.strictEqual(totalCount, 0, 'Total pending count must be 0 after marking everything');
  assert.strictEqual(groups.length, 0, 'Groups list must be empty after marking everything');
});

// 16. Only recognized attendance statuses remove a lecture from pending
runTest('Pending ignores unknown attendance statuses but excludes every marked status', () => {
  const timetable = [
    { id: 'slot-unknown', subjectId: 'unknown', day: 'friday', createdAt: '2026-10-01' },
    { id: 'slot-marked', subjectId: 'marked', day: 'thursday', createdAt: '2026-10-01' }
  ];
  const attendance = [
    { id: 'unknown-record', subjectId: 'unknown', date: '2026-10-09', status: 'draft' },
    { id: 'marked-record', subjectId: 'marked', date: '2026-10-08', status: 'unsure' }
  ];
  const result = getPendingLectures({
    timetable,
    attendance,
    onboardingDate: '2026-10-01',
    todayStr: '2026-10-10',
    daysBack: 7
  });
  assert.strictEqual(result.totalCount, 1);
  assert.strictEqual(result.groups[0].items[0].subjectId, 'unknown');
});

console.log(`\nAll Unit Tests Finished: ${passCount} passed, ${failCount} failed.`);
if (failCount > 0) {
  process.exit(1);
}
