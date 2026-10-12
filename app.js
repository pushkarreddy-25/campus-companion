// Campus Companion - Main Application Logic

// Use calculation helpers from Calc (calc.js)
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
} = typeof window !== 'undefined' && window.Calc
  ? window.Calc
  : (typeof require !== 'undefined' ? require('./calc.js') : {});

// Application state (no hardcoded student or seed lectures)
const state = {
  profile: null,
  currentSection: 'dashboard',
  subjects: [],
  attendance: [],
  timetable: [],
  resources: [],
  myUploads: [],
  moderationQueue: [],
  libraryLoading: false,
  libraryError: '',
  editingEntryId: null
};

const storageKey = 'campus-companion-attendance-v1';
let activeStorageKey = storageKey;
let currentUser = null;
let syncTimer = null;
const supabaseClient =
  typeof window !== 'undefined' &&
  window.supabase &&
  window.SUPABASE_URL &&
  window.SUPABASE_ANON_KEY &&
  !window.SUPABASE_URL.includes('<PASTE') &&
  !window.SUPABASE_ANON_KEY.includes('<PASTE')
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null;

const getDataPayload = () => ({
  profile: state.profile,
  subjects: state.subjects,
  attendance: state.attendance,
  timetable: state.timetable
});

const setSyncStatus = (message) => {
  const element = document.getElementById('syncStatus');
  if (element) element.textContent = message;
};

const syncToCloud = async () => {
  if (!currentUser || !supabaseClient) {
    setSyncStatus('Offline, will sync later');
    return;
  }
  setSyncStatus('Saving...');
  const { error } = await supabaseClient.from('user_data').upsert({
    user_id: currentUser.id,
    data: getDataPayload(),
    updated_at: new Date().toISOString()
  });
  if (error) {
    console.warn('Cloud sync failed.', error);
    setSyncStatus('Offline, will sync later');
    return;
  }
  setSyncStatus('Synced');
};

const scheduleCloudSync = () => {
  if (!currentUser || !supabaseClient) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToCloud, 1500);
};

// Safe localStorage persistence with error handling
const saveAppData = () => {
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify(getDataPayload()));
    localStorage.setItem(`${activeStorageKey}-updatedAt`, new Date().toISOString());
    scheduleCloudSync();
  } catch (error) {
    console.warn('Unable to save data to localStorage.', error);
  }
};

const loadAppData = () => {
  try {
    const raw = localStorage.getItem(activeStorageKey);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const migrated = migrateSchema(parsed);
    state.profile = migrated.profile;
    state.subjects = migrated.subjects;
    state.attendance = migrated.attendance;
    state.timetable = migrated.timetable;

    return Boolean(state.profile);
  } catch (error) {
    console.warn('Corrupted or invalid data in localStorage. Starting fresh.', error);
    return false;
  }
};

const applyPayload = (payload) => {
  const migrated = migrateSchema(payload);
  state.profile = migrated.profile;
  state.subjects = migrated.subjects;
  state.attendance = migrated.attendance;
  state.timetable = migrated.timetable;
  return migrated;
};

const loadCloudData = async () => {
  if (!currentUser || !supabaseClient) return;
  const localRaw = localStorage.getItem(activeStorageKey);
  const { data: row, error } = await supabaseClient
    .from('user_data')
    .select('data, updated_at')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (error) {
    console.warn('Unable to load cloud data.', error);
    setSyncStatus('Offline, will sync later');
    return;
  }
  if (!row) {
    const legacyRaw = localStorage.getItem(storageKey);
    if (legacyRaw && legacyRaw !== localRaw && window.confirm('Import your existing browser data into this account?')) {
      try {
        applyPayload(JSON.parse(legacyRaw));
        saveAppData();
      } catch (error) {
        console.warn('Unable to import existing browser data.', error);
      }
    } else {
      await syncToCloud();
    }
    return;
  }
  let cloudPayload;
  try {
    cloudPayload = migrateSchema(row.data);
  } catch (error) {
    console.warn('Cloud data is invalid.', error);
    return;
  }
  const localUpdatedAt = localStorage.getItem(`${activeStorageKey}-updatedAt`);
  if (localRaw && localUpdatedAt && new Date(localUpdatedAt) > new Date(row.updated_at)) {
    localStorage.setItem(`${activeStorageKey}-cloud-backup-${Date.now()}`, JSON.stringify(cloudPayload));
    await syncToCloud();
    return;
  }
  if (localRaw) localStorage.setItem(`${activeStorageKey}-local-backup-${Date.now()}`, localRaw);
  applyPayload(cloudPayload);
  localStorage.setItem(activeStorageKey, JSON.stringify(getDataPayload()));
  localStorage.setItem(`${activeStorageKey}-updatedAt`, row.updated_at);
  setSyncStatus('Synced');
};

const loadProfileAndResources = async () => {
  if (!currentUser || !supabaseClient) return;
  state.libraryLoading = true;
  renderLibraryPage();
  const profileResult = await supabaseClient.from('profiles').select('user_id, name, role').eq('user_id', currentUser.id).maybeSingle();
  if (profileResult.error) console.warn('Unable to load library profile.', profileResult.error);
  if (profileResult.data) state.profile = { ...(state.profile || {}), ...profileResult.data };
  const resourcesResult = await supabaseClient.from('resources').select('*').order('created_at', { ascending: false });
  state.libraryLoading = false;
  if (resourcesResult.error) {
    state.libraryError = 'Unable to load resources. Please try again.';
    console.warn('Unable to load resources.', resourcesResult.error);
    return;
  }
  state.libraryError = '';
  state.resources = (resourcesResult.data || []).filter((resource) => resource.status === 'approved');
  state.myUploads = (resourcesResult.data || []).filter((resource) => resource.uploader_id === currentUser.id);
  if (['moderator', 'admin'].includes(state.profile?.role)) {
    const pendingResult = await supabaseClient.from('resources').select('*').eq('status', 'pending').order('created_at', { ascending: true });
    if (pendingResult.error) console.warn('Unable to load moderation queue.', pendingResult.error);
    state.moderationQueue = pendingResult.data || [];
  } else {
    state.moderationQueue = [];
  }
};

const sanitizeFileName = (name) => window.LibraryUtils.sanitizeFileName(name, crypto.randomUUID());
const validateResourceFile = (file) => window.LibraryUtils.validateResourceFile(file);

const handleResourceUpload = async (event) => {
  event.preventDefault();
  const feedback = document.getElementById('resourceUploadFeedback');
  const form = event.target;
  const file = form.file.files?.[0];
  if (!supabaseClient || !currentUser) return;
  if (!validateResourceFile(file)) {
    feedback.textContent = 'Choose a PDF file no larger than 10 MB.';
    feedback.className = 'feedback-msg error';
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());
  const path = `${currentUser.id}/${sanitizeFileName(file.name)}`;
  feedback.textContent = 'Uploading...';
  feedback.className = 'feedback-msg';
  const uploadResult = await supabaseClient.storage.from('resources').upload(path, file, { contentType: 'application/pdf', upsert: false });
  if (uploadResult.error) {
    feedback.textContent = `Upload failed: ${uploadResult.error.message}`;
    feedback.className = 'feedback-msg error';
    return;
  }
  const insertResult = await supabaseClient.from('resources').insert({
    title: values.title.toString().trim(),
    branch: values.branch.toString().trim(),
    year: values.year.toString().trim(),
    semester: values.semester.toString().trim(),
    subject: values.subject.toString().trim(),
    resource_type: values.resource_type,
    academic_year: values.academic_year.toString().trim(),
    file_path: path,
    file_size: file.size,
    uploader_id: currentUser.id,
    uploader_name: state.profile?.name || currentUser.email || 'Student',
    status: 'pending'
  });
  if (insertResult.error) {
    await supabaseClient.storage.from('resources').remove([path]);
    feedback.textContent = `Could not save upload: ${insertResult.error.message}`;
    feedback.className = 'feedback-msg error';
    return;
  }
  form.reset();
  feedback.textContent = 'Upload submitted for moderator review.';
  feedback.className = 'feedback-msg';
  await loadProfileAndResources();
  renderAllViews();
};

const openResource = async (resource) => {
  if (!supabaseClient || !resource) return;
  const result = await supabaseClient.storage.from('resources').createSignedUrl(resource.file_path, 60);
  if (result.error) {
    setLibraryStatus('Unable to open this PDF.', true);
    return;
  }
  window.open(result.data.signedUrl, '_blank', 'noopener,noreferrer');
};

const showAuthFeedback = (message, isError = true) => {
  const element = document.getElementById('authFeedback');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.remove('hidden');
};

const handleAuthSubmit = async (event) => {
  event.preventDefault();
  if (!supabaseClient) {
    showAuthFeedback('Cloud login is not configured yet. Add your Supabase URL and anon key in config.js.');
    return;
  }
  const formData = new FormData(event.target);
  const email = formData.get('email')?.toString().trim();
  const password = formData.get('password')?.toString();
  const action = event.submitter?.dataset.authAction || 'login';
  if (action !== 'forgot' && (!email || !password)) {
    showAuthFeedback('Enter your email and password.');
    return;
  }
  let result;
  if (action === 'signup') result = await supabaseClient.auth.signUp({ email, password });
  else if (action === 'forgot') result = await supabaseClient.auth.resetPasswordForEmail(email);
  else result = await supabaseClient.auth.signInWithPassword({ email, password });
  if (result.error) {
    showAuthFeedback(result.error.message);
    return;
  }
  showAuthFeedback(action === 'forgot' ? 'Password reset email sent.' : 'Check your email if confirmation is required.', false);
};

const showAuthenticatedApp = async (user) => {
  currentUser = user;
  activeStorageKey = `${storageKey}-${user.id}`;
  loadAppData();
  await loadCloudData();
  await loadProfileAndResources();
  document.getElementById('authScreen')?.classList.add('hidden');
  document.getElementById('logoutBtn')?.classList.remove('hidden');
  if (!state.profile) showOnboarding();
  populateSubjectOptions();
  renderAllViews();
};

const handleLogout = async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  activeStorageKey = storageKey;
  state.profile = null;
  state.subjects = [];
  state.attendance = [];
  state.timetable = [];
  state.resources = [];
  state.myUploads = [];
  state.moderationQueue = [];
  state.editingEntryId = null;
  document.getElementById('logoutBtn')?.classList.add('hidden');
  document.getElementById('authScreen')?.classList.remove('hidden');
  hideOnboarding();
  renderAllViews();
};

const initializeAuth = async () => {
  if (!supabaseClient) return false;
  document.getElementById('authForm')?.addEventListener('submit', handleAuthSubmit);
  document.querySelectorAll('[data-auth-action="signup"], [data-auth-action="forgot"]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('authForm')?.requestSubmit(button);
    });
  });
  document.getElementById('continueOfflineBtn')?.addEventListener('click', () => {
    document.getElementById('authScreen')?.classList.add('hidden');
    if (!state.profile) {
      showOnboarding();
    }
  });
  document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
  const { data } = await supabaseClient.auth.getSession();
  if (data.session?.user) {
    await showAuthenticatedApp(data.session.user);
  } else {
    document.getElementById('authScreen')?.classList.remove('hidden');
  }
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session?.user && !currentUser) showAuthenticatedApp(session.user);
  });
  return true;
};

const getSubjectById = (subjectId) => state.subjects.find((subject) => subject.id === subjectId);

const formatDate = (dateString) => {
  try {
    const date = parseLocalDate(dateString);
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  } catch {
    return dateString;
  }
};

const formatTitleCase = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');

const computeSubjectSummary = (subject) => {
  const { attended, absent, unsure, total, percentage, records } = getAttendanceCounts(
    state.attendance,
    subject.id
  );
  const classesToAttend = calculateClassesToAttend(Number(subject.target), attended, total);
  const classesCanMiss = calculateMissableClasses(Number(subject.target), attended, total);

  return {
    subject,
    records,
    attended,
    absent,
    unsure,
    total,
    percentage,
    classesToAttend,
    classesCanMiss
  };
};

const getOverallSummary = () => {
  const countedEntries = state.attendance.filter(
    (entry) => entry.status === 'present' || entry.status === 'absent'
  );
  const presentEntries = state.attendance.filter((entry) => entry.status === 'present').length;
  const overallPercentage = countedEntries.length
    ? calculateAttendancePercentage(presentEntries, countedEntries.length)
    : null;

  return {
    totalEntries: countedEntries.length,
    presentEntries,
    overallPercentage
  };
};

const getWeeklySummary = () => {
  const today = formatLocalDate();
  const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
    return shiftLocalDate(today, -(6 - index));
  });

  return lastSevenDays.map((day) => {
    const records = state.attendance.filter((entry) => entry.date === day);
    const present = records.filter((entry) => entry.status === 'present').length;
    const absent = records.filter((entry) => entry.status === 'absent').length;
    const unsure = records.filter((entry) => entry.status === 'unsure').length;
    let header = day;
    try {
      header = new Intl.DateTimeFormat('en-IN', { weekday: 'short' }).format(
        parseLocalDate(day)
      );
    } catch {
      // fallback
    }
    return { day, header, records, present, absent, unsure };
  });
};

const renderOverviewMetrics = () => {
  const overview = document.getElementById('overviewMetrics');
  if (!overview) return;

  const totalSubjects = state.subjects.length;
  const summary = getOverallSummary();
  const averageTarget = totalSubjects
    ? state.subjects.reduce((sum, subject) => sum + Number(subject.target || 0), 0) / totalSubjects
    : 0;
  const pendingReviews = state.moderationQueue.length;

  // Subjects with 0 counted lectures must NOT be counted as "at risk"
  const atRiskCount = state.subjects.filter((subject) => {
    const calc = computeSubjectSummary(subject);
    return calc.total > 0 && calc.percentage !== null && calc.percentage < subject.target;
  }).length;

  const overallText =
    summary.overallPercentage === null
      ? 'No data yet'
      : `${summary.overallPercentage.toFixed(1)}%`;
  const overallAxis =
    summary.totalEntries === 0
      ? '0 counted lectures'
      : `${summary.presentEntries}/${summary.totalEntries} lectures`;

  const cards = [
    {
      label: 'Overall attendance',
      value: overallText,
      axis: overallAxis
    },
    {
      label: 'Subjects tracked',
      value: totalSubjects,
      axis: totalSubjects ? `${averageTarget.toFixed(0)}% avg. target` : 'None yet'
    },
    {
      label: 'Classes at risk',
      value: atRiskCount,
      axis: 'Below target'
    },
    {
      label: 'Pending reviews',
      value: pendingReviews,
      axis: 'Moderator queue'
    }
  ];

  overview.innerHTML = cards
    .map(
      (card) => `
    <div class="panel stat-card">
      <span class="label">${card.label}</span>
      <div class="value">${card.value}</div>
      <div class="axis">${card.axis}</div>
    </div>
  `
    )
    .join('');
};

const renderDashboard = () => {
  const subjectCards = document.getElementById('subjectCards');
  const weeklySummary = document.getElementById('weeklySummary');
  const greetingEl = document.getElementById('dashboardGreeting');
  const studentMetaEl = document.getElementById('dashboardStudentMeta');
  const unsureBadge = document.getElementById('unsureBadge');

  if (greetingEl && state.profile) {
    greetingEl.textContent = `Welcome back, ${state.profile.name}`;
  }
  if (studentMetaEl && state.profile) {
    studentMetaEl.textContent = `${state.profile.branch || 'Student'} • ${
      state.profile.semester || ''
    }`;
  }

  // Dashboard Unsure Badge (Requirement 8)
  const totalUnsure = state.attendance.filter((entry) => entry.status === 'unsure').length;
  if (unsureBadge) {
    if (totalUnsure > 0) {
      unsureBadge.textContent = `${totalUnsure} ${
        totalUnsure === 1 ? 'entry needs' : 'entries need'
      } confirmation`;
      unsureBadge.classList.remove('hidden');
      unsureBadge.style.cursor = 'pointer';
      unsureBadge.title = 'Click to view Attendance tracker';
      unsureBadge.onclick = () => setActiveSection('attendance');
    } else {
      unsureBadge.classList.add('hidden');
    }
  }

  const summaries = state.subjects.map(computeSubjectSummary);
  // Sort subjects: defined percentages first (highest to lowest), zero records last
  const sorted = summaries.sort((a, b) => {
    if (a.percentage === null && b.percentage === null) return 0;
    if (a.percentage === null) return 1;
    if (b.percentage === null) return -1;
    return b.percentage - a.percentage;
  });

  if (subjectCards) {
    subjectCards.innerHTML = sorted.length
      ? `
      <div class="subject-cards">
        ${sorted
          .map(({ subject, attended, total, percentage, classesToAttend, classesCanMiss }) => {
            const hasData = total > 0 && percentage !== null;
            const badgeClass = !hasData
              ? 'neutral'
              : percentage >= subject.target
              ? 'neutral'
              : 'warning';
            const badgeText = !hasData
              ? 'No data yet'
              : percentage >= subject.target
              ? 'On track'
              : 'Needs focus';
            const percentDisplay = hasData ? `${percentage.toFixed(1)}%` : 'No data yet';
            const barWidth = hasData ? Math.min(percentage, 100) : 0;
            const attendMsg =
              classesToAttend === 'Not possible to recover'
                ? 'Not possible to recover'
                : `Attend ${classesToAttend} more`;

            return `
          <div class="subject-card">
            <div class="subject-top">
              <div>
                <div class="subject-name">${subject.name}</div>
                <div class="subject-meta">${subject.code ? `${subject.code} • ` : ''}${subject.target}% target</div>
              </div>
              <span class="badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="progress-wrap">
              <div class="progress-bar"><span style="width:${barWidth}%"></span></div>
              <div class="progress-row">
                <span>${percentDisplay}</span>
                <span>${hasData ? `${attended}/${total} counted` : '0 counted'}</span>
              </div>
            </div>
            <div class="subject-foot">
              <span>${hasData ? attendMsg : 'No lectures recorded'}</span>
              <span>${hasData ? `Miss ${classesCanMiss}` : `Target: ${subject.target}%`}</span>
            </div>
          </div>
        `;
          })
          .join('')}
      </div>
    `
      : '<div class="empty-state">No subjects yet. Add a subject from the Attendance tab to get started.</div>';
  }

  if (weeklySummary) {
    weeklySummary.innerHTML = getWeeklySummary()
      .map(
        (day) => `
      <div class="summary-day">
        <div>
          <strong>${day.header}</strong>
          <small>${day.present} present • ${day.absent} absent • ${day.unsure} unsure</small>
        </div>
        <span class="badge ${day.present >= day.absent ? 'neutral' : 'warning'}">${
          day.records.length || 0
        } entries</span>
      </div>
    `
      )
      .join('');
  }
};

const renderTodaySchedule = () => {
  const listContainer = document.getElementById('todaySlotsList');
  const countBadge = document.getElementById('todaySlotsCountBadge');
  const weekdayHeader = document.getElementById('todayWeekdayHeader');
  if (!listContainer) return;

  const todayStr = formatLocalDate();
  const todayWeekday = getLocalWeekday(todayStr);

  if (weekdayHeader) {
    weekdayHeader.textContent = `Today's Schedule (${formatTitleCase(todayWeekday)})`;
  }

  const todaySlots = state.timetable.filter((slot) => slot.day === todayWeekday);
  if (countBadge) {
    countBadge.textContent = `${todaySlots.length} ${
      todaySlots.length === 1 ? 'class' : 'classes'
    }`;
  }

  if (!todaySlots.length) {
    listContainer.innerHTML = `<div class="empty-state">No lectures scheduled for ${formatTitleCase(
      todayWeekday
    )}. Add timetable slots from the Attendance tab.</div>`;
    return;
  }

  listContainer.innerHTML = todaySlots
    .map((slot) => {
      const subject = getSubjectById(slot.subjectId);
      const subjectName = subject ? subject.name : 'Unknown subject';
      const record = state.attendance.find(
        (entry) => entry.subjectId === slot.subjectId && entry.date === todayStr
      );
      const status = record ? record.status : 'unrecorded';
      const statusLabel =
        status === 'unrecorded' ? 'Not recorded yet' : formatTitleCase(status);

      return `
      <div class="today-slot-card" data-slot-id="${slot.id}" data-subject-id="${slot.subjectId}">
        <div class="today-slot-top">
          <div>
            <div class="slot-subject-name">${subjectName}</div>
            <div class="slot-time">${slot.time || 'Class scheduled for today'}</div>
          </div>
          <span class="status-pill ${status}">${statusLabel}</span>
        </div>
        <div class="slot-status-actions">
          <button class="action-btn quick-present mark-slot-present" data-action="slot-present" data-subject-id="${slot.subjectId}">Present</button>
          <button class="action-btn quick-absent mark-slot-absent" data-action="slot-absent" data-subject-id="${slot.subjectId}">Absent</button>
          <button class="action-btn secondary mark-slot-cancelled" data-action="slot-cancelled" data-subject-id="${slot.subjectId}">Cancelled</button>
        </div>
      </div>
    `;
    })
    .join('');
};

const renderPendingLectures = () => {
  const pendingContainer = document.getElementById('pendingList');
  const countBadge = document.getElementById('pendingCountBadge');
  const alertBadge = document.getElementById('pendingAlertBadge');
  if (!pendingContainer) return;

  const todayStr = formatLocalDate();
  const onboardingDate = state.profile?.onboardingDate || null;

  const { groups, totalCount } = getPendingLectures({
    timetable: state.timetable,
    attendance: state.attendance,
    onboardingDate,
    todayStr,
    daysBack: 7
  });

  if (countBadge) {
    if (totalCount > 0) {
      countBadge.textContent = `${totalCount} ${totalCount === 1 ? 'lecture' : 'lectures'} pending`;
      countBadge.classList.remove('hidden');
    } else {
      countBadge.textContent = '0 pending';
      countBadge.classList.add('hidden');
    }
  }

  if (alertBadge) {
    if (totalCount > 0) {
      alertBadge.textContent = `${totalCount} ${totalCount === 1 ? 'lecture' : 'lectures'} pending`;
      alertBadge.classList.remove('hidden');
      alertBadge.style.cursor = 'pointer';
      alertBadge.onclick = () => {
        setActiveSection('dashboard');
        document.getElementById('pendingSection')?.scrollIntoView();
      };
    } else {
      alertBadge.classList.add('hidden');
    }
  }

  if (!groups.length) {
    pendingContainer.innerHTML =
      '<div class="empty-state">No pending unmarked lectures in the past 7 days. You are all caught up!</div>';
    return;
  }

  pendingContainer.innerHTML = groups
    .map((group) => `
      <div class="pending-date-group" data-date="${group.dateStr}">
        <div class="pending-group-head">
          <div>
            <h4 class="pending-date-title">${formatDate(group.dateStr)} (${formatTitleCase(group.weekday)})</h4>
            <span class="muted-note">${group.items.length} ${group.items.length === 1 ? 'lecture' : 'lectures'}</span>
          </div>
          <div class="button-row">
            <button type="button" class="action-btn quick-present mark-all-present-btn" data-action="mark-all-present" data-date="${group.dateStr}">Mark all as Present</button>
            <button type="button" class="action-btn secondary mark-all-cancelled-btn" data-action="mark-all-cancelled" data-date="${group.dateStr}">Mark all as Cancelled</button>
          </div>
        </div>
        <div class="pending-items">
          ${group.items
            .map((item) => {
              const subject = getSubjectById(item.subjectId);
              const subjectName = subject ? subject.name : 'Unknown subject';
              return `
                <div class="pending-slot-card" data-slot-id="${item.slot.id}" data-subject-id="${item.subjectId}" data-date="${group.dateStr}">
                  <div>
                    <div class="slot-subject-name">${subjectName}</div>
                    <div class="slot-time">${item.slot.time || 'Scheduled lecture'}</div>
                  </div>
                  <div class="slot-status-actions">
                    <button type="button" class="action-btn quick-present" data-action="pending-present" data-subject-id="${item.subjectId}" data-date="${group.dateStr}">Present</button>
                    <button type="button" class="action-btn quick-absent" data-action="pending-absent" data-subject-id="${item.subjectId}" data-date="${group.dateStr}">Absent</button>
                    <button type="button" class="action-btn secondary" data-action="pending-cancelled" data-subject-id="${item.subjectId}" data-date="${group.dateStr}">Cancelled</button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `)
    .join('');
};

const renderAttendanceInsights = () => {
  const container = document.getElementById('attendanceInsights');
  if (!container) return;

  const insights = state.subjects.map((subject) => {
    const summary = computeSubjectSummary(subject);
    const hasData = summary.total > 0 && summary.percentage !== null;
    const statusText = !hasData
      ? 'No data yet'
      : summary.percentage >= subject.target
      ? 'On target'
      : 'Below target';
    const badgeClass = !hasData
      ? 'neutral'
      : summary.percentage >= subject.target
      ? 'neutral'
      : 'warning';
    const percentDisplay = hasData ? `${summary.percentage.toFixed(1)}%` : 'No data yet';
    const barWidth = hasData ? Math.min(summary.percentage, 100) : 0;
    const attendMsg =
      summary.classesToAttend === 'Not possible to recover'
        ? 'Unrecoverable'
        : summary.classesToAttend;

    return `
      <div class="insight-item">
        <div class="insight-head">
          <strong>${subject.name}</strong>
          <span class="badge ${badgeClass}">${statusText}</span>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar"><span style="width:${barWidth}%"></span></div>
          <div class="progress-row">
            <span>${percentDisplay}</span>
            <span>${subject.target}% target</span>
          </div>
        </div>
        <div class="stat-pair">
          <div class="stat-box"><small>Attended</small><strong>${summary.attended}</strong></div>
          <div class="stat-box"><small>Counted</small><strong>${summary.total}</strong></div>
          <div class="stat-box"><small>Not sure</small><strong>${summary.unsure}</strong></div>
          <div class="stat-box"><small>Attend next</small><strong>${hasData ? attendMsg : 0}</strong></div>
          <div class="stat-box"><small>Can miss</small><strong>${hasData ? summary.classesCanMiss : 0}</strong></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = insights.length
    ? insights.join('')
    : '<div class="empty-state">No subjects yet. Add a subject to see attendance insights.</div>';
};

const renderAttendanceHistory = () => {
  const container = document.getElementById('attendanceHistory');
  if (!container) return;

  const sortedRecords = [...state.attendance].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  if (!sortedRecords.length) {
    container.innerHTML =
      '<div class="empty-state">No lecture records yet. Add a subject and record your first class.</div>';
    return;
  }

  container.innerHTML = sortedRecords
    .map((entry) => {
      const subject = getSubjectById(entry.subjectId);
      const subjectName = subject ? subject.name : 'Unknown subject';
      const isUnsure = entry.status === 'unsure';

      return `
      <div class="history-item">
        <div class="history-meta">
          <strong>${subjectName}</strong>
          <span>${formatDate(entry.date)}</span>
        </div>
        <div class="button-row">
          <span class="status-pill ${entry.status}">${formatTitleCase(entry.status)}</span>
          ${
            isUnsure
              ? `
            <button class="action-btn quick-present" data-action="quick-present" data-entry-id="${entry.id}">Mark Present</button>
            <button class="action-btn quick-absent" data-action="quick-absent" data-entry-id="${entry.id}">Mark Absent</button>
          `
              : ''
          }
          <button class="action-btn secondary edit-entry" data-entry-id="${entry.id}">Edit</button>
          <button class="action-btn warn delete-entry" data-entry-id="${entry.id}">Remove</button>
        </div>
      </div>
    `;
    })
    .join('');
};

const populateSubjectOptions = () => {
  const lectureSelect = document.getElementById('lectureSubject');
  const timetableSelect = document.getElementById('timetableSubject');

  const optionsHtml = state.subjects.length
    ? state.subjects
        .map((subject) => `<option value="${subject.id}">${subject.name}</option>`)
        .join('')
    : '<option value="" selected disabled>Add a subject first</option>';

  if (lectureSelect) lectureSelect.innerHTML = optionsHtml;
  if (timetableSelect) timetableSelect.innerHTML = optionsHtml;
};

const updateEditFormState = () => {
  const cancelButton = document.getElementById('cancelEditBtn');
  const form = document.getElementById('attendanceForm');
  if (!form || !cancelButton) return;

  if (state.editingEntryId) {
    cancelButton.classList.remove('hidden');
    form.querySelector('button[type="submit"]').textContent = 'Update entry';
  } else {
    cancelButton.classList.add('hidden');
    form.querySelector('button[type="submit"]').textContent = 'Save entry';
  }
};

const renderAttendancePage = () => {
  renderAttendanceInsights();
  renderAttendanceHistory();
  updateEditFormState();
};

const renderLibraryFilters = () => {
  const branchFilter = document.getElementById('branchFilter');
  const yearFilter = document.getElementById('yearFilter');
  const semesterFilter = document.getElementById('semesterFilter');
  const typeFilter = document.getElementById('typeFilter');
  const subjectFilter = document.getElementById('subjectFilter');

  if (!branchFilter || !yearFilter || !semesterFilter || !typeFilter || !subjectFilter) return;

  const fill = (select, label, values) => {
    const current = select.value;
    select.replaceChildren(new Option(label, 'all'));
    [...new Set(values.filter(Boolean))].sort().forEach((value) => select.add(new Option(value, value)));
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  };
  fill(branchFilter, 'All branches', state.resources.map((resource) => resource.branch));
  fill(yearFilter, 'All years', state.resources.map((resource) => resource.year));
  fill(semesterFilter, 'All semesters', state.resources.map((resource) => resource.semester));
  fill(typeFilter, 'All types', state.resources.map((resource) => resource.resource_type));
  fill(subjectFilter, 'All subjects', state.resources.map((resource) => resource.subject));
};

const setLibraryStatus = (message, isError = false) => {
  const status = document.getElementById('libraryStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.toggle('hidden', !message);
};

const appendText = (parent, tag, text, className) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text || '';
  parent.appendChild(element);
  return element;
};

const resourceTypeLabel = (type) => ({
  syllabus: 'Syllabus',
  pyq: 'Previous year question paper',
  lab_manual: 'Lab manual',
  notes: 'Notes',
  assignment: 'Assignment'
}[type] || type);

const addOpenButton = (parent, resource) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-btn secondary';
  button.textContent = 'Open PDF';
  button.dataset.resourceId = resource.id;
  button.dataset.action = 'open-resource';
  parent.appendChild(button);
};

const renderLibraryPage = () => {
  const container = document.getElementById('libraryGrid');
  const searchEl = document.getElementById('librarySearch');
  if (!container || !searchEl) return;
  container.replaceChildren();
  if (state.libraryLoading) {
    appendText(container, 'div', 'Loading approved resources...', 'empty-state');
    return;
  }
  if (state.libraryError) {
    appendText(container, 'div', state.libraryError, 'empty-state');
    return;
  }

  const searchValue = searchEl.value.trim().toLowerCase();
  const branchValue = document.getElementById('branchFilter')?.value || 'all';
  const yearValue = document.getElementById('yearFilter')?.value || 'all';
  const semesterValue = document.getElementById('semesterFilter')?.value || 'all';
  const typeValue = document.getElementById('typeFilter')?.value || 'all';
  const subjectValue = document.getElementById('subjectFilter')?.value || 'all';

  const filtered = state.resources.filter((resource) => {
    const matchQuery =
      !searchValue ||
      `${resource.title} ${resource.subject} ${resource.academic_year} ${resource.uploader_name}`
        .toLowerCase()
        .includes(searchValue);
    const matchBranch = branchValue === 'all' || resource.branch === branchValue;
    const matchYear = yearValue === 'all' || resource.year === yearValue;
    const matchSemester = semesterValue === 'all' || resource.semester === semesterValue;
    const matchType = typeValue === 'all' || resource.resource_type === typeValue;
    const matchSubject = subjectValue === 'all' || resource.subject === subjectValue;
    return matchQuery && matchBranch && matchYear && matchSemester && matchType && matchSubject;
  });

  if (!filtered.length) {
    appendText(container, 'div', 'No approved resources found. Try broadening your filters.', 'empty-state');
    return;
  }

  filtered.forEach((resource) => {
    const card = document.createElement('article');
    card.className = 'resource-card';
    appendText(card, 'h4', resource.title);
    appendText(card, 'div', `${resource.subject} • ${resource.academic_year}`, 'resource-meta');
    appendText(card, 'div', `${resource.branch} • ${resource.year} • ${resource.semester}`, 'resource-meta');
    const badges = document.createElement('div');
    badges.className = 'resource-badges';
    appendText(badges, 'span', resourceTypeLabel(resource.resource_type), 'badge');
    appendText(badges, 'span', 'Verified', 'badge success');
    card.appendChild(badges);
    appendText(card, 'div', `Uploaded by ${resource.uploader_name} • ${formatDate(resource.created_at)}`, 'resource-meta');
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    addOpenButton(actions, resource);
    card.appendChild(actions);
    container.appendChild(card);
  });
};

const renderAdminStats = () => {
  const container = document.getElementById('adminStats');
  if (!container) return;
  container.replaceChildren();
  [{ label: 'Approved', value: state.resources.length }, { label: 'Pending review', value: state.resources.filter((item) => item.status === 'pending').length }]
    .forEach((item) => {
      const card = document.createElement('div');
      card.className = 'admin-stat-card';
      appendText(card, 'div', item.label, 'label');
      appendText(card, 'div', String(item.value), 'value');
      container.appendChild(card);
    });
};

const renderAdminQueue = () => {
  const container = document.getElementById('adminQueue');
  if (!container) return;
  container.replaceChildren();
  if (!['moderator', 'admin'].includes(state.profile?.role)) return;
  const pending = state.moderationQueue.filter((resource) => resource.uploader_id !== currentUser?.id);

  if (!pending.length) {
    appendText(container, 'div', 'Queue is clear. No pending uploads to review.', 'empty-state');
    return;
  }
  pending.forEach((resource) => {
    const item = document.createElement('div');
    item.className = 'admin-item';
    appendText(item, 'h3', resource.title);
    appendText(item, 'div', `${resource.subject} • ${resourceTypeLabel(resource.resource_type)} • ${resource.academic_year}`, 'admin-item-meta');
    appendText(item, 'div', `Submitted by: ${resource.uploader_name} • ${resource.branch} • ${resource.semester}`, 'admin-item-meta');
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    addOpenButton(actions, resource);
    const approve = document.createElement('button');
    approve.className = 'action-btn';
    approve.textContent = 'Approve';
    approve.dataset.action = 'approve';
    approve.dataset.resourceId = resource.id;
    actions.appendChild(approve);
    const reject = document.createElement('button');
    reject.className = 'action-btn warn';
    reject.textContent = 'Reject';
    reject.dataset.action = 'reject';
    reject.dataset.resourceId = resource.id;
    actions.appendChild(reject);
    item.appendChild(actions);
    container.appendChild(item);
  });
};

const renderMyUploads = () => {
  const container = document.getElementById('myUploadsList');
  if (!container) return;
  container.replaceChildren();
  if (!state.myUploads.length) {
    appendText(container, 'div', 'You have not uploaded any resources yet.', 'empty-state');
    return;
  }
  state.myUploads.forEach((resource) => {
    const item = document.createElement('div');
    item.className = 'admin-item';
    appendText(item, 'h3', resource.title);
    appendText(item, 'div', `${resource.subject} • ${resourceTypeLabel(resource.resource_type)}`, 'admin-item-meta');
    appendText(item, 'span', resource.status === 'rejected' ? `Rejected: ${resource.reject_reason || 'No reason provided'}` : formatTitleCase(resource.status), `badge ${resource.status === 'approved' ? 'success' : resource.status === 'rejected' ? 'warning' : ''}`);
    if (resource.status !== 'rejected') addOpenButton(item, resource);
    container.appendChild(item);
  });
};

const updateModerationVisibility = () => {
  const allowed = ['moderator', 'admin'].includes(state.profile?.role);
  document.querySelectorAll('[data-section="admin"]').forEach((button) => button.classList.toggle('hidden', !allowed));
  const adminPage = document.getElementById('admin');
  if (adminPage) adminPage.classList.toggle('hidden', !allowed);
  if (!allowed && state.currentSection === 'admin') setActiveSection('dashboard');
};

const renderProfilePage = () => {
  if (!state.profile) return;

  const avatar = document.getElementById('profileAvatar');
  const nameDisplay = document.getElementById('profileNameDisplay');
  const branchDisplay = document.getElementById('profileBranchDisplay');
  const semDisplay = document.getElementById('profileSemesterDisplay');
  const nameInput = document.getElementById('profileEditName');
  const branchInput = document.getElementById('profileEditBranch');
  const semInput = document.getElementById('profileEditSemester');

  // Compute initials
  const initials = state.profile.name
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'ST';

  if (avatar) avatar.textContent = initials;
  if (nameDisplay) nameDisplay.textContent = state.profile.name;
  if (branchDisplay) branchDisplay.textContent = state.profile.branch || 'Not specified';
  if (semDisplay) semDisplay.textContent = state.profile.semester || 'Not specified';

  if (nameInput) nameInput.value = state.profile.name;
  if (branchInput) branchInput.value = state.profile.branch || '';
  if (semInput) semInput.value = state.profile.semester || '';
};

const setActiveSection = (sectionName) => {
  if (sectionName === 'admin' && !['moderator', 'admin'].includes(state.profile?.role)) {
    sectionName = 'dashboard';
  }
  state.currentSection = sectionName;
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === sectionName);
  });

  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === sectionName);
  });
};

const handleFormSubmit = (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const subjectName = formData.get('subjectName')?.toString().trim();
  const targetValue = Number(formData.get('target'));

  if (subjectName) {
    const newSubject = {
      id: `subject-${Date.now()}`,
      name: subjectName,
      target: targetValue,
      branch: state.profile?.branch || 'General',
      semester: state.profile?.semester || 'Semester 1',
      code: formData.get('subjectCode')?.toString().trim() || ''
    };
    state.subjects.push(newSubject);
    saveAppData();
    populateSubjectOptions();
    event.target.reset();
  }

  renderOverviewMetrics();
  renderDashboard();
  renderAttendancePage();
  renderLibraryFilters();
};

const handleLectureSubmit = (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const subjectId = formData.get('subjectId');
  const lectureDate = formData.get('date');
  const status = formData.get('status');

  if (!subjectId || !lectureDate || !status) {
    return;
  }

  if (state.editingEntryId) {
    const entry = state.attendance.find((record) => record.id === state.editingEntryId);
    if (entry) {
      entry.subjectId = subjectId;
      entry.date = lectureDate;
      entry.status = status;
    }
    state.editingEntryId = null;
  } else {
    state.attendance.push({
      id: `rec-${Date.now()}`,
      subjectId,
      date: lectureDate,
      status
    });
  }

  saveAppData();
  event.target.reset();
  populateSubjectOptions();
  renderAllViews();
};

const handleTimetableSubmit = (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const subjectId = formData.get('subjectId');
  const day = formData.get('day')?.toString().toLowerCase();
  const time = formData.get('time')?.toString().trim();

  if (!subjectId || !day) return;

  const today = formatLocalDate();
  const todayWeekday = getLocalWeekday(today);
  let createdAt = formData.get('createdAt')?.toString().trim();
  if (!createdAt) {
    if (day === todayWeekday) {
      createdAt = today;
    } else {
      let matchedPastDate = null;
      for (let i = 1; i <= 7; i++) {
        const pastDate = shiftLocalDate(today, -i);
        if (getLocalWeekday(pastDate) === day) {
          matchedPastDate = pastDate;
          break;
        }
      }
      createdAt = matchedPastDate || today;
    }
  }

  state.timetable.push({
    id: `slot-${Date.now()}`,
    subjectId,
    day,
    time: time || '',
    createdAt
  });

  saveAppData();
  event.target.reset();
  renderAllViews();
};

const handleTodaySlotAction = (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const subjectId = btn.dataset.subjectId;
  if (!subjectId) return;

  let newStatus = 'present';
  if (action === 'slot-present') newStatus = 'present';
  else if (action === 'slot-absent') newStatus = 'absent';
  else if (action === 'slot-cancelled') newStatus = 'cancelled';
  else return;

  const todayStr = formatLocalDate();
  state.attendance = markSlotAttendance(state.attendance, subjectId, todayStr, newStatus);

  saveAppData();
  renderAllViews();
};

const handlePendingAction = (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const dateStr = btn.dataset.date;
  if (!action || !dateStr) return;

  if (action === 'mark-all-present' || action === 'mark-all-cancelled') {
    const status = action === 'mark-all-present' ? 'present' : 'cancelled';
    const todayStr = formatLocalDate();
    const onboardingDate = state.profile?.onboardingDate || null;
    const { groups } = getPendingLectures({
      timetable: state.timetable,
      attendance: state.attendance,
      onboardingDate,
      todayStr,
      daysBack: 7
    });
    const group = groups.find((g) => g.dateStr === dateStr);
    if (group && group.items) {
      group.items.forEach((item) => {
        state.attendance = markSlotAttendance(state.attendance, item.subjectId, dateStr, status);
      });
      saveAppData();
      renderAllViews();
    }
    return;
  }

  const subjectId = btn.dataset.subjectId;
  if (!subjectId) return;

  let status = 'present';
  if (action === 'pending-present') status = 'present';
  else if (action === 'pending-absent') status = 'absent';
  else if (action === 'pending-cancelled') status = 'cancelled';
  else return;

  state.attendance = markSlotAttendance(state.attendance, subjectId, dateStr, status);
  saveAppData();
  renderAllViews();
};

const handleHistoryClick = (event) => {
  const quickBtn = event.target.closest('[data-action="quick-present"], [data-action="quick-absent"]');
  if (quickBtn) {
    const entryId = quickBtn.dataset.entryId;
    const action = quickBtn.dataset.action;
    const entry = state.attendance.find((record) => record.id === entryId);
    if (entry) {
      entry.status = action === 'quick-present' ? 'present' : 'absent';
      saveAppData();
      renderAllViews();
    }
    return;
  }

  const target = event.target.closest('.edit-entry, .delete-entry');
  if (!target) {
    return;
  }

  const entryId = target.dataset.entryId;
  if (target.classList.contains('delete-entry')) {
    state.attendance = state.attendance.filter((record) => record.id !== entryId);
    if (state.editingEntryId === entryId) {
      state.editingEntryId = null;
    }
    saveAppData();
    renderAllViews();
    return;
  }

  const entry = state.attendance.find((record) => record.id === entryId);
  if (!entry) {
    return;
  }

  state.editingEntryId = entryId;
  const attendanceForm = document.getElementById('attendanceForm');
  if (attendanceForm) {
    attendanceForm.subjectId.value = entry.subjectId;
    attendanceForm.date.value = entry.date;
    attendanceForm.status.value = entry.status;
  }
  updateEditFormState();
  window.scrollTo({ top: 0 });
};

const handleCancelEdit = () => {
  state.editingEntryId = null;
  const attendanceForm = document.getElementById('attendanceForm');
  if (attendanceForm) {
    attendanceForm.reset();
  }
  updateEditFormState();
};

const handleResourceAction = async (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) {
    return;
  }

  const resourceId = actionButton.dataset.resourceId;
  const action = actionButton.dataset.action;
  const resource = [...state.resources, ...state.myUploads, ...state.moderationQueue].find((item) => item.id === resourceId);
  if (!resource) {
    return;
  }
  if (action === 'open-resource') {
    await openResource(resource);
    return;
  }
  if (!['moderator', 'admin'].includes(state.profile?.role) || resource.uploader_id === currentUser?.id) return;
  const update = { status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: currentUser.id };
  if (action === 'reject') {
    const reason = window.prompt('Reason for rejection:');
    if (!reason || !reason.trim()) return;
    update.reject_reason = reason.trim();
  } else {
    update.reject_reason = null;
  }
  const result = await supabaseClient.from('resources').update(update).eq('id', resource.id).eq('status', 'pending');
  if (result.error) {
    setLibraryStatus(`Could not update resource: ${result.error.message}`, true);
    return;
  }
  await loadProfileAndResources();
  renderAllViews();
};

// Profile form updates
const handleProfileFormSubmit = (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const name = formData.get('name')?.toString().trim();
  const branch = formData.get('branch')?.toString().trim();
  const semester = formData.get('semester')?.toString().trim();

  if (!name) return;

  state.profile = { ...state.profile, name, branch, semester };
  saveAppData();
  renderProfilePage();
  renderDashboard();

  const feedback = document.getElementById('profileFeedback');
  if (feedback) {
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 2500);
  }
};

// Reset all user data
const handleResetData = () => {
  const confirmed = window.confirm(
    'Are you sure you want to reset all your data? This will permanently delete your profile, subjects, and all attendance logs from this browser.'
  );

  if (!confirmed) return;

  try {
    localStorage.removeItem(activeStorageKey);
  } catch (e) {
    console.warn(e);
  }

  state.profile = null;
  state.subjects = [];
  state.attendance = [];
  state.timetable = [];
  state.editingEntryId = null;

  saveAppData();
  if (currentUser && supabaseClient) syncToCloud();
  showOnboarding();
  renderAllViews();
};

// Export user data as JSON file
const handleExportData = () => {
  try {
    const payload = {
      app: 'Campus Companion',
      version: 1,
      exportedAt: formatLocalDate(),
      profile: state.profile,
      subjects: state.subjects,
      attendance: state.attendance,
      timetable: state.timetable
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = `campus-companion-data-${formatLocalDate()}.json`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);

    showDataFeedback('Data exported successfully!', false);
  } catch (error) {
    showDataFeedback('Could not export data: ' + error.message, true);
  }
};

// Import user data from JSON file with validation
const handleImportData = (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target?.result;
      const parsed = JSON.parse(content);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('File does not contain valid JSON.');
      }

      const migrated = migrateSchema(parsed);
      if (!migrated.profile) {
        throw new Error('Missing student profile in backup file.');
      }

      state.profile = migrated.profile;
      state.subjects = migrated.subjects;
      state.attendance = migrated.attendance;
      state.timetable = migrated.timetable;

      saveAppData();
      hideOnboarding();
      populateSubjectOptions();
      renderAllViews();
      showDataFeedback('Data imported successfully!', false);
    } catch (err) {
      showDataFeedback('Import failed: ' + err.message, true);
    } finally {
      event.target.value = '';
    }
  };
  reader.onerror = () => {
    showDataFeedback('Error reading backup file.', true);
    event.target.value = '';
  };
  reader.readAsText(file);
};

const showDataFeedback = (msg, isError = false) => {
  const feedback = document.getElementById('dataFeedback');
  if (!feedback) return;
  feedback.textContent = msg;
  feedback.className = `feedback-msg ${isError ? 'error' : ''}`;
  feedback.classList.remove('hidden');
  setTimeout(() => feedback.classList.add('hidden'), 4000);
};

// Onboarding modal controls
const showOnboarding = () => {
  const modal = document.getElementById('onboardingModal');
  if (modal) modal.classList.remove('hidden');
};

const hideOnboarding = () => {
  const modal = document.getElementById('onboardingModal');
  if (modal) modal.classList.add('hidden');
};

const handleOnboardingSubmit = (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const name = formData.get('name')?.toString().trim();
  const branch = formData.get('branch')?.toString().trim();
  const semester = formData.get('semester')?.toString().trim();
  const subjectName = formData.get('subjectName')?.toString().trim();
  const subjectCode = formData.get('subjectCode')?.toString().trim();
  const target = Number(formData.get('target') || 75);

  if (!name || !subjectName) return;

  // Set onboardingDate to current week window so student can track past 7 days lectures
  const today = formatLocalDate();
  const defaultOnboardingDate = shiftLocalDate(today, -7);

  state.profile = {
    ...state.profile,
    name,
    branch,
    semester,
    onboardingDate: defaultOnboardingDate
  };
  const firstSubject = {
    id: `subject-${Date.now()}`,
    name: subjectName,
    code: subjectCode || '',
    target: target || 75,
    branch,
    semester
  };
  state.subjects = [firstSubject];
  state.attendance = [];
  state.timetable = [];

  saveAppData();
  hideOnboarding();
  populateSubjectOptions();
  renderAllViews();
};

const renderAllViews = () => {
  renderOverviewMetrics();
  renderDashboard();
  renderTodaySchedule();
  renderPendingLectures();
  renderAttendancePage();
  renderLibraryFilters();
  renderLibraryPage();
  renderMyUploads();
  renderAdminStats();
  renderAdminQueue();
  updateModerationVisibility();
  renderProfilePage();
};

const attachEventListeners = () => {
  // Navigation listeners
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setActiveSection(button.dataset.section));
  });

  // Attendance, Timetable & Subjects listeners
  document.getElementById('subjectForm')?.addEventListener('submit', handleFormSubmit);
  document.getElementById('timetableForm')?.addEventListener('submit', handleTimetableSubmit);
  document.getElementById('todaySlotsList')?.addEventListener('click', handleTodaySlotAction);
  document.getElementById('pendingList')?.addEventListener('click', handlePendingAction);
  document.getElementById('attendanceForm')?.addEventListener('submit', handleLectureSubmit);
  document.getElementById('cancelEditBtn')?.addEventListener('click', handleCancelEdit);
  document.getElementById('attendanceHistory')?.addEventListener('click', handleHistoryClick);

  // Onboarding listener
  document.getElementById('onboardingForm')?.addEventListener('submit', handleOnboardingSubmit);

  // Profile listeners
  document.getElementById('profileEditForm')?.addEventListener('submit', handleProfileFormSubmit);
  document.getElementById('resetDataBtn')?.addEventListener('click', handleResetData);
  document.getElementById('exportDataBtn')?.addEventListener('click', handleExportData);
  document.getElementById('importFileInput')?.addEventListener('change', handleImportData);

  // Library & Admin listeners
  document.getElementById('adminQueue')?.addEventListener('click', handleResourceAction);
  document.getElementById('libraryGrid')?.addEventListener('click', handleResourceAction);
  document.getElementById('myUploadsList')?.addEventListener('click', handleResourceAction);
  document.getElementById('resourceUploadForm')?.addEventListener('submit', handleResourceUpload);
  document.getElementById('librarySearch')?.addEventListener('input', renderLibraryPage);
  document.getElementById('branchFilter')?.addEventListener('change', renderLibraryPage);
  document.getElementById('yearFilter')?.addEventListener('change', renderLibraryPage);
  document.getElementById('semesterFilter')?.addEventListener('change', renderLibraryPage);
  document.getElementById('typeFilter')?.addEventListener('change', renderLibraryPage);
  document.getElementById('subjectFilter')?.addEventListener('change', renderLibraryPage);

  // Default date in attendance form
  const dateInput = document.getElementById('lectureDate');
  if (dateInput) {
    dateInput.value = formatLocalDate();
  }

  // Register service worker on https or localhost
  if (
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1')
  ) {
    try {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    } catch (err) {
      console.warn('Service worker error:', err);
    }
  }
};

const initialize = async () => {
  attachEventListeners();
  setActiveSection('dashboard');
  const hasData = loadAppData();
  populateSubjectOptions();
  renderAllViews();

  const authEnabled = await initializeAuth();
  if (authEnabled && !currentUser) {
    return;
  }

  if (!hasData || !state.profile) {
    showOnboarding();
  } else {
    hideOnboarding();
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initialize();
  });
  window.addEventListener('online', () => {
    if (currentUser) syncToCloud();
  });
}
