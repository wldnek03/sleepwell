/* 신스 검증용 (node tools/test_synth.js [outDir])
 * 브라우저 없이 synth.js를 돌려서 레벨/NaN/루프 이음새를 확인하고
 * 들어볼 수 있게 WAV를 떨군다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const outDir = process.argv[2] || path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });

// --- 최소 브라우저 셰임 ---
const blobs = new Map();
let blobId = 0;
const win = {
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: {
    createObjectURL(b) { const u = 'blob:' + (++blobId); blobs.set(u, b); return u; },
    revokeObjectURL(u) { blobs.delete(u); }
  },
  Math, Date, Float32Array, ArrayBuffer, DataView, console
};
win.window = win;
const ctx = vm.createContext(win);
for (const f of ['js/presets.js', 'js/synth.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}

function blobBytes(url) {
  return Buffer.from(blobs.get(url).parts[0]);
}
function pcm(url) {
  const b = blobBytes(url);
  const n = (b.length - 44) / 2;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = b.readInt16LE(44 + i * 2) / 32768;
  return a;
}
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const peak = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
function sliceRms(a, t0, t1, sr) {
  return rms(a.subarray(Math.round(t0 * sr), Math.round(t1 * sr)));
}
const db = v => (20 * Math.log10(v || 1e-9)).toFixed(1);

const SR = win.SW.SR;
let fail = 0;
function check(ok, msg) { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fail++; }

for (const p of win.SW_PRESETS) {
  console.log('\n=== ' + p.id + ' (' + p.name + ') ===');
  const a = win.SW.renderPreset(p);
  const ind = pcm(a.induction), hold = pcm(a.hold), fade = pcm(a.fadeout);

  console.log(`  렌더 ${a.renderMs}ms | 유도 ${a.inductionSec.toFixed(1)}s / 유지 ${a.holdSec.toFixed(2)}s / 페이드 ${a.fadeoutSec.toFixed(1)}s`);

  const hook = sliceRms(ind, 2, 12, SR);
  const mid = sliceRms(ind, 60, 70, SR);
  const settle = sliceRms(ind, 118, 126, SR);
  console.log(`  레벨  hook ${db(hook)}dB → mid ${db(mid)}dB → settle ${db(settle)}dB | hold ${db(rms(hold))}dB`);
  console.log(`  피크  유도 ${peak(ind).toFixed(3)} / 유지 ${peak(hold).toFixed(3)}`);

  check(ind.every(Number.isFinite) && hold.every(Number.isFinite), 'NaN/Inf 없음');
  check(peak(ind) < 1.0 && peak(hold) < 1.0, '클리핑 없음');
  check(hook > mid && mid > settle, 'hook > mid > settle 로 단조 감소');
  check(hook / settle > 1.6, `hook이 settle보다 충분히 큼 (${(hook / settle).toFixed(2)}배, ${db(hook / settle)}dB)`);
  check(Math.abs(rms(hold) - settle) / settle < 0.25, '유도 끝 레벨 ≈ 유지 루프 레벨 (이음새)');

  // 루프 이음새: 끝 20ms와 시작 20ms의 RMS가 비슷해야 (크로스페이드 dip 확인)
  const w = Math.round(0.02 * SR);
  const headR = rms(hold.subarray(0, w));
  const tailR = rms(hold.subarray(hold.length - w));
  check(Math.abs(headR - tailR) / Math.max(headR, tailR) < 0.6,
    `루프 머리/꼬리 레벨 유사 (${db(headR)} vs ${db(tailR)})`);
  check(Math.abs(hold[0] - hold[hold.length - 1]) < 0.25, '루프 이음새 샘플 점프 작음');

  check(rms(fade.subarray(0, Math.round(0.5 * SR))) > 0.05, '페이드 시작은 들림');
  check(peak(fade.subarray(fade.length - Math.round(0.2 * SR))) < 0.01, '페이드 끝은 무음');

  for (const [name, url] of [['induction', a.induction], ['hold', a.hold], ['fadeout', a.fadeout]]) {
    fs.writeFileSync(path.join(outDir, `${p.id}-${name}.wav`), blobBytes(url));
  }
}

console.log(`\nWAV → ${outDir}`);
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과');
process.exit(fail ? 1 : 0);
