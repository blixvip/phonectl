// Finds the mobile apps you're building on this computer, and builds/installs them.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CONFIG, WIN, expandHome, openPath, openTerminal } from './os.mjs';

// Where to look: PHONECTL_PROJECT_ROOTS (path-list, ; on Windows, : elsewhere), else "projectRoots"
// in ~/.phonectl/config.json, else the usual code folders.
const ROOTS = (process.env.PHONECTL_PROJECT_ROOTS?.split(path.delimiter)
  || CONFIG.projectRoots
  || ['~/code', '~/projects', '~/dev', '~/src', '~/AndroidStudioProjects', ...(WIN ? ['C:\\code', 'C:\\projects'] : [])])
  .map((s) => expandHome(s.trim())).filter(Boolean);
const SKIP = new Set(['node_modules', '.git', 'build', 'dist', '.gradle', '.venv', 'venv', 'Pods', '_ARCHIVE', '.expo', '.next', 'out', 'target', '.idea', '__pycache__', 'templates']);
const LOG_DIR = path.join(homedir(), '.phonectl', 'builds');

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

function newest(dir, depth = 3) {
  // Newest source edit — "when did I last work on this".
  let best = 0;
  const walk = (d, n) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (n > 0) walk(p, n - 1); } else best = Math.max(best, mtime(p));
    }
  };
  walk(dir, depth);
  return best;
}

function gradleAppId(file) {
  return read(file).match(/applicationId\s*=?\s*["']([\w.]+)["']/)?.[1] || null;
}

function gradleAppName(dir) {
  const strings = read(path.join(dir, 'app/src/main/res/values/strings.xml'));
  return strings.match(/<string name="app_name"[^>]*>([^<]+)</)?.[1] || null;
}

function detect(dir) {
  const name = path.basename(dir);
  // Native Android (Gradle)
  for (const g of ['app/build.gradle.kts', 'app/build.gradle']) {
    const f = path.join(dir, g);
    if (existsSync(f) && existsSync(path.join(dir, 'app/src/main/AndroidManifest.xml'))) {
      return {
        type: 'Android', dir, gradleDir: dir, pkg: gradleAppId(f),
        name: gradleAppName(dir) || name,
        apk: path.join(dir, 'app/build/outputs/apk/debug/app-debug.apk'),
      };
    }
  }
  // Expo / React Native
  const appJson = path.join(dir, 'app.json');
  if (existsSync(appJson) && existsSync(path.join(dir, 'package.json'))) {
    let cfg = {}; try { cfg = JSON.parse(read(appJson)); } catch { /* */ }
    const pkgJson = read(path.join(dir, 'package.json'));
    const expo = cfg.expo || (/"expo"\s*:/.test(pkgJson) ? cfg : null);
    const rn = /"react-native"\s*:/.test(pkgJson);
    if (expo || rn) {
      const gradleDir = existsSync(path.join(dir, 'android/gradlew')) ? path.join(dir, 'android') : null;
      return {
        type: expo ? 'Expo' : 'React Native', dir, gradleDir,
        pkg: expo?.android?.package || (gradleDir && gradleAppId(path.join(gradleDir, 'app/build.gradle'))) || null,
        name: expo?.name || cfg.name || name,
        apk: gradleDir ? path.join(gradleDir, 'app/build/outputs/apk/debug/app-debug.apk') : null,
      };
    }
  }
  // Flutter
  const pub = path.join(dir, 'pubspec.yaml');
  if (existsSync(pub) && /flutter:/.test(read(pub)) && existsSync(path.join(dir, 'android'))) {
    return {
      type: 'Flutter', dir, gradleDir: null,
      pkg: gradleAppId(path.join(dir, 'android/app/build.gradle')) || gradleAppId(path.join(dir, 'android/app/build.gradle.kts')),
      name: read(pub).match(/^name:\s*(\S+)/m)?.[1] || name,
      apk: path.join(dir, 'build/app/outputs/flutter-apk/app-debug.apk'),
    };
  }
  // Capacitor
  const cap = ['capacitor.config.ts', 'capacitor.config.json', 'capacitor.config.js'].map((f) => path.join(dir, f)).find(existsSync);
  if (cap && existsSync(path.join(dir, 'android/gradlew'))) {
    return {
      type: 'Capacitor', dir, gradleDir: path.join(dir, 'android'),
      pkg: read(cap).match(/appId['"]?\s*:\s*['"]([\w.]+)/)?.[1] || null,
      name: read(cap).match(/appName['"]?\s*:\s*['"]([^'"]+)/)?.[1] || name,
      apk: path.join(dir, 'android/app/build/outputs/apk/debug/app-debug.apk'),
    };
  }
  return null;
}

let cache = { at: 0, list: [] };
export function scanProjects(force) {
  if (!force && Date.now() - cache.at < 30000) return cache.list;
  const found = [];
  const walk = (d, depth) => {
    const hit = detect(d);
    if (hit) { found.push(hit); return; }
    if (depth <= 0) return;
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth - 1);
  };
  for (const r of ROOTS) if (existsSync(r)) walk(r, 3);
  const list = found.map((p) => ({
    ...p,
    id: Buffer.from(p.dir).toString('base64url'),
    apkAt: p.apk ? mtime(p.apk) : 0,
    editedAt: newest(p.dir),
    building: jobs.get(p.dir)?.state === 'running',
    job: jobs.has(p.dir) ? publicJob(jobs.get(p.dir)) : null,
  })).sort((a, b) => b.editedAt - a.editedAt);
  cache = { at: Date.now(), list };
  return list;
}

export function projectById(id) {
  return scanProjects().find((p) => p.id === id) || scanProjects(true).find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------- builds

const jobs = new Map(); // dir -> { state, startedAt, endedAt, log, tail }
function publicJob(j) { return { state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, log: j.log, tail: j.tail.slice(-12) }; }

export function buildProject(p, onDone) {
  if (!p.gradleDir) return { ok: false, error: `${p.type} project has no android/ folder to build. Use "Dev server" instead.` };
  if (jobs.get(p.dir)?.state === 'running') return { ok: false, error: 'Already building' };
  mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, `${path.basename(p.dir)}.log`);
  const job = { state: 'running', startedAt: Date.now(), endedAt: 0, log, tail: [] };
  jobs.set(p.dir, job);
  cache.at = 0;
  const child = WIN
    ? spawn('cmd.exe', ['/d', '/c', 'gradlew.bat', 'assembleDebug', '--console=plain'], { cwd: p.gradleDir, windowsHide: true })
    : spawn('sh', ['./gradlew', 'assembleDebug', '--console=plain'], { cwd: p.gradleDir });
  const fd = openSync(log, 'w');
  const onData = (c) => {
    try { writeSync(fd, c); } catch { /* log file is best-effort */ }
    for (const line of c.toString('utf8').split(/\r?\n/)) if (line.trim()) job.tail.push(line.slice(0, 300));
    if (job.tail.length > 200) job.tail.splice(0, job.tail.length - 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    closeSync(fd);
    job.state = code === 0 ? 'ok' : 'failed';
    job.endedAt = Date.now();
    cache.at = 0;
    onDone?.(job);
  });
  return { ok: true, message: `Building ${p.name}…` };
}

export function jobFor(p) { return jobs.has(p.dir) ? publicJob(jobs.get(p.dir)) : null; }

export function devServer(p) {
  // Visible on purpose: the Expo CLI is interactive (QR code, reload keys).
  const cmd = p.type === 'Flutter' ? 'flutter run' : 'npx expo start';
  openTerminal(cmd, p.dir, `${p.name} dev`);
  return { ok: true, message: `Started "${cmd}" in a new window` };
}

export function openIn(p, where) {
  if (where === 'code') {
    const code = path.join(homedir(), 'AppData/Local/Programs/Microsoft VS Code/Code.exe');
    spawn(existsSync(code) ? code : 'code', [p.dir], { detached: true, stdio: 'ignore', windowsHide: true, shell: !existsSync(code) }).unref();
    return { ok: true, message: `Opened ${p.name} in VS Code` };
  }
  openPath(p.dir);
  return { ok: true };
}
