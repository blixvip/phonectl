#!/usr/bin/env node
// phonectl dash — local control room for the phone: live view, apps, inspector, logs.
// Everything here is also reachable as JSON under /api so agents can use it too.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adbAsync, shAsync, adbPath, scrcpyPath, devices, devicesAsync, resetSerial, resolveSerial,
} from './adb.mjs';
import { meaningful, parseNodes } from './ui.mjs';
import { addViewer, streamState, control, KEYCODES, phoneClipboard } from './stream.mjs';
import {
  recordingState, startRecording, finishRecording, crashState, crashList, watchCrashes,
  awakeState, setAwake, grantAll, clearData, pushFile,
} from './extras.mjs';
import { appIcon, dropIcon, sourceIcon } from './icons.mjs';
import { openPath } from './os.mjs';
import { scanProjects, projectById, buildProject, jobFor, devServer, openIn } from './projects.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'shots');
export const DASH_PORT = Number(process.env.PHONECTL_DASH_PORT || 4360);
const STATE_DIR = path.join(homedir(), '.phonectl');
const PREFS = path.join(STATE_DIR, 'prefs.json');
export const ACTIVITY = path.join(STATE_DIR, 'activity.jsonl');

mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------- prefs

function loadPrefs() {
  try { return { favorites: [], names: {}, ...JSON.parse(readFileSync(PREFS, 'utf8')) }; }
  catch { return { favorites: [], names: {} }; }
}
function savePrefs(p) { writeFileSync(PREFS, JSON.stringify(p, null, 2)); }

export function logActivity(source, action, detail = '') {
  try { appendFileSync(ACTIVITY, JSON.stringify({ t: Date.now(), source, action, detail: String(detail).slice(0, 200) }) + '\n'); }
  catch { /* activity feed is best-effort */ }
}

function readActivity(limit = 80) {
  try {
    const lines = readFileSync(ACTIVITY, 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

// ---------------------------------------------------------------- device

const KEYS = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recents: 'KEYCODE_APP_SWITCH', power: 'KEYCODE_POWER',
  volup: 'KEYCODE_VOLUME_UP', voldown: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE',
  enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE',
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
  wake: 'KEYCODE_WAKEUP', sleep: 'KEYCODE_SLEEP', playpause: 'KEYCODE_MEDIA_PLAY_PAUSE',
  next: 'KEYCODE_MEDIA_NEXT', prev: 'KEYCODE_MEDIA_PREVIOUS', camera: 'KEYCODE_CAMERA',
  forwarddel: 'KEYCODE_FORWARD_DEL', menu: 'KEYCODE_MENU',
};

const PKG_RE = /^[A-Za-z0-9_.]+$/;
const cleanPkg = (p) => (PKG_RE.test(p || '') ? p : null);

function activeSerial() { return devices().some((d) => d.state === 'device'); }

let cachedInfo = null; // model/android/screen change rarely — fetch once per connection
async function status() {
  const list = await devicesAsync();
  const d = list.find((x) => x.state === 'device');
  const base = {
    ok: Boolean(d), adb: adbPath(), scrcpy: scrcpyPath(), devices: list, autoconnect: true, stream: streamState,
    recording: recordingState(), crash: crashState(), keepAwake: awakeState(),
  };
  watchCrashes((c) => logActivity('phone', 'crashed', `${c.pkg || 'app'}: ${c.title || 'see Logs › Crashes'}`));
  if (!d) { cachedInfo = null; return base; }
  if (!cachedInfo || cachedInfo.serial !== d.serial) {
    const [model, android, size, maker] = await Promise.all([
      shAsync('getprop ro.product.model'), shAsync('getprop ro.build.version.release'),
      shAsync('wm size'), shAsync('getprop ro.product.manufacturer'),
    ]);
    const m = size.out.match(/Override size:\s*(\d+)x(\d+)|Physical size:\s*(\d+)x(\d+)/);
    cachedInfo = {
      serial: d.serial, model: model.out, maker: maker.out, android: android.out,
      screen: m ? { w: Number(m[1] || m[3]), h: Number(m[2] || m[4]) } : null,
    };
  }
  // Foreground app / battery / screen state are slow dumpsys calls (seconds over wifi).
  // Refresh them in the background and answer with the last reading, so status stays instant.
  if (details.serial !== d.serial) details = { serial: d.serial, at: 0, data: {} };
  if (!detailsBusy && Date.now() - details.at > 2500) {
    const mine = details;
    detailsBusy = readDetails().then((x) => { mine.data = x; mine.at = Date.now(); }).catch(() => {}).finally(() => { detailsBusy = null; });
  }
  return { ...base, ...cachedInfo, transport: d.transport, ...details.data };
}

let details = { serial: null, at: 0, data: {} }, detailsBusy = null;
async function readDetails() {
  const [focus, battery, power] = await Promise.all([
    shAsync('dumpsys activity activities 2>/dev/null | grep -m1 topResumedActivity'),
    shAsync('dumpsys battery | grep -E "level|AC powered|USB powered|status"'),
    shAsync('dumpsys power | grep -E "mWakefulness=|Display Power: state="'),
  ]);
  const fm = focus.out.match(/([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/);
  const level = battery.out.match(/level:\s*(\d+)/)?.[1];
  return {
    foreground: fm ? fm[1] : null, activity: fm ? fm[2] : null,
    battery: level ? Number(level) : null,
    charging: /(AC|USB) powered:\s*true/.test(battery.out),
    awake: /mWakefulness=Awake|state=ON/.test(power.out),
  };
}

function prettyName(pkg, names) {
  if (names[pkg]) return names[pkg];
  const KNOWN = {
    'com.zhiliaoapp.musically': 'TikTok', 'com.ss.android.ugc.trill': 'TikTok', 'com.instagram.android': 'Instagram',
    'com.whatsapp': 'WhatsApp', 'com.snapchat.android': 'Snapchat', 'com.twitter.android': 'X',
    'com.google.android.youtube': 'YouTube', 'com.spotify.music': 'Spotify', 'com.discord': 'Discord',
    'com.android.chrome': 'Chrome', 'com.google.android.gm': 'Gmail', 'com.google.android.apps.maps': 'Maps',
    'com.sec.android.app.camera': 'Camera', 'com.sec.android.gallery3d': 'Gallery', 'com.android.settings': 'Settings',
    'com.samsung.android.messaging': 'Messages', 'com.samsung.android.dialer': 'Phone', 'com.reddit.frontpage': 'Reddit',
    'host.exp.exponent': 'Expo Go', 'com.facebook.katana': 'Facebook', 'com.facebook.orca': 'Messenger',
    'com.netflix.mediaclient': 'Netflix', 'com.openai.chatgpt': 'ChatGPT', 'com.anthropic.claude': 'Claude',
    'org.telegram.messenger': 'Telegram', 'ai.x.grok.bot': 'Grok', 'com.google.android.apps.photos': 'Photos', 'com.amazon.mShop.android.shopping': 'Amazon',
    'com.sec.android.app.sbrowser': 'Samsung Internet', 'com.samsung.android.app.notes': 'Samsung Notes',
    'com.google.android.apps.youtube.music': 'YouTube Music', 'com.twitch.android.app': 'Twitch', 'com.pinterest': 'Pinterest',
  };
  if (KNOWN[pkg]) return KNOWN[pkg];
  const skip = new Set(['com', 'org', 'net', 'io', 'app', 'apps', 'android', 'mobile', 'client', 'co', 'www', 'google', 'samsung', 'sec', 'free', 'main', 'prod', 'release', 'launcher']);
  const parts = pkg.split('.').filter((p) => !skip.has(p.toLowerCase()));
  const pick = parts.length ? parts[parts.length === 1 ? 0 : Math.min(parts.length - 1, 1)] : pkg.split('.').pop();
  return pick.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());
}

let appsCache = { at: 0, serial: null, list: [] };
async function apps(force) {
  const serial = resolveSerial();
  if (!force && appsCache.serial === serial && Date.now() - appsCache.at < 60000) return appsCache.list;
  const [third, launchable] = await Promise.all([
    shAsync('pm list packages -3'),
    shAsync('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER', { timeout: 30000 }),
  ]);
  const user = new Set(third.out.split(/\r?\n/).map((l) => l.replace('package:', '').trim()).filter(Boolean));
  const launch = new Set();
  for (const line of launchable.out.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_.]+)\//);
    if (m) launch.add(m[1]);
  }
  const all = new Set([...user, ...launch]);
  const names = loadPrefs().names;
  const list = [...all].map((pkg) => ({
    pkg, name: prettyName(pkg, names), user: user.has(pkg), launchable: launch.has(pkg) || user.has(pkg),
  })).sort((a, b) => a.name.localeCompare(b.name));
  appsCache = { at: Date.now(), serial, list };
  return list;
}

async function recents() {
  const r = await shAsync('dumpsys activity recents | grep -E "realActivity=|baseIntent"', { timeout: 15000 });
  const seen = [];
  for (const m of r.out.matchAll(/(?:realActivity=\{?|cmp=)([A-Za-z0-9_.]+)\//g)) {
    if (!seen.includes(m[1]) && !/launcher|systemui|recents/i.test(m[1])) seen.push(m[1]);
  }
  return seen.slice(0, 12);
}

// Frames: one screencap at a time, shared by every viewer.
let framePending = null;
let lastFrame = { at: 0, png: null };
function frame() {
  if (Date.now() - lastFrame.at < 120 && lastFrame.png) return Promise.resolve(lastFrame.png);
  if (framePending) return framePending;
  framePending = adbAsync(['exec-out', 'screencap', '-p'], { binary: true, timeout: 15000 })
    .then((r) => {
      if (r.out && r.out.length > 1000) lastFrame = { at: Date.now(), png: r.out };
      return r.out && r.out.length > 1000 ? r.out : null;
    })
    .finally(() => { framePending = null; });
  return framePending;
}

function tapText(s) {
  // adb `input text` cannot take spaces or shell specials raw.
  return s.replace(/(["\\$`'&|;<>()*~!#?])/g, '\\$1').replace(/ /g, '%s');
}

// ---------------------------------------------------------------- actions

const ACTIONS = {
  async status() { return status(); },
  async apps({ refresh }) { const [list, rec] = await Promise.all([apps(refresh), recents()]); const prefs = loadPrefs(); return { ok: true, apps: list, recents: rec, favorites: prefs.favorites }; },
  async launch({ pkg }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    const r = await shAsync(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|Error/i.test(r.out + r.err)) return { ok: false, error: `No launcher activity for ${pkg}` };
    return { ok: true, message: `Launched ${pkg}` };
  },
  async stop({ pkg }) { pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' }; await shAsync(`am force-stop ${pkg}`); return { ok: true, message: `Stopped ${pkg}` }; },
  async restart({ pkg }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    await shAsync(`am force-stop ${pkg}`);
    const r = await ACTIONS.launch({ pkg });
    return r.ok ? { ok: true, message: `Restarted ${pkg}` } : r;
  },
  async cleardata({ pkg }) { return clearData(cleanPkg(pkg)); },
  async grantall({ pkg }) { return grantAll(cleanPkg(pkg)); },
  async record({ on }) {
    return on ? startRecording(SHOTS, (file, secs) => logActivity('dashboard', 'recorded', `${path.basename(file)} (${secs}s)`)) : finishRecording();
  },
  async crashes() { return { ok: true, items: crashList() }; },
  async keepawake({ on }) { return setAwake(Boolean(on)); },
  // Clipboard through the live stream: paste = also press Paste on the phone.
  async setclip({ text, paste }) {
    if (!text) return { ok: false, error: 'empty clipboard' };
    return control({ t: 'setclip', text: String(text), paste: Boolean(paste) }) ? { ok: true } : { ok: false, error: 'Live view not running' };
  },
  async phoneclip({ copy }) {
    const text = await phoneClipboard(Boolean(copy));
    return text == null ? { ok: false, error: 'Live view not running' } : { ok: true, text };
  },
  async appinfo({ pkg }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    await shAsync(`am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${pkg}`);
    return { ok: true, message: `Opened settings for ${pkg}` };
  },
  async uninstall({ pkg }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    const r = await adbAsync(['uninstall', pkg], { timeout: 60000 });
    dropIcon(pkg);
    appsCache.at = 0;
    return /Success/i.test(r.out) ? { ok: true, message: `Uninstalled ${pkg}` } : { ok: false, error: r.out || r.err };
  },
  async favorite({ pkg, on }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    const p = loadPrefs();
    p.favorites = p.favorites.filter((x) => x !== pkg);
    if (on) p.favorites.push(pkg);
    savePrefs(p);
    return { ok: true, favorites: p.favorites };
  },
  async rename({ pkg, name }) {
    pkg = cleanPkg(pkg); if (!pkg) return { ok: false, error: 'bad package' };
    const p = loadPrefs();
    if (name && name.trim()) p.names[pkg] = name.trim().slice(0, 40); else delete p.names[pkg];
    savePrefs(p); appsCache.at = 0;
    return { ok: true };
  },
  // Live touch from the dashboard canvas: x/y in video pixels, w/h = video size.
  async touch(p) { return control({ ...p, t: 'touch' }) ? { ok: true } : { ok: false, error: 'no live control' }; },
  async scroll(p) { return control({ ...p, t: 'scroll' }) ? { ok: true } : { ok: false, error: 'no live control' }; },
  async tap({ x, y }) { await shAsync(`input tap ${Math.round(x)} ${Math.round(y)}`); return { ok: true }; },
  async longpress({ x, y }) { x = Math.round(x); y = Math.round(y); await shAsync(`input swipe ${x} ${y} ${x} ${y} 650`); return { ok: true }; },
  async swipe({ x1, y1, x2, y2, ms }) {
    await shAsync(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.max(40, Math.min(2000, Math.round(ms || 250)))}`);
    return { ok: true };
  },
  async key({ key }) {
    const code = KEYS[String(key).toLowerCase()] || (/^KEYCODE_[A-Z0-9_]+$/.test(key) ? key : null);
    if (!code) return { ok: false, error: `unknown key ${key}` };
    // Through the live stream's control socket when it is up: instant instead of ~1.5s.
    if (KEYCODES[code] != null && control({ t: 'key', code: KEYCODES[code] })) return { ok: true };
    await shAsync(`input keyevent ${code}`);
    return { ok: true };
  },
  async text({ text }) {
    if (!text) return { ok: false, error: 'no text' };
    if (control({ t: 'text', text: String(text).slice(0, 300) })) return { ok: true };
    await shAsync(`input text "${tapText(String(text).slice(0, 500))}"`);
    return { ok: true };
  },
  async wake() {
    await shAsync('input keyevent KEYCODE_WAKEUP'); await shAsync('wm dismiss-keyguard');
    return { ok: true, message: 'Screen woken' };
  },
  async notifications() { await shAsync('cmd statusbar expand-notifications'); return { ok: true }; },
  async quicksettings() { await shAsync('cmd statusbar expand-settings'); return { ok: true }; },
  async rotate() {
    const cur = (await shAsync('settings get system user_rotation')).out.trim();
    await shAsync('settings put system accelerometer_rotation 0');
    await shAsync(`settings put system user_rotation ${cur === '1' ? 0 : 1}`);
    return { ok: true };
  },
  async open({ url }) {
    if (!url || /["`$\\]/.test(url)) return { ok: false, error: 'bad url' };
    await shAsync(`am start -a android.intent.action.VIEW -d "${url}"`);
    return { ok: true, message: `Opened ${url}` };
  },
  async reverse({ port }) {
    port = Number(port) || 8081;
    const r = await adbAsync(['reverse', `tcp:${port}`, `tcp:${port}`]);
    return r.code === 0 ? { ok: true, message: `Phone localhost:${port} → PC :${port}` } : { ok: false, error: r.err };
  },
  async shot() {
    const png = await frame();
    if (!png) return { ok: false, error: 'screencap failed' };
    mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    writeFileSync(file, png);
    return { ok: true, file, message: `Saved ${path.basename(file)}` };
  },
  async openshots() {
    mkdirSync(SHOTS, { recursive: true });
    openPath(SHOTS);
    return { ok: true };
  },
  async ui() {
    const remote = '/sdcard/phonectl-ui.xml';
    await shAsync(`uiautomator dump ${remote}`, { timeout: 20000 });
    const cat = await adbAsync(['exec-out', 'cat', remote], { timeout: 20000 });
    const nodes = String(cat.out || '').includes('<node') ? meaningful(parseNodes(String(cat.out))) : [];
    return { ok: nodes.length > 0, nodes, error: nodes.length ? undefined : 'Could not read the screen (is it on and unlocked?)' };
  },
  async logs({ pkg, crash }) {
    if (crash) {
      const r = await adbAsync(['logcat', '-d', '-b', 'crash', '-t', '200'], { timeout: 20000 });
      return { ok: true, lines: (r.out || '').split(/\r?\n/).filter(Boolean) };
    }
    const r = await adbAsync(['logcat', '-d', '-t', '300', '-v', 'time', '*:W'], { timeout: 20000 });
    let lines = (r.out || '').split(/\r?\n/).filter(Boolean);
    pkg = cleanPkg(pkg);
    if (pkg) {
      const pid = (await shAsync(`pidof ${pkg}`)).out.split(/\s+/)[0];
      lines = lines.filter((l) => l.includes(pkg) || (pid && l.includes(`(${String(pid).padStart(5)})`)) || (pid && l.includes(`(${pid})`)));
    }
    return { ok: true, lines: lines.slice(-200) };
  },
  async connect({ addr }) {
    if (addr && !/^[\w.:-]+$/.test(addr)) return { ok: false, error: 'bad address' };
    const attempt = async (a) => /connected/i.test((await adbAsync(['connect', a], { timeout: 20000 })).out);
    if (addr) return (await attempt(addr)) ? { ok: true, message: `Connected ${addr}` } : { ok: false, error: `Could not connect to ${addr}` };
    for (let round = 0; round < 2; round++) {
      const svc = (await adbAsync(['mdns', 'services'], { timeout: 15000 })).out;
      const m = svc.split(/\r?\n/).map((l) => l.match(/^(\S+)\s+(_adb-tls-connect\._tcp|_adb\._tcp)\s+(\S+:\d+)/)).find(Boolean);
      if (m && await attempt(m[3])) { resetSerial(); return { ok: true, message: `Connected ${m[3]}` }; }
      if (round === 0) { await adbAsync(['kill-server']); await adbAsync(['start-server'], { timeout: 20000 }); }
    }
    return { ok: false, error: 'No phone found. On the phone: Settings › Developer options › Wireless debugging › ON (same wifi). Then Connect again.' };
  },
  async pair({ code, addr }) {
    if (!/^\d{6}$/.test(code || '')) return { ok: false, error: 'Enter the 6-digit code from the phone' };
    if (!addr) {
      const svc = (await adbAsync(['mdns', 'services'], { timeout: 15000 })).out;
      addr = svc.split(/\r?\n/).map((l) => l.match(/^(\S+)\s+(_adb-tls-pairing\._tcp)\s+(\S+:\d+)/)).find(Boolean)?.[3];
      if (!addr) return { ok: false, error: 'No phone waiting to pair. Keep the "Pair device with pairing code" dialog OPEN on the phone.' };
    }
    const r = await adbAsync(['pair', addr, code], { timeout: 60000 });
    if (!/Successfully paired/i.test(r.out)) return { ok: false, error: r.out || r.err || 'pair failed' };
    return ACTIONS.connect({});
  },
  async disconnect() { await adbAsync(['disconnect']); resetSerial(); return { ok: true, message: 'Disconnected' }; },
  async install({ file }) {
    if (!file || !existsSync(file)) return { ok: false, error: 'no apk' };
    const r = await adbAsync(['install', '-r', '-d', file], { timeout: 300000 });
    appsCache.at = 0;
    return /Success/i.test(r.out + r.err) ? { ok: true, message: `Installed ${path.basename(file)}` } : { ok: false, error: (r.out + '\n' + r.err).trim() };
  },
  async activity() { return { ok: true, items: readActivity() }; },

  // ---- projects on this computer
  async projects({ refresh }) {
    const list = scanProjects(Boolean(refresh));
    let installed = new Set();
    if (activeSerial()) installed = new Set((await apps()).map((a) => a.pkg));
    return { ok: true, projects: list.map((p) => ({ ...p, installed: p.pkg ? installed.has(p.pkg) : false })) };
  },
  async projbuild({ id, run }) {
    const p = projectById(id); if (!p) return { ok: false, error: 'project not found' };
    return buildProject(p, async (job) => {
      logActivity('dashboard', job.state === 'ok' ? 'built' : 'build failed', p.name);
      if (job.state === 'ok' && run && activeSerial()) await ACTIONS.projinstall({ id });
    });
  },
  async projinstall({ id }) {
    const p = projectById(id); if (!p) return { ok: false, error: 'project not found' };
    if (!p.apk || !existsSync(p.apk)) return { ok: false, error: 'No debug APK yet — Build first' };
    const r = await ACTIONS.install({ file: p.apk });
    if (!r.ok) return r;
    logActivity('dashboard', 'install', p.name);
    if (p.pkg) dropIcon(p.pkg);
    if (p.pkg) await ACTIONS.launch({ pkg: p.pkg });
    return { ok: true, message: `Installed + opened ${p.name}` };
  },
  async projjob({ id }) { const p = projectById(id); return p ? { ok: true, job: jobFor(p) } : { ok: false, error: 'project not found' }; },
  async projdev({ id }) { const p = projectById(id); return p ? devServer(p) : { ok: false, error: 'project not found' }; },
  async projfolder({ id }) { const p = projectById(id); return p ? openIn(p, 'folder') : { ok: false, error: 'project not found' }; },
  async projcode({ id }) { const p = projectById(id); return p ? openIn(p, 'code') : { ok: false, error: 'project not found' }; },
};

const QUIET = new Set(['projects', 'projjob', 'projfolder', 'projcode', 'projinstall', 'projbuild', 'status', 'apps', 'ui', 'logs', 'activity', 'tap', 'swipe', 'key', 'text', 'longpress', 'touch', 'scroll', 'setclip', 'phoneclip', 'crashes', 'record']);

// ---------------------------------------------------------------- server

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wireless debugging: the phone advertises itself over mDNS whenever it is switched on.
// Watch for it and connect on our own, so the user never has to press Connect.
let autoBusy = false;
async function autoConnect() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    if ((await devicesAsync()).some((d) => d.state === 'device' || d.state === 'unauthorized')) return;
    const svc = (await adbAsync(['mdns', 'services'], { timeout: 10000 })).out || '';
    const addr = svc.split(/\r?\n/).map((l) => l.match(/^(\S+)\s+_adb-tls-connect\._tcp\s+(\S+:\d+)/)).find(Boolean)?.[2];
    if (!addr) return;
    const r = await adbAsync(['connect', addr], { timeout: 15000 });
    if (/connected/i.test(r.out) && !/cannot|failed/i.test(r.out)) { resetSerial(); logActivity('dashboard', 'auto-connected', addr); }
  } catch { /* try again next tick */ } finally { autoBusy = false; }
}

export function startServer(port = DASH_PORT) {
  setInterval(autoConnect, 5000).unref();
  autoConnect();
  const server = http.createServer(async (req, res) => {
    // Only this machine may drive the phone.
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { ok: false, error: 'local only' });
    // ...and not some web page open in your browser: cross-site requests carry a foreign Origin.
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { /* malformed = foreign */ }
      if (!ok) return send(res, 403, { ok: false, error: 'cross-site request blocked' });
    } else if (origin === 'null' && req.method !== 'GET') return send(res, 403, { ok: false, error: 'cross-site request blocked' });
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, readFileSync(path.join(HERE, 'dash.html')), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/stream') return addViewer(req, res);
      const iconM = url.pathname.match(/^\/(icon|projicon)\/([A-Za-z0-9_.=-]+)$/);
      if (iconM) {
        let file = null;
        if (iconM[1] === 'icon') file = await appIcon(iconM[2]);
        else { const p = projectById(iconM[2]); file = p ? sourceIcon(p.dir) : null; }
        if (!file) return send(res, 404, { ok: false, error: 'no icon' });
        res.writeHead(200, { 'Content-Type': file.endsWith('.webp') ? 'image/webp' : 'image/png', 'Cache-Control': 'max-age=600' });
        return res.end(readFileSync(file));
      }
      if (url.pathname === '/frame.png') {
        const png = await frame();
        return png ? send(res, 200, png, 'image/png') : send(res, 503, { ok: false, error: 'no frame' });
      }
      if (url.pathname === '/api/upload-file' && req.method === 'POST') {
        const buf = await readBody(req);
        const file = path.join(tmpdir(), `phonectl-up-${Date.now()}`);
        writeFileSync(file, buf);
        const r = await pushFile(file, url.searchParams.get('name'));
        try { rmSync(file, { force: true }); } catch { /* */ }
        if (r.ok) logActivity('dashboard', 'sent file', url.searchParams.get('name') || '');
        return send(res, 200, r);
      }
      if (url.pathname === '/api/upload-apk' && req.method === 'POST') {
        const buf = await readBody(req);
        const file = path.join(tmpdir(), `phonectl-${Date.now()}.apk`);
        writeFileSync(file, buf);
        const r = await ACTIONS.install({ file });
        logActivity('dashboard', 'install', url.searchParams.get('name') || '');
        return send(res, 200, r);
      }
      const m = url.pathname.match(/^\/api\/(\w+)$/);
      if (m && ACTIONS[m[1]]) {
        if (req.method !== 'POST' && !['status', 'apps', 'ui', 'logs', 'activity', 'projects', 'projjob', 'crashes'].includes(m[1])) {
          return send(res, 405, { ok: false, error: 'POST required' });
        }
        const params = req.method === 'POST'
          ? JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}')
          : Object.fromEntries(url.searchParams);
        const result = await ACTIONS[m[1]](params);
        if (!QUIET.has(m[1]) && result.ok) logActivity('dashboard', m[1], params.pkg || params.url || '');
        return send(res, 200, result);
      }
      if (url.pathname === '/api') return send(res, 200, { ok: true, actions: Object.keys(ACTIONS) });
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  });
  server.listen(port, '127.0.0.1', () => setTimeout(() => scanProjects(), 50)); // first scan is ~2s of sync disk walking: get it done before the page asks
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
  console.log(`phonectl dash on http://127.0.0.1:${DASH_PORT}`);
}

