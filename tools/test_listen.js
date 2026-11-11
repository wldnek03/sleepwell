/* 울음 감지기 검증 (node tools/test_listen.js)
 * 실제 아기 없이 합성 신호로 판정 로직을 돌린다.
 * 울음은 잡고, 말소리/쿵 소리/TV는 안 잡아야 한다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const SR = 48000, FFT = 2048, FRAME = 0.05;

// --- radix-2 FFT ---
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const w = ang * k, wr = Math.cos(w), wi = Math.sin(w);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

class FakeAnalyser {
  constructor(sig) { this.sig = sig; this.fftSize = FFT; this.frequencyBinCount = FFT / 2; this.t = 0; }
  advance(dt) { this.t += dt; }
  getFloatFrequencyData(out) {
    const re = new Float64Array(FFT), im = new Float64Array(FFT);
    const start = this.t - FFT / SR;
    for (let i = 0; i < FFT; i++) {
      // Blackman 창 (Web Audio와 동일)
      const a = i / (FFT - 1);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * a) + 0.08 * Math.cos(4 * Math.PI * a);
      re[i] = this.sig(start + i / SR) * w;
    }
    fft(re, im);
    for (let k = 0; k < out.length; k++) {
      const mag = Math.hypot(re[k], im[k]) / FFT * 2;
      out[k] = mag > 1e-8 ? 20 * Math.log10(mag) : -160;
    }
  }
}

// --- 신호 생성기 ---
const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x3fffffff - 1; }; })();
const bg = t => rnd() * 0.008;                       // 조용한 방 바닥 소음

/* 배음 합. phase는 기본주파수의 누적 위상(rad).
   비브라토는 반드시 위상을 적분해서 만들어야 한다. sin(2π·f(t)·t)로 쓰면
   순간 주파수가 f(t) + t·f'(t)가 되어 완전히 다른 소리가 나온다. */
function harm(phase, n, amp) {
  let v = 0;
  for (let k = 1; k <= n; k++) v += Math.sin(phase * k) / k;
  return v * amp;
}
const flat = (t, f0) => 2 * Math.PI * f0 * t;
/* f(t) = f0 + dev·sin(2π·rate·t) 의 누적 위상 */
const vibrato = (t, f0, dev, rate) =>
  2 * Math.PI * (f0 * t - (dev / (2 * Math.PI * rate)) * (Math.cos(2 * Math.PI * rate * t) - 1));

const SCENARIOS = [
  {
    name: '아기 울음', expect: true,
    sig: t => bg(t) + (t < 2 ? 0 : harm(vibrato(t, 450, 45, 4), 5, 0.22))
  },
  {
    name: '어른 말소리', expect: false,
    sig: t => bg(t) + (t < 2 ? 0 : (((t * 1000) % 300 < 180) ? harm(flat(t, 140), 8, 0.20) : 0))
  },
  {
    name: '여성 말소리(높은 음역)', expect: false,
    sig: t => bg(t) + (t < 2 ? 0 : (((t * 1000) % 300 < 170) ? harm(flat(t, 215), 7, 0.20) : 0))
  },
  {
    name: '문 쿵 (광대역 충격)', expect: false,
    sig: t => bg(t) + ((t >= 2 && t < 2.15) ? rnd() * 0.5 * Math.exp(-(t - 2) / 0.04) : 0)
  },
  {
    name: 'TV 소리', expect: false,
    sig: t => bg(t) + (t < 2 ? 0 : rnd() * 0.06 + harm(flat(t, 160), 6, 0.05))
  },
  {
    name: '조용한 방 (아무 일 없음)', expect: false,
    sig: t => bg(t)
  },
  {
    name: '먼 울음 (작게)', expect: true,
    sig: t => bg(t) + (t < 2 ? 0 : harm(vibrato(t, 500, 40, 3), 5, 0.055))
  }
];

// --- 감지기 로드 ---
const win = { Math, Date, Float32Array, console, AudioContext: function () { } };
win.window = win;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/listen.js'), 'utf8'), vm.createContext(win), { filename: 'listen.js' });

let fail = 0;
console.log('민감도: 보통(기준선 +11dB)\n');
for (const sc of SCENARIOS) {
  const det = new win.SW_CryDetector();
  const an = new FakeAnalyser(sc.sig);
  det.ctx = { sampleRate: SR };
  det.analyser = an;
  det.freq = new Float32Array(FFT / 2);
  det.sens = 'mid';
  det.armedAt = 0;          // 캘리브레이션 대기 없이 바로 무장

  let firedAt = null, peakProgress = 0;
  det.onDetect = () => { if (firedAt === null) firedAt = an.t; };
  det.onFrame = m => { if (m.progress > peakProgress) peakProgress = m.progress; };

  for (let i = 0; i < 120; i++) { an.advance(FRAME); det.tick(); }

  const got = firedAt !== null;
  const ok = got === sc.expect;
  if (!ok) fail++;
  const when = got ? ` @ 이벤트 후 ${(firedAt - 2).toFixed(2)}s` : ` (게이지 최대 ${(peakProgress * 100).toFixed(0)}%)`;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${sc.name.padEnd(22)} ${got ? '감지됨' : '무시됨'}${when}`);
}
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과');
process.exit(fail ? 1 : 0);
