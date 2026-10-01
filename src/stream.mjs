// Live video for the dashboard: scrcpy's own server runs on the phone and pushes H.264,
// we relay it to the browser (which decodes it with WebCodecs). No scrcpy window.
//
// Wire format to the browser, one record per video packet:
//   [u8 flags: 1 = config (SPS/PPS), 2 = key frame][u32 BE length][Annex-B bytes]
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { installHint } from './os.mjs';
import { adbAsync, shAsync, adbPath, scrcpyPath, resolveSerial } from './adb.mjs';

const REMOTE_JAR = '/data/local/tmp/phonectl-scrcpy.jar';
const GRACE_MS = 60000; // keep the encoder warm this long after the last viewer leaves

let versionCache;
function scrcpyVersion() {
  if (versionCache !== undefined) return versionCache;
  const bin = scrcpyPath();
  const r = bin ? spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }) : null;
  versionCache = r?.stdout?.match(/scrcpy (\d+\.\d+(?:\.\d+)?)/)?.[1] || null;
  return versionCache;
}
function serverJar() {
  const bin = scrcpyPath();
  // Windows zips keep the server next to scrcpy.exe; brew/apt put it in <prefix>/share/scrcpy.
  if (process.env.SCRCPY_SERVER_PATH && existsSync(process.env.SCRCPY_SERVER_PATH)) return process.env.SCRCPY_SERVER_PATH;
  if (!bin) return null;
  let real = bin; try { real = realpathSync(bin); } catch { /* keep bin */ }
  const dirs = [path.dirname(bin), path.dirname(real)].flatMap((d) => [d, path.join(d, '..', 'share', 'scrcpy')]);
  return dirs.map((d) => path.join(d, 'scrcpy-server')).find((f) => existsSync(f)) || null;
}

const clients = new Set();
let session = null;
let stopTimer = null;
let preferRaw = false; // flipped if this scrcpy build frames packets differently than we expect
export const streamState = { running: false, mode: null, error: null, frames: 0, since: 0 };

function record(flags, data) {
  const head = Buffer.alloc(5);
  head[0] = flags; head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

// Late joiners need SPS/PPS plus every packet since the last key frame to decode.
let config = null;
let gop = [];
function emit(flags, data) {
  const rec = record(flags, data);
  if (flags & 1) { config = rec; gop = []; }
  if (flags & 2) gop = [rec];
  else if (!(flags & 1) && gop.length < 900) gop.push(rec);
  streamState.frames++;
  for (const res of clients) res.write(rec);
}

// ---------------------------------------------------------------- packet parsers

const isStart = (b, i) => b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1));

/** Config (has SPS) / key (has IDR) from the H.264 itself — scrcpy moved its header flag bits between versions. */
function kind(pkt) {
  let f = 0;
  for (let i = 0; i + 3 < pkt.length; i++) {
    if (pkt[i] !== 0 || pkt[i + 1] !== 0 || pkt[i + 2] !== 1) continue;
    const t = pkt[i + 3] & 0x1f;
    if (t === 7) f |= 1; else if (t === 5) f |= 2;
    if (t === 1 || t === 5) break; // slice data follows; no more headers
    i += 2;
  }
  return f;
}

/** scrcpy frame meta: [u64 pts|flags][u32 size][packet]. */
function metaParser(onBad) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 12) {
      const size = buf.readUInt32BE(8);
      if (size === 0 || size > 32 * 1024 * 1024) return onBad();
      if (buf.length < 12 + size) return;
      const pkt = buf.subarray(12, 12 + size);
      if (!isStart(pkt, 0)) return onBad();
      emit(kind(pkt), Buffer.from(pkt));
      buf = buf.subarray(12 + size);
    }
  };
}

/** raw_stream: bare Annex-B. Split on start codes, group NALs into frames. */
function rawParser() {
  let buf = Buffer.alloc(0);
  let prefix = []; // SPS/PPS/SEI waiting for the next picture
  let idle;
  const nal = (n) => {
    const hdr = n[n[2] === 1 ? 3 : 4], type = hdr & 0x1f;
    if (type === 7 || type === 8) { prefix.push(n); if (type === 8) { emit(1, Buffer.concat(prefix)); prefix = []; } return; }
    if (type !== 1 && type !== 5) { prefix.push(n); return; }
    emit(type === 5 ? 2 : 0, Buffer.concat([...prefix, n])); prefix = [];
  };
  const drain = (final) => {
    let last = -1;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (!isStart(buf, i)) continue;
      if (last >= 0) nal(buf.subarray(last, i));
      last = i; i += 2;
    }
    if (last < 0) return;
    if (final) { nal(buf.subarray(last)); buf = Buffer.alloc(0); } else buf = Buffer.from(buf.subarray(last));
  };
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    drain(false);
    // The encoder writes whole frames; if nothing follows, what is left is a complete NAL.
    clearTimeout(idle); idle = setTimeout(() => drain(true), 12);
  };
}

// ---------------------------------------------------------------- session

async function ensureJar(jar) {
  // Pushing 700KB over wifi is most of the start-up time; skip it when the phone already has it.
  const want = statSync(jar).size;
  const have = Number((await shAsync(`stat -c %s ${REMOTE_JAR} 2>/dev/null`)).out);
  if (have === want) return;
  const push = await adbAsync(['push', jar, REMOTE_JAR], { timeout: 30000 });
  if (push.code !== 0) throw new Error(`push failed: ${push.err || push.out}`);
}

async function start() {
  const serial = resolveSerial();
  const version = scrcpyVersion(), jar = serverJar(), adb = adbPath();
  if (!serial) throw new Error('no phone');
  if (!version || !jar || !adb) throw new Error(`scrcpy not installed (${installHint('scrcpy')})`);

  const scid = (Math.floor(Math.random() * 0x7fffffff)).toString(16).padStart(8, '0');
  const socketName = `localabstract:scrcpy_${scid}`;
  const tcp = net.createServer();
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  const port = tcp.address().port;
  const [, rev] = await Promise.all([ensureJar(jar), adbAsync(['reverse', socketName, `tcp:${port}`])]);
  if (rev.code !== 0) { tcp.close(); throw new Error(`reverse failed: ${rev.err}`); }

  const raw = preferRaw;
  // cleanup=false keeps the jar on the phone between sessions (cleanup would delete it).
  const opts = [
    `scid=${scid}`, 'log_level=info', 'audio=false', 'control=true', 'tunnel_forward=false', 'cleanup=false',
    'clipboard_autosync=false', 'video_codec=h264', 'max_size=1600', 'max_fps=60', 'video_bit_rate=8000000',
    ...(raw ? ['raw_stream=true'] : ['send_device_meta=false', 'send_dummy_byte=false', 'send_stream_meta=false', 'send_frame_meta=true']),
  ];
  const proc = spawn(adb, ['-s', serial, 'shell', `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version, ...opts], { windowsHide: true });
  let log = '';
  const keepLog = (d) => { log = (log + d).slice(-4000); };
  proc.stdout.on('data', keepLog); proc.stderr.on('data', keepLog);

  const s = { proc, tcp, sock: null, ctl: null, socketName, raw, dead: false };
  session = s;
  Object.assign(streamState, { running: true, mode: raw ? 'raw' : 'meta', error: null, frames: 0, since: Date.now(), control: false });
  config = null; gop = [];

  const end = (err) => {
    if (s.dead) return;
    s.dead = true;
    if (err) streamState.error = err;
    streamState.running = false; streamState.control = false;
    try { s.sock?.destroy(); } catch {}
    try { s.ctl?.destroy(); } catch {}
    try { tcp.close(); } catch {}
    try { proc.kill(); } catch {}
    adbAsync(['reverse', '--remove', socketName]).catch(() => {});
    if (session === s) session = null;
    for (const res of clients) res.end();
    clients.clear();
  };
  s.end = end;

  // The server connects twice: video first, then control.
  tcp.on('connection', (sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    if (!s.sock) {
      s.sock = sock;
      const bad = () => {
        // This scrcpy build does not frame packets the way we parse them: use its raw mode.
        preferRaw = true;
        end('stream format mismatch, switching to raw mode');
      };
      sock.on('data', raw ? rawParser() : metaParser(bad));
      sock.on('close', () => end(s.dead ? null : 'phone closed the stream'));
    } else if (!s.ctl) {
      s.ctl = sock;
      streamState.control = true;
      sock.on('data', deviceMessages());
      sock.on('close', () => { s.ctl = null; streamState.control = false; });
    } else sock.destroy();
  });
  proc.on('exit', () => setTimeout(() => end(s.sock ? 'scrcpy server exited' : `scrcpy server failed: ${log.trim().split('\n').slice(-3).join(' | ')}`), 300));
  // Nothing within 10s: give up so the browser falls back instead of staring at black.
  setTimeout(() => { if (!s.sock && !s.dead) end(`no video from phone: ${log.trim().split('\n').slice(-2).join(' | ')}`); }, 10000);
}

let starting = null;
/** Attach an HTTP response as a viewer. */
export async function addViewer(req, res) {
  clearTimeout(stopTimer);
  if (!session) {
    try { await (starting ||= start().finally(() => { starting = null; })); } catch (e) {
      streamState.error = e.message;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Stream-Mode': streamState.mode });
  res.flushHeaders?.();
  if (config) res.write(config);
  for (const rec of gop) res.write(rec);
  clients.add(res);
  control({ t: 'reset' }); // fresh key frame, so a new viewer is not stuck waiting for one
  req.on('close', () => {
    clients.delete(res);
    if (!clients.size && session) stopTimer = setTimeout(() => session?.end(), GRACE_MS);
  });
}

export function stopStream() { session?.end(); }

// ---------------------------------------------------------------- control (scrcpy protocol)

export const KEYCODES = {
  KEYCODE_HOME: 3, KEYCODE_BACK: 4, KEYCODE_DPAD_UP: 19, KEYCODE_DPAD_DOWN: 20, KEYCODE_DPAD_LEFT: 21, KEYCODE_DPAD_RIGHT: 22,
  KEYCODE_VOLUME_UP: 24, KEYCODE_VOLUME_DOWN: 25, KEYCODE_POWER: 26, KEYCODE_CAMERA: 27, KEYCODE_TAB: 61, KEYCODE_ENTER: 66,
  KEYCODE_DEL: 67, KEYCODE_MENU: 82, KEYCODE_MEDIA_PLAY_PAUSE: 85, KEYCODE_MEDIA_NEXT: 87, KEYCODE_MEDIA_PREVIOUS: 88,
  KEYCODE_ESCAPE: 111, KEYCODE_FORWARD_DEL: 112, KEYCODE_VOLUME_MUTE: 164, KEYCODE_APP_SWITCH: 187, KEYCODE_SLEEP: 223, KEYCODE_WAKEUP: 224,
};
const POINTER_FINGER = -2n; // POINTER_ID_GENERIC_FINGER → injected as a touchscreen finger
const POINTER_VIRTUAL = -3n; // POINTER_ID_VIRTUAL_FINGER → second finger for pinch
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

function position(b, o, m) {
  b.writeInt32BE(clampI(m.x, 0, 65535), o); b.writeInt32BE(clampI(m.y, 0, 65535), o + 4);
  b.writeUInt16BE(clampI(m.w, 1, 65535), o + 8); b.writeUInt16BE(clampI(m.h, 1, 65535), o + 10);
}

/** Encode a control message; see scrcpy server ControlMessageReader. */
export function encodeControl(m) {
  if (m.t === 'touch') { // action: 0 down, 1 up, 2 move — x/y in video pixels, w/h = video size
    const b = Buffer.alloc(32);
    b[0] = 2; b[1] = clampI(m.a, 0, 2); b.writeBigInt64BE(m.pid === 'v' ? POINTER_VIRTUAL : POINTER_FINGER, 2); position(b, 10, m);
    b.writeUInt16BE(m.a === 1 ? 0 : 0xffff, 22); // pressure
    return b; // actionButton + buttons stay 0
  }
  if (m.t === 'scroll') { // v/h in notches, + = up/left
    const b = Buffer.alloc(21);
    const fp = (v) => clampI(Math.max(-1, Math.min(1, (Number(v) || 0) / 16)) * 0x8000, -0x8000, 0x7fff);
    b[0] = 3; position(b, 1, m); b.writeInt16BE(fp(m.h), 13); b.writeInt16BE(fp(m.v), 15);
    return b;
  }
  if (m.t === 'key') {
    const one = (action) => { const b = Buffer.alloc(14); b[0] = 0; b[1] = action; b.writeInt32BE(m.code, 2); return b; };
    return Buffer.concat([one(0), one(1)]);
  }
  if (m.t === 'reset') return Buffer.from([17]); // TYPE_RESET_VIDEO
  if (m.t === 'getclip') return Buffer.from([8, m.copy ? 1 : 0]); // TYPE_GET_CLIPBOARD, copyKey 1 = press Copy first
  if (m.t === 'setclip') { // TYPE_SET_CLIPBOARD: sequence, paste flag, text
    const t = Buffer.from(String(m.text || ''), 'utf8').subarray(0, 250000);
    const b = Buffer.alloc(14); b[0] = 9; b.writeBigUInt64BE(0n, 1); b[9] = m.paste ? 1 : 0; b.writeUInt32BE(t.length, 10);
    return Buffer.concat([b, t]);
  }
  if (m.t === 'text') {
    const t = Buffer.from(String(m.text || ''), 'utf8').subarray(0, 300);
    const b = Buffer.alloc(5); b[0] = 1; b.writeUInt32BE(t.length, 1);
    return Buffer.concat([b, t]);
  }
  return null;
}

/** Send through the live control socket. false = no live session (caller falls back to adb). */
export function control(m) {
  const sock = session?.ctl;
  if (!sock || sock.destroyed) return false;
  const b = encodeControl(m);
  if (!b) return false;
  sock.write(b);
  return true;
}

// ---------------------------------------------------------------- phone → PC messages

let clipWaiters = [];
/** Parse DeviceMessageWriter output: 0 clipboard [u32 len][utf8], 1 ack [u64], 2 uhid [u16 id][u16 len][data]. */
function deviceMessages() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length) {
      const t = buf[0];
      if (t === 0) {
        if (buf.length < 5) return;
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        const text = buf.subarray(5, 5 + len).toString('utf8');
        clipWaiters.forEach((w) => w(text)); clipWaiters = [];
        buf = buf.subarray(5 + len);
      } else if (t === 1) { if (buf.length < 9) return; buf = buf.subarray(9); }
      else if (t === 2) { if (buf.length < 5) return; const n = buf.readUInt16BE(3); if (buf.length < 5 + n) return; buf = buf.subarray(5 + n); }
      else { buf = Buffer.alloc(0); return; } // unknown: drop rather than misparse
    }
  };
}

/** Phone clipboard text (copy = press Copy on the current selection first). null = no live session / timeout. */
export function phoneClipboard(copy) {
  return new Promise((resolve) => {
    if (!control({ t: 'getclip', copy })) return resolve(null);
    const done = (text) => { clearTimeout(timer); resolve(text); };
    const timer = setTimeout(() => { clipWaiters = clipWaiters.filter((w) => w !== done); resolve(null); }, 2500);
    clipWaiters.push(done);
  });
}

// Offline tests feed synthetic H.264 through the parsers (test/stream.test.mjs).
export const __test = { metaParser, rawParser, attach: (w) => clients.add(w), detach: (w) => clients.delete(w) };
