import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();

const ADB_CANDIDATES = [
  path.join(HOME, 'AppData/Local/Microsoft/WinGet/Packages/Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe/platform-tools/adb.exe'),
  path.join(HOME, 'AppData/Local/Android/Sdk/platform-tools/adb.exe'),
  'C:/platform-tools/adb.exe',
  ...[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean).map((sdk) => path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')),
  path.join(HOME, 'Library/Android/sdk/platform-tools/adb'),
  path.join(HOME, 'Android/Sdk/platform-tools/adb'),
  '/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/usr/bin/adb',
];

const SCRCPY_CANDIDATES = [
  path.join(HOME, 'AppData/Local/Microsoft/WinGet/Packages/Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe/scrcpy-win64-v4.1/scrcpy.exe'),
  path.join(HOME, 'AppData/Local/Microsoft/WinGet/Packages/Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe/scrcpy.exe'),
  '/opt/homebrew/bin/scrcpy', '/usr/local/bin/scrcpy', '/usr/bin/scrcpy', '/snap/bin/scrcpy',
];

function onPath(exe) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean);
  return null;
}

function firstExisting(candidates) {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// Looked up once: `where` costs ~150ms and every adb call needs the path.
let adbCached, scrcpyCached;
export function adbPath() {
  if (adbCached === undefined || (adbCached && !existsSync(adbCached))) adbCached = onPath('adb') || firstExisting(ADB_CANDIDATES) || null;
  return adbCached;
}

export function scrcpyPath() {
  if (scrcpyCached === undefined || (scrcpyCached && !existsSync(scrcpyCached))) scrcpyCached = onPath('scrcpy') || firstExisting(SCRCPY_CANDIDATES) || null;
  return scrcpyCached;
}

let SERIAL = process.env.PHONECTL_SERIAL || null;
export function setSerial(s) { SERIAL = s; RESOLVED = s; }
/** Long-running callers (the dashboard): forget the cached pick so a new wireless port is found. */
export function resetSerial() { RESOLVED = SERIAL; }

// Commands that address adb itself, not a device — never get a -s flag.
const GLOBAL_CMDS = new Set(['devices', 'connect', 'disconnect', 'pair', 'mdns', 'start-server', 'kill-server', 'version', 'help']);

let RESOLVED = SERIAL;

/**
 * A wireless phone appears twice: once as ip:port, once as its mDNS service name.
 * Both are the same device, but adb sees two and refuses to guess — so pick one.
 */
export function resolveSerial() {
  if (RESOLVED) return RESOLVED;
  RESOLVED = pickSerial(rawDevices());
  return RESOLVED;
}

function pickSerial(all) {
  const list = all.filter((d) => d.state === 'device');
  if (!list.length) return null;
  const distinct = new Map();
  for (const d of list) {
    const key = `${d.model}|${d.device}` === '|' ? d.serial : `${d.model}|${d.device}`;
    // Prefer ip:port and usb serials over the long mDNS service name.
    const existing = distinct.get(key);
    if (!existing || (existing.serial.includes('._tcp') && !d.serial.includes('._tcp'))) distinct.set(key, d);
  }
  return [...distinct.values()][0].serial;
}

/** Run adb, return { code, out, err }. Never throws. */
export function adb(args, opts = {}) {
  const bin = adbPath();
  if (!bin) return { code: 127, out: '', err: 'adb not found' };
  const serial = GLOBAL_CMDS.has(args[0]) ? null : resolveSerial();
  const full = serial ? ['-s', serial, ...args] : args;
  const r = spawnSync(bin, full, {
    encoding: opts.binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 30000,
    windowsHide: true,
  });
  return {
    code: r.status ?? 1,
    out: opts.binary ? (r.stdout || Buffer.alloc(0)) : (r.stdout || '').trim(),
    err: opts.binary ? '' : (r.stderr || '').trim(),
  };
}

export function adbDetached(args) {
  const bin = adbPath();
  if (!bin) return null;
  const full = SERIAL ? ['-s', SERIAL, ...args] : args;
  const p = spawn(bin, full, { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p;
}

export function sh(cmd, opts = {}) {
  return adb(['shell', cmd], opts);
}

function rawDevices() {
  const bin = adbPath();
  if (!bin) return [];
  const r = spawnSync(bin, ['devices', '-l'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return parseDevices(r.stdout);
}

function parseDevices(stdout) {
  return (stdout || '').trim().split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    const meta = Object.fromEntries(rest.map((kv) => kv.split(':')).filter((p) => p.length === 2));
    return {
      serial,
      state,
      model: (meta.model || '').replace(/_/g, ' '),
      device: meta.device || '',
      transport: serial.includes(':') || serial.includes('._tcp') ? 'wifi' : 'usb',
    };
  });
}

/**
 * Dashboard version of devices(): does not block the event loop (the live stream shares it),
 * and re-picks the serial so a changed wireless port is followed.
 */
export async function devicesAsync() {
  const r = await adbAsync(['devices', '-l'], { timeout: 15000 });
  const raw = parseDevices(r.out);
  RESOLVED = SERIAL || pickSerial(raw);
  return foldDevices(raw);
}

/** Parsed `adb devices -l`, with the mDNS duplicate of a wireless phone folded away. */
export function devices() { return foldDevices(rawDevices()); }

function foldDevices(list) {
  const seen = new Map();
  for (const d of list) {
    const key = d.model || d.device ? `${d.model}|${d.device}|${d.state}` : d.serial;
    const existing = seen.get(key);
    if (!existing || (existing.serial.includes('._tcp') && !d.serial.includes('._tcp'))) seen.set(key, d);
  }
  return [...seen.values()];
}

export function activeDevice() {
  const list = devices();
  if (SERIAL) return list.find((d) => d.serial === SERIAL) || null;
  return list.find((d) => d.state === 'device') || null;
}

export function prop(name) {
  return sh(`getprop ${name}`).out;
}

export function screenSize() {
  const m = sh('wm size').out.match(/Override size:\s*(\d+)x(\d+)|Physical size:\s*(\d+)x(\d+)/);
  if (!m) return null;
  return { w: Number(m[1] || m[3]), h: Number(m[2] || m[4]) };
}

export function currentApp() {
  const out = sh('dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp" | head -2').out;
  const m = out.match(/([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/);
  return m ? { pkg: m[1], activity: m[2], raw: out } : { pkg: null, activity: null, raw: out };
}

/** Async adb for the dashboard server, so one slow call never blocks the others. */
export function adbAsync(args, { binary = false, timeout = 30000, input } = {}) {
  return new Promise((resolve) => {
    const bin = adbPath();
    if (!bin) return resolve({ code: 127, out: binary ? Buffer.alloc(0) : '', err: 'adb not found' });
    const serial = GLOBAL_CMDS.has(args[0]) ? null : resolveSerial();
    const p = spawn(bin, serial ? ['-s', serial, ...args] : args, { windowsHide: true });
    const outChunks = []; const errChunks = [];
    p.stdout.on('data', (c) => outChunks.push(c));
    p.stderr.on('data', (c) => errChunks.push(c));
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out: binary ? Buffer.alloc(0) : '', err: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(outChunks);
      resolve({ code: code ?? 1, out: binary ? out : out.toString('utf8').trim(), err: Buffer.concat(errChunks).toString('utf8').trim() });
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export function shAsync(cmd, opts) {
  return adbAsync(['shell', cmd], opts);
}
