import { adb, sh } from './adb.mjs';

const REMOTE = '/sdcard/phonectl-ui.xml';

/** Dump the on-screen view hierarchy. Returns array of nodes. */
export function dumpUi() {
  let xml = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = sh(`uiautomator dump ${REMOTE}`, { timeout: 20000 });
    if (/ERROR|could not/i.test(d.out + d.err) && attempt < 2) continue;
    const cat = adb(['exec-out', 'cat', REMOTE], { timeout: 20000 });
    xml = String(cat.out || '');
    if (xml.includes('<node')) break;
  }
  if (!xml.includes('<node')) return [];
  return parseNodes(xml);
}

export function parseNodes(xml) {
  const nodes = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const are = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = are.exec(m[1]))) attrs[a[1]] = a[2];
    const b = (attrs.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    const label = decode(attrs.text || '') || decode(attrs['content-desc'] || '');
    nodes.push({
      text: decode(attrs.text || ''),
      desc: decode(attrs['content-desc'] || ''),
      id: (attrs['resource-id'] || '').split('/').pop() || '',
      cls: (attrs.class || '').split('.').pop() || '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
      checked: attrs.checked === 'true',
      scrollable: attrs.scrollable === 'true',
      label,
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      w: x2 - x1,
      h: y2 - y1,
      bounds: [x1, y1, x2, y2],
    });
  }
  return nodes;
}

function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Nodes worth showing an agent: has a label, or is an interactive/scrollable container. */
export function meaningful(nodes) {
  return nodes.filter((n) => n.label || n.clickable || n.scrollable || n.id);
}

/** Find best node matching a query string (case-insensitive substring on label/id). */
export function findNode(nodes, query) {
  const q = query.toLowerCase();
  const scored = nodes
    .map((n) => {
      const hay = [n.text, n.desc, n.id].filter(Boolean).map((s) => s.toLowerCase());
      let score = -1;
      for (const h of hay) {
        if (h === q) score = Math.max(score, 100);
        else if (h.startsWith(q)) score = Math.max(score, 60);
        else if (h.includes(q)) score = Math.max(score, 30);
      }
      if (score < 0) return null;
      if (n.clickable) score += 10;
      if (n.enabled) score += 2;
      return { n, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].n : null;
}

export function renderNodes(nodes) {
  return meaningful(nodes)
    .map((n) => {
      const flags = [n.clickable && 'tap', n.scrollable && 'scroll', n.checked && 'checked', !n.enabled && 'disabled']
        .filter(Boolean)
        .join(',');
      const idPart = n.id ? ` #${n.id}` : '';
      const labelPart = n.label ? ` "${n.label}"` : '';
      return `(${n.x},${n.y}) ${n.cls}${idPart}${labelPart}${flags ? ` [${flags}]` : ''}`;
    })
    .join('\n');
}
