import { adb, adbPath } from './adb.mjs';
import { scanPorts } from './scan.mjs';

const OFF_HINT = [
  '',
  'Wireless debugging is probably off:',
  '  Settings > Developer options > Wireless debugging',
].join('\n');

/**
 * Last-resort discovery. adb's mDNS is unreliable here — it serves dead cached
 * records and often never sees the pairing service — so when it fails, find the
 * phone by scanning the port range wireless debugging actually binds.
 */
export async function find(host, { json = false } = {}) {
  if (!adbPath()) return { ok: false, error: 'adb not found.' };
  if (!host) return { ok: false, error: 'Which IP? phonectl find <phone-ip>  (the phone shows it under Settings > About phone > Status). Save it as "phoneIp" in ~/.phonectl/config.json to skip this.' };

  if (!json) console.log(`Scanning ${host} for the wireless debugging port (up to a minute)...`);
  const open = await scanPorts(host);
  if (!open.length) {
    return { ok: false, error: `Nothing is listening on ${host}.\n${OFF_HINT}` };
  }

  for (const port of open) {
    const addr = `${host}:${port}`;
    if (/connected/i.test(adb(['connect', addr], { timeout: 15000 }).out)) {
      return { ok: true, addr, open, message: `Connected: ${addr}\nRun: phonectl status` };
    }
  }
  return {
    ok: false,
    open,
    error: `Found open ports (${open.join(', ')}) but none accepted adb.\n` +
      'If it says unauthorized, pair again: phonectl pair <code>',
  };
}
