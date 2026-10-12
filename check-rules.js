const fs = require('fs');
const path = require('path');

const root = __dirname;
const sourceExtensions = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg']);
const excludedNames = new Set(['check-rules.js', 'test.js']);
const files = fs.readdirSync(root)
  .filter((name) => !excludedNames.has(name))
  .filter((name) => sourceExtensions.has(path.extname(name).toLowerCase()))
  .map((name) => path.join(root, name));

const violations = [];
const addViolation = (file, lineNumber, message) => {
  violations.push(`${path.basename(file)}:${lineNumber}: ${message}`);
};
const hasEmoji = (value) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(value);
const purpleWordPattern = /\b(purple|violet|indigo)\b/i;
const purpleColorPattern = /#([0-9a-f]{3}|[0-9a-f]{6})\b|hsla?\(\s*([0-9]+(?:\.[0-9]+)?)\s*,/ig;
const isPurpleColor = (line) => {
  let match;
  while ((match = purpleColorPattern.exec(line)) !== null) {
    if (match[1]) {
      const hex = match[1].length === 3
        ? match[1].split('').map((digit) => digit + digit).join('')
        : match[1];
      const red = parseInt(hex.slice(0, 2), 16);
      const green = parseInt(hex.slice(2, 4), 16);
      const blue = parseInt(hex.slice(4, 6), 16);
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const delta = max - min;
      if (delta > 0) {
        let hue = 0;
        if (max === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (max === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
        if (hue < 0) hue += 360;
        if (hue >= 250 && hue <= 330) return true;
      }
    } else if (Number(match[2]) >= 250 && Number(match[2]) <= 330) {
      return true;
    }
  }
  return false;
};
const forbiddenPatterns = [
  { pattern: /gradient/i, message: 'gradient is not allowed' },
  { pattern: /made\s+with/i, message: '"Made with" text is not allowed' },
  { pattern: /<meta\b[^>]*\bgenerator\b/i, message: 'generator meta tag is not allowed' },
  { pattern: /\bsetInterval\s*\(/, message: 'setInterval counters are not allowed' },
  { pattern: /\brequestAnimationFrame\s*\(/, message: 'requestAnimationFrame counters are not allowed' },
  { pattern: /addEventListener\s*\(\s*['"](?:scroll|mousemove)['"]/i, message: 'scroll or mousemove effect listener is not allowed' }
];

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (purpleWordPattern.test(line) || isPurpleColor(line)) addViolation(file, lineNumber, 'purple or non-blue color detected');
    if (hasEmoji(line)) addViolation(file, lineNumber, 'emoji character detected');
    if (/[—–]/.test(line)) addViolation(file, lineNumber, 'em dash or en dash detected');
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(line)) addViolation(file, lineNumber, rule.message);
    }
    const radius = line.match(/border-radius\s*:\s*([0-9]+)px/i);
    if (radius && Number(radius[1]) > 8) {
      addViolation(file, lineNumber, 'button or badge radius must be 8px or less');
    }
  });
}

const indexPath = path.join(root, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
if (!/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']favicon\.svg["']/i.test(indexHtml)) {
  addViolation(indexPath, 1, 'missing favicon.svg link');
}
if (!/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']favicon\.ico["']/i.test(indexHtml)) {
  addViolation(indexPath, 1, 'missing favicon.ico link');
}
if (!/href=["']privacy\.html["']/i.test(indexHtml) || !/href=["']terms\.html["']/i.test(indexHtml)) {
  addViolation(indexPath, 1, 'missing footer links to privacy.html and terms.html');
}

if (violations.length) {
  console.error(`RULE CHECK FAILED (${violations.length} violation${violations.length === 1 ? '' : 's'})`);
  violations.forEach((violation) => console.error(violation));
  process.exitCode = 1;
} else {
  console.log(`RULE CHECK PASSED (${files.length} source files scanned)`);
}
