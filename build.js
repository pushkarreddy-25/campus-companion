const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');

const fail = (message) => {
  console.error(`BUILD FAILED: ${message}`);
  process.exit(1);
};

const run = (command, args, label) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}.`);
};

const copyFile = (relativePath) => {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  if (!fs.existsSync(source)) fail(`required source file is missing: ${relativePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
};

const copyDirectory = (relativePath) => {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  if (!fs.existsSync(source)) fail(`required source folder is missing: ${relativePath}`);
  fs.cpSync(source, target, { recursive: true });
};

const lineForText = (filePath, text) => {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => line.includes(text));
  return lineIndex === -1 ? null : lineIndex + 1;
};

const validateSource = () => {
  run(process.execPath, ['check-rules.js'], 'check-rules.js');
  run(process.execPath, ['test.js'], 'test.js');

  const sourceJsFiles = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, name));
  sourceJsFiles.forEach((filePath) => {
    run(process.execPath, ['--check', filePath], `node -c ${path.basename(filePath)}`);
  });
};

const readServiceWorkerAssets = () => {
  const swPath = path.join(root, 'sw.js');
  const source = fs.readFileSync(swPath, 'utf8');
  const match = source.match(/const\s+ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\];/);
  if (!match) fail('could not read ASSETS_TO_CACHE from sw.js');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
};

const validateDist = () => {
  const cachedAssets = readServiceWorkerAssets();
  cachedAssets.forEach((asset) => {
    const target = path.join(dist, asset);
    if (!fs.existsSync(target)) fail(`service worker cache file is missing from dist/: ${asset}`);
  });

  const forbidden = [
    { file: 'config.js', text: '<PASTE URL>' },
    { file: 'config.js', text: '<PASTE ANON KEY>' },
    { file: 'privacy.html', text: '[CONTACT EMAIL]' },
    { file: 'privacy.html', text: '[APP OWNER NAME]' },
    { file: 'terms.html', text: '[CONTACT EMAIL]' }
  ];
  forbidden.forEach(({ file, text }) => {
    const filePath = path.join(dist, file);
    const line = lineForText(filePath, text);
    if (line) fail(`${file}:${line}: forbidden placeholder "${text}"`);
  });

  const files = listFiles(dist);
  files.forEach((filePath) => {
    const line = lineForText(filePath, 'service_role');
    if (line) {
      const relativePath = path.relative(dist, filePath);
      fail(`${relativePath}:${line}: forbidden text "service_role"`);
    }
  });
};

const listFiles = (directory) => {
  const files = [];
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(filePath));
    else files.push(filePath);
  });
  return files;
};

const build = () => {
  validateSource();

  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  [
    'index.html',
    'privacy.html',
    'terms.html',
    'styles.css',
    'app.js',
    'calc.js',
    'library-utils.js',
    'config.js',
    'sw.js',
    'manifest.webmanifest',
    'favicon.svg',
    'favicon.ico'
  ].forEach(copyFile);

  fs.readdirSync(root)
    .filter((name) => /^icon-.*\.png$/i.test(name))
    .forEach(copyFile);

  copyDirectory('fonts');
  copyDirectory('vendor');
  validateDist();

  console.log('\nDIST FILES');
  listFiles(dist)
    .sort()
    .forEach((filePath) => {
      const relativePath = path.relative(dist, filePath);
      const size = fs.statSync(filePath).size;
      console.log(`${relativePath}\t${size} bytes`);
    });
  console.log(`\nBUILD COMPLETE: ${listFiles(dist).length} files written to dist/`);
};

build();
