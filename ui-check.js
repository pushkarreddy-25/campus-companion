const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('UI CHECK FAILED: Playwright is required. Install it with npm install --no-save playwright.');
  process.exitCode = 1;
}

if (chromium) {
  const root = __dirname;
  const screenshots = path.join(root, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
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

  const waitForServer = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const closeServer = () => new Promise((resolve) => server.close(resolve));
  const failures = [];
  const report = (message) => failures.push(message);
  const fixture = {
    profile: { name: 'Test Student', branch: 'Computer Science', semester: 'Semester 4' },
    subjects: [{ id: 'subject-1', name: 'Data Structures', code: 'CS201', target: 75 }],
    attendance: [
      { id: 'record-1', subjectId: 'subject-1', date: '2026-10-08', status: 'present' },
      { id: 'record-2', subjectId: 'subject-1', date: '2026-10-09', status: 'absent' }
    ],
    timetable: [{ id: 'slot-1', subjectId: 'subject-1', day: 'monday', time: '10:00 AM' }]
  };

  const addMockLibraryCards = async (page) => {
    await page.evaluate(() => {
      const grid = document.getElementById('libraryGrid');
      if (!grid || grid.children.length) return;
      grid.innerHTML = '<article class="resource-card"><h4>Pending notes</h4><div class="resource-meta">Data Structures • 2026</div><div class="resource-badges"><span class="badge warning">Pending</span></div><div class="admin-actions"><button class="secondary-btn">Open PDF</button></div></article><article class="resource-card"><h4>Approved guide</h4><div class="resource-meta">Data Structures • 2026</div><div class="resource-badges"><span class="badge success">Approved</span></div><div class="admin-actions"><button class="secondary-btn">Open PDF</button></div></article>';
    });
  };

  const checkPage = async (page, width) => {
    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const all = [...document.querySelectorAll('*')];
      const buttons = [...document.querySelectorAll('button, .file-label-btn')];
      const controls = [...document.querySelectorAll('button, input, select, textarea')];
      const cardSelectors = '.panel, .resource-card, .admin-item, .today-slot-card, .pending-date-group, .insight-item, .history-item, .stat-card, .admin-stat-card';
      const cards = [...document.querySelectorAll(cardSelectors)];
      const errors = [];
      if (root.scrollWidth > root.clientWidth + 1) errors.push(`horizontal scroll ${root.scrollWidth} > ${root.clientWidth}`);
      const expectedHeight = window.innerWidth <= 390 ? 44 : 40;
      controls.forEach((element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || element.closest('.hidden')) return;
        const isInlineTextLink = element.matches('.link-btn');
        const height = element.getBoundingClientRect().height;
        if (height === 0) return;
        if (!isInlineTextLink && height + 0.5 < expectedHeight) errors.push(`control shorter than ${expectedHeight}px: ${element.tagName}.${element.className}`);
      });
      buttons.forEach((button) => {
        const buttonStyle = getComputedStyle(button);
        if (buttonStyle.display === 'none' || buttonStyle.visibility === 'hidden' || button.closest('.hidden') || button.getBoundingClientRect().height === 0) return;
        if (getComputedStyle(button).borderRadius && parseFloat(getComputedStyle(button).borderRadius) > 8) errors.push(`button radius above 8px: ${button.className}`);
      });
      const variants = new Map();
      buttons.forEach((button) => {
        const buttonStyle = getComputedStyle(button);
        if (buttonStyle.display === 'none' || buttonStyle.visibility === 'hidden' || button.closest('.hidden') || button.getBoundingClientRect().height === 0) return;
        const variant = button.className.includes('primary') ? 'primary' : button.className.includes('secondary') ? 'secondary' : button.className.includes('warn') || button.className.includes('danger') ? 'danger' : 'other';
        const height = Math.round(button.getBoundingClientRect().height);
        if (variants.has(variant) && variants.get(variant) !== height) errors.push(`variant ${variant} has heights ${variants.get(variant)}px and ${height}px`);
        variants.set(variant, height);
      });
      all.forEach((element) => {
        const style = getComputedStyle(element);
        if (['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK'].includes(element.tagName) || element.closest('.hidden')) return;
        if (parseFloat(style.borderRadius) > 8) errors.push(`radius above 8px: ${element.tagName}.${element.className}`);
        if (parseFloat(style.fontSize) < 13) errors.push(`text smaller than 13px: ${element.tagName}.${element.className}`);
        if (!/Inter|system-ui|-apple-system|Segoe UI|sans-serif/i.test(style.fontFamily)) errors.push(`unexpected font: ${style.fontFamily}`);
      });
      const nav = document.querySelector('.main-nav');
      if (nav && getComputedStyle(nav).position === 'fixed') {
        const navTop = nav.getBoundingClientRect().top;
        all.forEach((element) => {
          if (element === nav || element.closest('.hidden') || element.classList.contains('onboarding-overlay')) return;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (style.position === 'fixed' && rect.bottom > navTop && rect.top < navTop) errors.push(`fixed content overlaps bottom nav: ${element.className}`);
        });
        window.scrollTo(0, document.documentElement.scrollHeight);
        const clearance = 8;
        const visibleContent = all.filter((element) => {
          if (
            ['HTML', 'BODY', 'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK'].includes(element.tagName) ||
            element === nav ||
            element.closest('.main-nav') ||
            element.closest('.hidden') ||
            element.classList.contains('onboarding-overlay')
          ) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.position !== 'fixed' && style.position !== 'sticky' && rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight;
        });
        const lastContentBottom = visibleContent.reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), 0);
        if (lastContentBottom > navTop - clearance) errors.push(`last visible content ends ${Math.round(lastContentBottom - navTop)}px relative to bottom nav; required ${clearance}px clearance`);
      }
      cards.forEach((card) => {
        const content = [...card.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0);
        if (content > 0 && card.getBoundingClientRect().height > content * 3 + 80) errors.push(`card is more than 3x its content: ${card.className}`);
      });
      return errors;
    });
    result.forEach((error) => report(`${width}px: ${error}`));
  };

  (async () => {
    await waitForServer();
    const address = `http://127.0.0.1:${server.address().port}`;
    const executablePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({ headless: true, executablePath });
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${address}/index.html`);
      await page.evaluate((data) => localStorage.setItem('campus-companion-attendance-v1', JSON.stringify(data)), fixture);
      await page.reload();
      await page.waitForTimeout(300);
      await checkPage(page, width);
      const names = ['auth', 'onboarding', 'dashboard-empty', 'dashboard-with-data', 'attendance', 'library-empty', 'library-pending-approved', 'moderation', 'profile'];
      for (const name of names) {
        if (name === 'auth') {
          await page.evaluate(() => document.getElementById('authScreen')?.classList.remove('hidden'));
        } else if (name === 'onboarding') {
          await page.evaluate(() => {
            document.getElementById('authScreen')?.classList.add('hidden');
            document.getElementById('onboardingModal')?.classList.remove('hidden');
          });
        } else if (name === 'dashboard-empty') {
          await page.evaluate(() => localStorage.removeItem('campus-companion-attendance-v1'));
          await page.reload();
          await page.evaluate(() => {
            document.getElementById('authScreen')?.classList.add('hidden');
            document.getElementById('onboardingModal')?.classList.add('hidden');
          });
        } else if (name === 'dashboard-with-data') {
          await page.evaluate((data) => localStorage.setItem('campus-companion-attendance-v1', JSON.stringify(data)), fixture);
          await page.reload();
          await page.evaluate(() => {
            document.getElementById('authScreen')?.classList.add('hidden');
            document.getElementById('onboardingModal')?.classList.add('hidden');
          });
        } else if (['attendance', 'library-empty', 'moderation', 'profile'].includes(name)) {
          await page.evaluate(() => {
            document.getElementById('authScreen')?.classList.add('hidden');
            document.getElementById('onboardingModal')?.classList.add('hidden');
          });
          await page.evaluate((section) => document.querySelector(`[data-section="${section}"]`)?.click(), name);
        } else if (name === 'library-pending-approved') {
          await page.evaluate(() => {
            document.getElementById('authScreen')?.classList.add('hidden');
            document.getElementById('onboardingModal')?.classList.add('hidden');
          });
          await addMockLibraryCards(page);
        }
        await page.waitForTimeout(100);
        await checkPage(page, width);
        await page.screenshot({ path: path.join(screenshots, `${name}-${width}.png`), fullPage: true });
      }
      await page.goto(`${address}/privacy.html`);
      await page.screenshot({ path: path.join(screenshots, `privacy-${width}.png`), fullPage: true });
      await page.goto(`${address}/terms.html`);
      await page.screenshot({ path: path.join(screenshots, `terms-${width}.png`), fullPage: true });
      await page.close();
    }
    await browser.close();
    await closeServer();
    if (failures.length) {
      console.error(`UI CHECK FAILED (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
      failures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else {
      console.log('UI CHECK PASSED (2 widths, 11 screens, screenshots saved)');
    }
  })().catch(async (error) => {
    await closeServer();
    console.error(`UI CHECK FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
