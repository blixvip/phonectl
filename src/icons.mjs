// Real app logos. Phone apps: rendered on the phone by tools/icondump (the launcher's own
// icon, adaptive/themed/system apps included), cached in ~/.phonectl/icons. Projects not
// installed yet: the launcher icon found in their source tree.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbAsync, shAsync, resolveSerial } from './adb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEX = path.join(ROOT, 'tools', 'icondump', 'icondump.dex');
const REMOTE_DEX = '/data/local/tmp/phonectl-icondump.dex';
const REMOTE_OUT = '/data/local/tmp/phonectl-icons';
export const ICON_DIR = path.join(homedir(), '.phonectl', 'icons');
const SIZE = 128;
const PKG_RE = /^[A-Za-z0-9_.]+$/;

mkdirSync(ICON_DIR, { recursive: true });
const cached = (pkg) => path.join(ICON_DIR, `${pkg}.png`);

const missing = new Set(); // packages the phone explicitly reported no icon for (this run)
let queue = new Map(); // pkg → [resolve]
let timer = null;
let chain = Promise.resolve();

/** PNG path for an installed app's icon, rendering it on the phone if needed. null = none. */
export function appIcon(pkg) {
  if (!PKG_RE.test(pkg || '')) return Promise.resolve(null);
  if (existsSync(cached(pkg))) return Promise.resolve(cached(pkg));
  if (missing.has(pkg) || !resolveSerial()) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (!queue.has(pkg)) queue.set(pkg, []);
    queue.get(pkg).push(resolve);
    // A list of 100 <img> tags arrives as 100 requests: gather them into one phone run.
    clearTimeout(timer);
    timer = setTimeout(flush, 60);
  });
}

/** Forget a package's icon (after a reinstall it may have changed). */
export function dropIcon(pkg) {
  missing.delete(pkg);
  try { rmSync(cached(pkg), { force: true }); } catch { /* */ }
}

function flush() {
  const batch = queue; queue = new Map();
  chain = chain.then(() => render(batch)).catch(() => {
    for (const rs of batch.values()) rs.forEach((r) => r(null));
  });
}

let dexPushed = null;
async function render(batch) {
  const pkgs = [...batch.keys()];
  const serial = resolveSerial();
  if (dexPushed !== serial) {
    const want = statSync(DEX).size;
    const have = Number((await shAsync(`stat -c %s ${REMOTE_DEX} 2>/dev/null`)).out);
    if (have !== want) await adbAsync(['push', DEX, REMOTE_DEX]);
    dexPushed = serial;
  }
  const local = path.join(tmpdir(), `phonectl-icons-${process.pid}`);
  const failed = new Set();
  for (let i = 0; i < pkgs.length; i += 80) {
    const part = pkgs.slice(i, i + 80);
    const r = await shAsync(`rm -rf ${REMOTE_OUT}; CLASSPATH=${REMOTE_DEX} app_process / IconDump ${REMOTE_OUT} ${SIZE} ${part.join(' ')}`, { timeout: 60000 });
    for (const m of String(r.out).matchAll(/^fail (\S+)/gm)) failed.add(m[1]);
    rmSync(local, { recursive: true, force: true }); mkdirSync(local, { recursive: true });
    await adbAsync(['pull', `${REMOTE_OUT}/.`, local], { timeout: 60000 });
    for (const f of readdirSync(local)) {
      try { renameSync(path.join(local, f), path.join(ICON_DIR, f)); } catch { /* */ }
    }
  }
  rmSync(local, { recursive: true, force: true });
  shAsync(`rm -rf ${REMOTE_OUT}`).catch(() => {});
  for (const [pkg, rs] of batch) {
    const f = existsSync(cached(pkg)) ? cached(pkg) : null;
    // Only a definite "fail" is remembered; a dropped connection mid-batch retries next time.
    if (!f && failed.has(pkg)) missing.add(pkg);
    rs.forEach((r) => r(f));
  }
}

// ---------------------------------------------------------------- icons in project sources

const SKIP = new Set(['node_modules', '.git', 'build', 'dist', '.gradle', 'Pods', '.expo', '.next', 'out', 'target', 'intermediates', 'generated']);
const DENSITY = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi'];
const srcCache = new Map();

/** Best launcher bitmap in a project folder, or null (vector-only icons have none). */
export function sourceIcon(dir) {
  if (srcCache.has(dir)) return srcCache.get(dir);
  let best = null, bestScore = -1;
  const consider = (f, score) => { if (score > bestScore && existsSync(f)) { best = f; bestScore = score; } };
  // Expo: app.json → expo.icon
  try {
    const cfg = JSON.parse(readFileSync(path.join(dir, 'app.json'), 'utf8'));
    const icon = cfg.expo?.icon || cfg.icon;
    if (icon) consider(path.resolve(dir, icon), 100);
  } catch { /* */ }
  const walk = (d, depth) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue; }
      if (!/\.(png|webp)$/i.test(e.name)) continue;
      const parent = path.basename(d);
      if (/^mipmap-/.test(parent) && /^ic_launcher(_round)?\.(png|webp)$/i.test(e.name)) {
        const dens = DENSITY.findIndex((x) => parent.includes(x));
        consider(p, 60 - (dens < 0 ? 9 : dens) - (e.name.includes('round') ? 5 : 0));
      } else if (/^(icon|app-?icon|logo)(-\d+)?\.png$/i.test(e.name) && /icons?|assets|public|res/i.test(d)) {
        const px = Number(e.name.match(/-(\d+)\./)?.[1] || 256);
        consider(p, 20 + Math.min(px, 1024) / 100);
      }
    }
  };
  walk(dir, 7);
  srcCache.set(dir, best);
  return best;
}
