// Offline check of the live-stream parsers — no phone needed.
//   node test/stream.test.mjs [out.bin]
// Encodes 3s of test video with ffmpeg, feeds it through both scrcpy parsers in random
// chunk sizes, and checks every frame comes out intact. With [out.bin], also writes the
// browser-format records so the dashboard player can be tested against them.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { __test } from '../src/stream.mjs';

const h264 = path.join(tmpdir(), 'phonectl-test.h264');
const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1560:rate=60', '-t', '3',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-g', '60', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', h264], { windowsHide: true });
assert.equal(ff.status, 0, 'ffmpeg failed: ' + ff.stderr);
const src = readFileSync(h264);

function capture() {
  const recs = [];
  const sink = { write: (b) => recs.push({ flags: b[0], data: b.subarray(5) }) };
  __test.attach(sink);
  return { recs, done: () => __test.detach(sink) };
}
function feed(parse, buf) {
  for (let i = 0; i < buf.length;) { const n = 1 + Math.floor(Math.random() * 9000); parse(buf.subarray(i, i + n)); i += n; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// raw Annex-B
const raw = capture();
feed(__test.rawParser(), src);
await wait(60); // last NAL is flushed on idle
raw.done();
const cfgs = raw.recs.filter((r) => r.flags & 1), keys = raw.recs.filter((r) => r.flags & 2), pics = raw.recs.filter((r) => !(r.flags & 1));
assert.ok(cfgs.length >= 1, 'SPS/PPS config emitted'); // x264 repeats it per key frame; MediaCodec sends it once
assert.equal(pics.length, 180, `180 pictures, got ${pics.length}`);
assert.equal(keys.length, 3, `3 key frames, got ${keys.length}`);
assert.equal(Buffer.concat(raw.recs.map((r) => r.data)).length, src.length, 'no bytes lost');
console.log(`raw  ok: ${pics.length} frames, ${keys.length} key`);

// scrcpy frame-meta framing of the same packets
const framed = Buffer.concat(raw.recs.map((r, i) => {
  const h = Buffer.alloc(12);
  h.writeUInt32BE((((r.flags & 1) ? 0x80000000 : 0) | ((r.flags & 2) ? 0x40000000 : 0)) >>> 0, 0);
  h.writeUInt32BE(i, 4); h.writeUInt32BE(r.data.length, 8);
  return Buffer.concat([h, r.data]);
}));
const meta = capture();
let bad = false;
feed(__test.metaParser(() => { bad = true; }), framed);
meta.done();
assert.ok(!bad, 'meta parser flagged good stream');
assert.equal(meta.recs.length, raw.recs.length);
meta.recs.forEach((r, i) => { assert.equal(r.flags, raw.recs[i].flags); assert.ok(r.data.equals(raw.recs[i].data)); });
console.log(`meta ok: ${meta.recs.length} records identical`);

// a raw stream sent while we expect meta must be detected, not garbled
const wrong = capture();
let flagged = false;
feed(__test.metaParser(() => { flagged = true; }), src);
wrong.done();
assert.ok(flagged, 'meta parser must reject raw Annex-B');
console.log('mismatch detection ok');

if (process.argv[2]) {
  writeFileSync(process.argv[2], Buffer.concat(raw.recs.map((r) => { const h = Buffer.alloc(5); h[0] = r.flags; h.writeUInt32BE(r.data.length, 1); return Buffer.concat([h, r.data]); })));
  console.log('wrote', process.argv[2]);
}
