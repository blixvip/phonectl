#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adb, adbPath, scrcpyPath, sh, devices, activeDevice,
  prop, screenSize, currentApp, setSerial,
} from './adb.mjs';
import { dumpUi, findNode, renderNodes } from './ui.mjs';
import { find } from './find.mjs';
import { CONFIG, installHint, openPath } from './os.mjs';
import { DASH_PORT, logActivity } from './dash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
const DEFAULT_PHONE_IP = process.env.PHONECTL_IP || CONFIG.phoneIp || null;

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const sIdx = args.indexOf('--serial');
if (sIdx !== -1) { setSerial(args[sIdx + 1]); args.splice(sIdx, 2); }
const cmd = args[0];

function out(human, data) {
  if (JSON_OUT) console.log(JSON.stringify(data ?? { ok: true, message: human }, null, 2));
  else console.log(human);
}

function fail(msg, data) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg, ...data }, null, 2));
  else console.error(msg);
  process.exit(1);
}

function requireDevice() {
  if (!adbPath()) fail('adb not found. Install Google platform-tools.');
  const d = activeDevice();
  if (!d) {
    const unauth = devices().find((x) => x.state === 'unauthorized');
    if (unauth) fail('Phone is connected but UNAUTHORIZED.\nUnlock the phone and tap "Allow" on the USB debugging prompt (tick "Always allow").');
    fail('No phone connected.\nRun: phonectl doctor');
  }
  return d;
}

// ---------------------------------------------------------------- commands

function cmdStatus() {
  const bin = adbPath();
  const list = devices();
  const d = list.find((x) => x.state === 'device');
  const info = { ok: Boolean(d), adb: bin, scrcpy: scrcpyPath(), devices: list };
  if (d) {
    info.model = prop('ro.product.model');
    info.android = prop('ro.build.version.release');
    info.sdk = prop('ro.build.version.sdk');
    info.screen = screenSize();
    info.foreground = currentApp().pkg;
  }
  if (JSON_OUT) return console.log(JSON.stringify(info, null, 2));
  console.log(`adb      ${bin || 'NOT FOUND'}`);
  console.log(`scrcpy   ${info.scrcpy || 'NOT FOUND'}`);
  if (!d) {
    console.log('device   none connected');
    if (list.length) console.log(`         (${list.map((x) => `${x.serial}=${x.state}`).join(', ')})`);
    console.log('\nRun `phonectl doctor` for the fix.');
    process.exitCode = 1;
    return;
  }
  console.log(`device   ${info.model} (${d.serial}, ${d.transport}) Android ${info.android} / API ${info.sdk}`);
  console.log(`screen   ${info.screen ? `${info.screen.w}x${info.screen.h}` : '?'}`);
  console.log(`focused  ${info.foreground || '?'}`);
}

const PLUG_IN_HELP = [
  'WIRELESS (no cable): Settings > Developer options > Wireless debugging > ON,',
  '     then "Pair device with pairing code" and run:  phonectl pair <6-digit code>',
  '     Already paired before? Just:  phonectl connect',
  '',
  '     USB: plug in a DATA usb-c cable (charge-only cables do not work), then',
  '     Settings > Developer options > USB debugging ON.',
  '     Developer options missing? Settings > About phone > Software information >',
  '     tap "Build number" 7 times.',
].join('\n');

function cmdDoctor() {
  const checks = [];
  const bin = adbPath();
  checks.push(['adb installed', Boolean(bin), bin || installHint('adb')]);
  checks.push(['scrcpy installed', Boolean(scrcpyPath()), scrcpyPath() || installHint('scrcpy')]);

  const list = devices();
  const ready = list.find((d) => d.state === 'device');
  const unauth = list.find((d) => d.state === 'unauthorized');
  checks.push([
    'phone visible over adb',
    list.length > 0,
    list.length ? list.map((d) => `${d.serial} (${d.state})`).join(', ') : PLUG_IN_HELP,
  ]);
  checks.push([
    'debugging authorized',
    Boolean(ready),
    ready ? 'yes'
      : unauth ? 'Unlock the phone; tap ALLOW on the "Allow USB debugging?" dialog (tick Always allow).'
      : 'n/a until the phone is visible',
  ]);
  if (ready) checks.push(['can read screen', dumpUi().length > 0, 'uiautomator dump']);

  if (JSON_OUT) {
    return console.log(JSON.stringify({
      ok: checks.every((c) => c[1]),
      checks: checks.map(([name, pass, note]) => ({ name, pass, note })),
    }, null, 2));
  }
  for (const [name, pass, note] of checks) {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}`);
    if (!pass || process.env.PHONECTL_VERBOSE) console.log(`     ${note}`);
  }
  if (!checks.every((c) => c[1])) process.exitCode = 1;
}


function cmdShot() {
  requireDevice();
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  const file = args[1]
    ? path.resolve(args[1])
    : path.join(SHOTS, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const r = adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 30000 });
  if (!r.out || r.out.length < 1000) fail('screencap returned no image');
  writeFileSync(file, r.out);
  out(file, { ok: true, file, bytes: r.out.length });
}

/** Record the screen for N seconds (default 10, max 180) to an mp4 you can watch or hand to a model. */
function cmdRecord() {
  requireDevice();
  const secs = Math.max(1, Math.min(180, Number(args[1]) || 10));
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  const file = args[2] ? path.resolve(args[2]) : path.join(SHOTS, `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`);
  const remote = `/sdcard/phonectl-rec-${Date.now()}.mp4`;
  const r = sh(`screenrecord --time-limit ${secs} --bit-rate 12000000 ${remote}`, { timeout: (secs + 20) * 1000 });
  const pull = adb(['pull', remote, file], { timeout: 120000 });
  sh(`rm -f ${remote}`);
  if (pull.code !== 0) fail('recording failed: ' + (pull.err || r.err || r.out));
  out(file, { ok: true, file, seconds: secs });
}

function cmdUi() {
  requireDevice();
  const nodes = dumpUi();
  if (!nodes.length) fail('Could not read the screen (uiautomator dump failed). Is the screen on and unlocked?');
  const query = args[1];
  const shown = query
    ? nodes.filter((n) => [n.text, n.desc, n.id].join(' ').toLowerCase().includes(query.toLowerCase()))
    : nodes;
  if (JSON_OUT) return console.log(JSON.stringify({ ok: true, app: currentApp().pkg, count: shown.length, nodes: shown }, null, 2));
  console.log(`# ${currentApp().pkg || 'screen'}`);
  console.log(renderNodes(shown) || '(nothing matched)');
}

function cmdTap() {
  requireDevice();
  const rest = args.slice(1);
  if (rest.length >= 2 && /^\d+$/.test(rest[0]) && /^\d+$/.test(rest[1])) {
    sh(`input tap ${rest[0]} ${rest[1]}`);
    return out(`tapped (${rest[0]},${rest[1]})`, { ok: true, x: +rest[0], y: +rest[1] });
  }
  const query = rest.join(' ');
  if (!query) fail('usage: phonectl tap <x> <y>   |   phonectl tap "Button label"');
  const node = findNode(dumpUi(), query);
  if (!node) fail(`No element matching "${query}". Run: phonectl ui`);
  sh(`input tap ${node.x} ${node.y}`);
  out(`tapped "${node.label || node.id}" at (${node.x},${node.y})`, { ok: true, node });
}

function cmdSwipe() {
  requireDevice();
  const [x1, y1, x2, y2, ms] = args.slice(1);
  if (!x1) {
    const s = screenSize() || { w: 1080, h: 2340 };
    sh(`input swipe ${Math.round(s.w / 2)} ${Math.round(s.h * 0.7)} ${Math.round(s.w / 2)} ${Math.round(s.h * 0.3)} 300`);
    return out('scrolled up', { ok: true });
  }
  sh(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms || 300}`);
  out('swiped', { ok: true });
}

function cmdText() {
  requireDevice();
  const s = args.slice(1).join(' ');
  if (!s) fail('usage: phonectl text "hello world"');
  const escaped = s.replace(/(["\\$`])/g, '\\$1').replace(/ /g, '%s');
  sh(`input text "${escaped}"`);
  out(`typed: ${s}`, { ok: true, text: s });
}

const KEYS = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', tab: 'KEYCODE_TAB',
  menu: 'KEYCODE_MENU', power: 'KEYCODE_POWER', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', delete: 'KEYCODE_DEL',
  recents: 'KEYCODE_APP_SWITCH', wake: 'KEYCODE_WAKEUP',
};

function cmdKey() {
  requireDevice();
  if (!args[1]) fail(`usage: phonectl key <${Object.keys(KEYS).join('|')}>`);
  const code = KEYS[args[1].toLowerCase()] || args[1].toUpperCase();
  sh(`input keyevent ${code}`);
  out(`key ${code}`, { ok: true, key: code });
}

function cmdApps() {
  requireDevice();
  const q = args[1];
  const list = sh('pm list packages -3').out
    .split(/\r?\n/).map((l) => l.replace('package:', '').trim()).filter(Boolean).sort();
  const shown = q ? list.filter((p) => p.toLowerCase().includes(q.toLowerCase())) : list;
  if (JSON_OUT) return console.log(JSON.stringify({ ok: true, packages: shown }, null, 2));
  console.log(shown.join('\n'));
}

function cmdLaunch() {
  requireDevice();
  const pkg = args[1];
  if (!pkg) fail('usage: phonectl launch <package>');
  const r = sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found|Error/i.test(r.out + r.err)) fail(`Could not launch ${pkg}: ${r.out || r.err}`);
  out(`launched ${pkg}`, { ok: true, pkg });
}

function cmdStop() {
  requireDevice();
  const pkg = args[1];
  if (!pkg) fail('usage: phonectl stop <package>');
  sh(`am force-stop ${pkg}`);
  out(`stopped ${pkg}`, { ok: true, pkg });
}

function cmdInstall() {
  requireDevice();
  const apk = args[1];
  if (!apk) fail('usage: phonectl install <path-to.apk>');
  const abs = path.resolve(apk);
  if (!existsSync(abs)) fail(`No such file: ${abs}`);
  const r = adb(['install', '-r', '-d', abs], { timeout: 300000 });
  if (!/Success/i.test(r.out + r.err)) fail(`install failed:\n${r.out}\n${r.err}`);
  out(`installed ${path.basename(abs)}`, { ok: true, apk: abs });
}

function cmdLogs() {
  requireDevice();
  const pkg = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const lines = args.includes('--all') ? 400 : 120;
  const r = adb(['logcat', '-d', '-t', String(lines), '-v', 'brief', '*:W'], { timeout: 20000 });
  let text = r.out;
  if (pkg) {
    const pid = sh(`pidof ${pkg}`).out.split(/\s+/)[0];
    text = text.split(/\r?\n/)
      .filter((l) => l.includes(pkg) || (pid && l.includes(`(${String(pid).padStart(5)})`)))
      .join('\n');
  }
  if (JSON_OUT) return console.log(JSON.stringify({ ok: true, lines: text.split(/\r?\n/) }, null, 2));
  console.log(text || '(no warnings or errors)');
}

function cmdCrash() {
  requireDevice();
  const r = adb(['logcat', '-d', '-b', 'crash', '-t', '200'], { timeout: 20000 });
  out(r.out || '(no crashes in the crash buffer)', { ok: true, crash: r.out });
}

/** Devices broadcasting adb over mDNS: pairing services and connect services. */
function mdnsServices() {
  const r = adb(['mdns', 'services'], { timeout: 15000 });
  const pair = [];
  const connect = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(_adb[\w-]*\._tcp)\s+(\S+:\d+)/);
    if (!m) continue;
    const entry = { name: m[1], service: m[2], addr: m[3] };
    if (m[2].includes('pairing')) pair.push(entry);
    else connect.push(entry);
  }
  return { pair, connect };
}

function cmdDiscover() {
  if (!adbPath()) fail('adb not found.');
  const { pair, connect } = mdnsServices();
  if (JSON_OUT) return console.log(JSON.stringify({ ok: pair.length + connect.length > 0, pair, connect }, null, 2));
  if (!pair.length && !connect.length) {
    console.log('Nothing broadcasting.\n\nOn the phone: Settings > Developer options > Wireless debugging > ON');
    console.log('(same wifi network as this computer). Then run this again.');
    process.exitCode = 1;
    return;
  }
  if (connect.length) console.log(`ready to connect:  ${connect.map((c) => c.addr).join(', ')}`);
  if (pair.length) console.log(`waiting to pair:   ${pair.map((c) => c.addr).join(', ')}`);
}

function cmdPair() {
  if (!adbPath()) fail('adb not found.');
  let [addr, code] = args.slice(1);
  // Allow `phonectl pair 123456` — find the pairing service over mDNS.
  if (addr && !code && /^\d{6}$/.test(addr)) {
    const found = mdnsServices().pair[0];
    if (!found) fail('Could not find a phone waiting to pair.\nOn the phone: Wireless debugging > "Pair device with pairing code" — leave that dialog OPEN, then run this again.');
    code = addr;
    addr = found.addr;
    console.log(`found ${addr}`);
  }
  if (!addr || !code) {
    fail([
      'usage: phonectl pair <ip:port> <6-digit-code>',
      '   or: phonectl pair <6-digit-code>            (finds the phone automatically)',
      '',
      'On the phone: Settings > Developer options > Wireless debugging >',
      '"Pair device with pairing code". Use the IP:PORT and code from THAT dialog',
      '(not the ones on the main Wireless debugging screen — different port).',
    ].join('\n'));
  }
  const r = adb(['pair', addr, code], { timeout: 60000 });
  if (!/Successfully paired/i.test(r.out)) fail(`pair failed: ${r.out || r.err}\n\nThe dialog must still be open and the code not expired.`);
  const guid = r.out.match(/guid\s+(\S+)/)?.[1] || '';
  // Pairing port != connect port; pick up the connect service.
  const conn = mdnsServices().connect[0];
  if (conn) {
    const c = adb(['connect', conn.addr], { timeout: 20000 });
    if (/connected/i.test(c.out)) {
      return out(`Paired and connected: ${conn.addr}\nRun: phonectl status`, { ok: true, addr: conn.addr, guid });
    }
  }
  out(`Paired${guid ? ` (${guid})` : ''}.\nNow run: phonectl connect`, { ok: true, guid });
}

function cmdConnect() {
  if (!adbPath()) fail('adb not found.');
  const explicit = args[1];
  const attempt = (addr) => /connected/i.test(adb(['connect', addr], { timeout: 20000 }).out);

  if (explicit) {
    if (!attempt(explicit)) fail(`connect failed for ${explicit}.\nIf it says "failed to authenticate", pair first: phonectl pair <code>`);
    return out(`Connected: ${explicit}\nRun: phonectl status`, { ok: true, addr: explicit });
  }

  // The port changes every time wireless debugging restarts, and adb's mDNS cache
  // happily serves the dead one. A refused connection means: flush and look again.
  for (let round = 0; round < 2; round++) {
    const found = mdnsServices().connect[0];
    if (found && attempt(found.addr)) {
      return out(`Connected: ${found.addr}\nRun: phonectl status`, { ok: true, addr: found.addr });
    }
    if (round === 0) {
      adb(['kill-server']);
      adb(['start-server'], { timeout: 20000 });
    }
  }
  fail([
    'No phone reachable.',
    '',
    'Samsung turns Wireless debugging back OFF when it idles, and the port changes',
    'every time it restarts — so this is usually just a toggle, not a re-pair.',
    '',
    '  Settings > Developer options > Wireless debugging > ON,  then: phonectl connect',
    '',
    'Only if that fails: phonectl pair <6-digit code>',
  ].join('\n'));
}

async function cmdFind() {
  const result = await find(args[1] || DEFAULT_PHONE_IP, { json: JSON_OUT });
  if (!result.ok) fail(result.error, result);
  out(result.message, result);
}

function cmdWifi() {
  const d = requireDevice();
  if (d.transport === 'wifi') return out(`Already on wifi: ${d.serial}`, { ok: true, serial: d.serial });
  const ip = sh('ip -f inet addr show wlan0').out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) fail('Could not read the phone wifi IP. Is wifi on?');
  adb(['tcpip', '5555']);
  const conn = adb(['connect', `${ip}:5555`], { timeout: 20000 });
  if (!/connected/i.test(conn.out)) fail(`connect failed: ${conn.out} ${conn.err}`);
  out(`Connected over wifi at ${ip}:5555 — you can unplug the cable now.\nUse: phonectl --serial ${ip}:5555 <cmd>  (or set PHONECTL_SERIAL)`, { ok: true, serial: `${ip}:5555` });
}

function cmdReverse() {
  requireDevice();
  const port = args[1] || '8081';
  const r = adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (r.code !== 0) fail(`reverse failed: ${r.err}`);
  out(`phone localhost:${port} -> this computer :${port} (Metro/Expo dev server reachable over USB)`, { ok: true, port });
}

function cmdOpen() {
  requireDevice();
  const url = args[1];
  if (!url) fail('usage: phonectl open <url-or-deeplink>');
  sh(`am start -a android.intent.action.VIEW -d "${url}"`);
  out(`opened ${url}`, { ok: true, url });
}

function cmdWake() {
  requireDevice();
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard');
  out('woken', { ok: true });
}

async function cmdDash() {
  const url = `http://127.0.0.1:${DASH_PORT}`;
  const up = async () => { try { return (await fetch(url + '/api', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
  if (!(await up())) {
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'dash.mjs')], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
    for (let i = 0; i < 20 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  if (!args.includes('--no-open')) openPath(url);
  out(`Phone Control: ${url}`, { ok: true, url });
}

function cmdHelp() {
  console.log(`phonectl - drive a connected Android phone from the terminal

  phonectl pair <code>            wireless pairing, no cable (6-digit code from the phone)
  phonectl connect [ip:port]      reconnect an already-paired phone (auto-finds it)
  phonectl find [ip]              scan for the port when mDNS discovery is broken
  phonectl discover               what is broadcasting on the network right now

  phonectl dash                   open Phone Control (60fps live screen, apps, logs)
  phonectl status                 device, android version, screen size, focused app
  phonectl doctor                 diagnose "my phone will not connect"
  phonectl wake                   wake + unlock the screen

  phonectl shot [file.png]        screenshot -> PNG file path (an agent can read it)
  phonectl ui [query]             read the screen as text: coords, labels, tappables
  phonectl tap <x> <y>            tap coordinates
  phonectl tap "Sign in"          tap the element whose label matches
  phonectl swipe [x1 y1 x2 y2 ms] swipe (no args = scroll up)
  phonectl text "hello"           type into the focused field
  phonectl key back|home|enter    press a key

  phonectl apps [query]           installed 3rd-party packages
  phonectl launch <pkg>           start an app
  phonectl stop <pkg>             force-stop an app
  phonectl install <file.apk>     install/replace an APK
  phonectl open <url>             open a url or deep link

  phonectl logs [pkg] [--all]     recent warnings/errors from logcat
  phonectl crash                  the crash buffer
  phonectl record [sec] [out.mp4] record the screen (default 10s, max 180)
  phonectl reverse [port]         expose this computer dev server to the phone (default 8081)
  phonectl wifi                   switch adb to wifi so you can unplug the cable

  --json      machine-readable output
  --serial X  target a specific device`);
}

const COMMANDS = {
  status: cmdStatus, doctor: cmdDoctor, mirror: cmdDash, shot: cmdShot, screenshot: cmdShot,
  ui: cmdUi, tap: cmdTap, click: cmdTap, swipe: cmdSwipe, scroll: cmdSwipe, text: cmdText, type: cmdText,
  key: cmdKey, apps: cmdApps, launch: cmdLaunch, start: cmdLaunch, stop: cmdStop, install: cmdInstall,
  logs: cmdLogs, log: cmdLogs, crash: cmdCrash, wifi: cmdWifi, reverse: cmdReverse, open: cmdOpen,
  wake: cmdWake, help: cmdHelp, record: cmdRecord, rec: cmdRecord, dash: cmdDash, dashboard: cmdDash,
  pair: cmdPair, connect: cmdConnect, discover: cmdDiscover, scan: cmdDiscover, find: cmdFind,
};

const fn = COMMANDS[cmd];
if (!fn) { cmdHelp(); process.exit(cmd ? 1 : 0); }
// Actions that change the phone show up in the dashboard's Activity feed.
const LOGGED = new Set(['tap', 'click', 'swipe', 'scroll', 'text', 'type', 'key', 'launch', 'start', 'stop', 'install', 'open', 'wake', 'mirror', 'shot', 'screenshot', 'record', 'rec', 'reverse', 'connect', 'pair']);
if (LOGGED.has(cmd)) logActivity(process.env.PHONECTL_SOURCE || 'agent', cmd, args.slice(1).join(' '));
fn();
