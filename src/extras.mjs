// Harness extras for building/testing apps on the phone: screen recording, a live crash
// watcher, keep-awake, per-app test resets, and pushing files. Used by the dashboard.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { adbAsync, adbPath, shAsync, resolveSerial } from './adb.mjs';

const STATE = path.join(homedir(), '.phonectl', 'awake.json');
const PKG_RE = /^[A-Za-z0-9_.]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------- screen recording

let rec = null; // { proc, remote, since, done }

export function recordingState() { return rec ? { since: rec.since } : null; }

/** Start screenrecord on the phone (native resolution, real timing; stops itself at 3 min). */
export function startRecording(outDir, onSaved) {
  if (rec) return { ok: true, message: 'Already recording' };
  const serial = resolveSerial();
  if (!serial) return { ok: false, error: 'no phone' };
  const remote = `/sdcard/phonectl-rec-${Date.now()}.mp4`;
  const proc = spawn(adbPath(), ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '12000000', remote], { windowsHide: true });
  const r = { proc, remote, since: Date.now(), outDir, onSaved };
  r.exited = new Promise((res) => proc.on('exit', res));
  // Hit the 3-minute limit (or the phone dropped): save what there is.
  proc.on('exit', () => { if (rec === r) finishRecording(); });
  rec = r;
  return { ok: true, message: 'Recording… press again to stop' };
}

export async function finishRecording() {
  const r = rec;
  if (!r) return { ok: false, error: 'Not recording' };
  rec = null;
  await shAsync('pkill -INT screenrecord'); // SIGINT lets screenrecord finish the mp4 properly
  await Promise.race([r.exited, sleep(6000)]);
  await sleep(400);
  mkdirSync(r.outDir, { recursive: true });
  const file = path.join(r.outDir, `rec-${stamp()}.mp4`);
  const pull = await adbAsync(['pull', r.remote, file], { timeout: 120000 });
  shAsync(`rm -f ${r.remote}`).catch(() => {});
  if (pull.code !== 0) return { ok: false, error: `Could not pull the recording: ${pull.err || pull.out}` };
  const secs = Math.round((Date.now() - r.since) / 1000);
  r.onSaved?.(file, secs);
  return { ok: true, file, message: `Saved ${path.basename(file)} (${secs}s)` };
}

// ---------------------------------------------------------------- crash watcher

// Follows the phone's crash log buffer so an app dying during a test is never missed.
const crashes = [];
let watcher = null, watchSerial = null;

export function crashState() { return { count: crashes.length, last: crashes[crashes.length - 1] || null }; }
export function crashList() { return crashes.slice().reverse(); }

/** Keep a `logcat -b crash` follower running for the connected phone. Cheap to call often. */
export function watchCrashes(onCrash) {
  const serial = resolveSerial();
  if (!serial) { watcher?.kill(); watcher = null; watchSerial = null; return; }
  if (watcher && watchSerial === serial) return;
  watcher?.kill();
  watchSerial = serial;
  const started = Date.now();
  const p = spawn(adbPath(), ['-s', serial, 'logcat', '-b', 'crash', '-v', 'time', '-T', '1'], { windowsHide: true });
  watcher = p;
  let cur = null, idle, rest = '';
  const flush = () => {
    if (!cur) return;
    const c = cur; cur = null;
    crashes.push(c); if (crashes.length > 30) crashes.shift();
    onCrash?.(c);
  };
  p.stdout.on('data', (d) => {
    if (Date.now() - started < 1500) return; // -T 1 replays the last old line
    const lines = (rest + d.toString('utf8')).split(/\r?\n/); rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!cur) cur = { t: Date.now(), pkg: null, title: '', lines: [] };
      if (cur.lines.length < 60) cur.lines.push(line);
      const proc = line.match(/Process: ([\w.:]+)/) || line.match(/>>> ([\w.:]+) <<</);
      if (proc && !cur.pkg) cur.pkg = proc[1].split(':')[0];
      if (!cur.title) { const ex = line.match(/(\w+(?:\.\w+)*(?:Exception|Error)[^\n]*)/); if (ex) cur.title = ex[1].slice(0, 160); }
    }
    clearTimeout(idle); idle = setTimeout(flush, 400);
  });
  p.on('exit', () => { if (watcher === p) { watcher = null; watchSerial = null; } });
}

// ---------------------------------------------------------------- keep awake

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export function awakeState() { return Boolean(readJson(STATE)); }

/** Screen stays on while testing; the phone's own settings come back when turned off. */
export async function setAwake(on) {
  const saved = readJson(STATE);
  if (on) {
    if (!saved) {
      const [timeout, stayon] = await Promise.all([shAsync('settings get system screen_off_timeout'), shAsync('settings get global stay_on_while_plugged_in')]);
      writeFileSync(STATE, JSON.stringify({ timeout: timeout.out.trim(), stayon: stayon.out.trim() }));
    }
    await shAsync('settings put system screen_off_timeout 1800000');
    await shAsync('settings put global stay_on_while_plugged_in 7');
    return { ok: true, message: 'Screen stays on (30 min timeout, never while charging)' };
  }
  if (saved) {
    const num = (v, d) => (/^\d+$/.test(v || '') ? v : d);
    await shAsync(`settings put system screen_off_timeout ${num(saved.timeout, '30000')}`);
    await shAsync(`settings put global stay_on_while_plugged_in ${num(saved.stayon, '0')}`);
    writeFileSync(STATE, '');
  }
  return { ok: true, message: 'Screen timeout back to normal' };
}

// ---------------------------------------------------------------- app test tools

export async function grantAll(pkg) {
  if (!PKG_RE.test(pkg || '')) return { ok: false, error: 'bad package' };
  const dump = (await shAsync(`dumpsys package ${pkg}`, { timeout: 20000 })).out;
  // Runtime permissions the app asked for but does not have yet.
  const denied = [...new Set([...dump.matchAll(/(android\.permission\.[A-Z_]+|[\w.]+\.permission\.[A-Z_]+): granted=false/g)].map((m) => m[1]))];
  let n = 0;
  for (const perm of denied) if ((await shAsync(`pm grant ${pkg} ${perm}`)).err === '') n++;
  return { ok: true, message: n ? `Granted ${n} permission${n > 1 ? 's' : ''}` : 'Nothing left to grant', granted: n };
}

export async function clearData(pkg) {
  if (!PKG_RE.test(pkg || '')) return { ok: false, error: 'bad package' };
  const r = await shAsync(`pm clear ${pkg}`);
  return /Success/i.test(r.out) ? { ok: true, message: `Cleared data for ${pkg}` } : { ok: false, error: r.out || r.err };
}

// ---------------------------------------------------------------- files

/** Copy a PC file into the phone's Downloads folder. */
export async function pushFile(local, name) {
  const safe = String(name || 'file').replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
  const remote = `/sdcard/Download/${safe}`;
  const r = await adbAsync(['push', local, remote], { timeout: 300000 });
  if (r.code !== 0) return { ok: false, error: r.err || r.out };
  // Make it show up in Gallery/Files right away.
  shAsync(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${remote}"`).catch(() => {});
  return { ok: true, message: `Sent to Downloads/${safe}` };
}
