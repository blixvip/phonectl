import net from 'node:net';

/**
 * adb's mDNS discovery is unreliable on Windows — it caches dead records and often
 * never sees the pairing service at all. When it fails, the phone is still sitting
 * there on a known IP with an open port, so find it the blunt way.
 *
 * Wireless debugging binds an ephemeral port; on Samsung it lands in the high range.
 */
const DEFAULT_RANGE = [30000, 49999];

function probe(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open ? port : null);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Scans `host` for open ports, newest-first (adb ports climb over time, so the
 * highest open port is usually the live one).
 *
 * @param {(scanned: number, total: number, found: number[]) => void} [onProgress]
 */
export async function scanPorts(host, {
  range = DEFAULT_RANGE,
  concurrency = 800,
  timeout = 400,
  onProgress,
} = {}) {
  const [low, high] = range;
  const total = high - low + 1;
  const found = [];
  let next = high; // walk downwards
  let scanned = 0;

  const worker = async () => {
    while (next >= low) {
      const port = next--;
      const open = await probe(host, port, timeout);
      scanned += 1;
      if (open) found.push(open);
      if (onProgress && scanned % 500 === 0) onProgress(scanned, total, found);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => b - a);
}
