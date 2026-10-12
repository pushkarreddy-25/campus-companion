const fs = require('fs');
const http = require('http');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('FLOW CHECK FAILED: Playwright is required. Install it with npm install --no-save playwright.');
  process.exitCode = 1;
}

if (chromium) {
  const root = __dirname;
  const mimeTypes = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  const server = http.createServer((request, response) => {
    const requested = request.url.split('?')[0];
    const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });

  const mockSupabase = `
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null }),
          signInWithPassword: async () => ({ data: null, error: null }),
          signUp: async () => ({ data: null, error: null }),
          resetPasswordForEmail: async () => ({ data: null, error: null })
        },
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), order: async () => ({ data: [], error: null }) }),
          upsert: async () => ({ data: null, error: null }),
          insert: async () => ({ data: null, error: null })
        }),
        storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) }
      })
    };
  `;

  const checks = [];
  const check = (name, condition, reason) => {
    const passed = Boolean(condition);
    checks.push({ name, passed, reason: passed ? 'passed' : reason });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name} - ${passed ? 'passed' : reason}`);
  };

  const waitForServer = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const closeServer = () => new Promise((resolve) => server.close(resolve));
  const text = (page, selector) => page.locator(selector).innerText();
  const visible = (page, selector) => page.locator(selector).isVisible();
  const todayAndYesterday = async (page) => page.evaluate(() => {
    const today = new Date();
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return {
      today: names[today.getDay()],
      yesterday: names[yesterday.getDay()]
    };
  });

  const runAtWidth = async (browser, address, width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true });
    const browserErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => browserErrors.push(`uncaught: ${error.message}`));
    await page.route('**/vendor/supabase-2.117.3.js', (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: mockSupabase
    }));
    page.setDefaultTimeout(5000);
    await page.goto(`${address}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const prefix = `${width}px`;
    const runCheck = async (name, operation) => {
      try {
        await operation();
        check(`${prefix} ${name}`, true);
      } catch (error) {
        check(`${prefix} ${name}`, false, error.message);
      }
    };

    await runCheck('onboarding completes and dashboard shows', async () => {
      await page.locator('#continueOfflineBtn').click();
      await page.locator('#onboardingName').fill('Flow Student');
      await page.locator('#onboardingBranch').fill('Computer Science');
      await page.locator('#onboardingSemester').fill('Semester 4');
      await page.locator('#onboardingSubjectName').fill('Flow Subject');
      await page.locator('#onboardingSubjectCode').fill('FLOW101');
      await page.locator('#onboardingForm').locator('button[type="submit"]').click();
      if (await visible(page, '#onboardingModal')) throw new Error('onboarding modal remains visible');
      if (!(await page.locator('#dashboard.page.active').count())) throw new Error('dashboard is not active');
    });

    const dates = await todayAndYesterday(page);
    await runCheck('today timetable slot appears in Today card', async () => {
      await page.locator('[data-section="attendance"]').click();
      await page.locator('#timetableSubject').selectOption({ index: 0 });
      await page.locator('#timetableDay').selectOption(dates.today);
      await page.locator('#timetableTime').fill('10:00 AM');
      await page.locator('#timetableForm button[type="submit"]').click();
      await page.locator('[data-section="dashboard"]').click();
      if (!(await page.locator('#todaySlotsList .today-slot-card').count())) throw new Error('today slot card is missing');
    });

    const todayAction = async (action, expected) => {
      await page.locator(`#todaySlotsList [data-action="${action}"]`).click();
      const historyCount = await page.locator('#attendanceHistory .history-item').count();
      const subjectText = await text(page, '#subjectCards');
      if (historyCount !== 1) throw new Error(`expected one history entry, found ${historyCount}`);
      if (!subjectText.includes(expected)) throw new Error(`subject percentage does not show ${expected}`);
    };

    await runCheck('marking today Present updates to 100%', () => todayAction('slot-present', '100.0%'));
    await runCheck('marking today Absent updates to 0%', () => todayAction('slot-absent', '0.0%'));
    await runCheck('marking today Cancelled updates to No data yet', () => todayAction('slot-cancelled', 'No data yet'));

    await runCheck('yesterday slot appears in Pending and badge matches list', async () => {
      await page.locator('[data-section="attendance"]').click();
      await page.locator('#timetableSubject').selectOption({ index: 0 });
      await page.locator('#timetableDay').selectOption(dates.yesterday);
      await page.locator('#timetableTime').fill('11:00 AM');
      await page.locator('#timetableForm button[type="submit"]').click();
      await page.locator('[data-section="dashboard"]').click();
      const listCount = await page.locator('#pendingList .pending-slot-card').count();
      const badgeText = await text(page, '#pendingCountBadge');
      if (listCount !== 1 || !badgeText.startsWith('1 ')) throw new Error(`pending list=${listCount}, badge="${badgeText}"`);
    });

    await runCheck('Mark all as Present empties Pending and hides badges', async () => {
      await page.locator('.mark-all-present-btn').click();
      if (await page.locator('#pendingList .pending-slot-card').count()) throw new Error('pending slot remains');
      if (await visible(page, '#pendingCountBadge')) throw new Error('pending count badge remains visible');
      if (await visible(page, '#pendingAlertBadge')) throw new Error('pending alert badge remains visible');
    });

    await runCheck('Not sure entry can be confirmed in one tap', async () => {
      await page.locator('[data-section="attendance"]').click();
      await page.locator('#attendanceForm #lectureDate').fill(await page.evaluate(() => {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }));
      await page.locator('#lectureStatus').selectOption('unsure');
      await page.locator('#attendanceForm button[type="submit"]').click();
      const unsureEntry = page.locator('#attendanceHistory .history-item').filter({ has: page.locator('.status-pill.unsure') });
      if (!(await unsureEntry.count())) throw new Error('Not sure entry was not rendered');
      await unsureEntry.locator('[data-action="quick-present"]').click();
      if (await page.locator('#attendanceHistory .status-pill.present').count() < 2) throw new Error('one-tap confirmation did not produce Present');
    });

    let exportedData;
    await runCheck('export, reset and import restore subjects, timetable and attendance', async () => {
      await page.locator('[data-section="profile"]').click();
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#exportDataBtn').click();
      const download = await downloadPromise;
      exportedData = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('#resetDataBtn').click();
      if (!(await visible(page, '#onboardingModal'))) throw new Error('reset did not return to onboarding');
      await page.locator('#importFileInput').setInputFiles({
        name: 'campus-companion-data.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(exportedData))
      });
      await page.waitForTimeout(100);
      if (await page.locator('#onboardingModal').isVisible()) throw new Error('import did not hide onboarding');
      await page.locator('[data-section="attendance"]').click();
      if (!(await page.locator('#timetableForm option').count() > 1)) throw new Error('timetable was not restored');
      if (!(await page.locator('#attendanceHistory .history-item').count())) throw new Error('attendance was not restored');
      await page.locator('[data-section="dashboard"]').click();
      if (!(await page.locator('#subjectCards .subject-card').count())) throw new Error('subjects were not restored');
    });

    await runCheck('bottom navigation switches all four tabs', async () => {
      for (const section of ['dashboard', 'attendance', 'library', 'profile']) {
        await page.locator(`[data-section="${section}"]`).click();
        if (!(await page.locator(`#${section}.page.active`).count())) throw new Error(`${section} did not become active`);
      }
    });

    await runCheck('moderation tab is hidden for a student profile', async () => {
      if (await visible(page, '[data-section="admin"]')) throw new Error('moderation tab is visible');
    });

    check(`${prefix} zero console errors and uncaught exceptions`, browserErrors.length === 0, browserErrors.join('; ') || 'browser errors detected');
    await page.close();
  };

  (async () => {
    await waitForServer();
    const address = `http://127.0.0.1:${server.address().port}`;
    const executablePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({ headless: true, executablePath });
    for (const width of [390, 1280]) await runAtWidth(browser, address, width);
    await browser.close();
    await closeServer();
    const failed = checks.filter((item) => !item.passed);
    console.log(`\nFLOW CHECK ${failed.length ? 'FAILED' : 'PASSED'}: ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  })().catch(async (error) => {
    await closeServer();
    console.error(`FLOW CHECK FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
