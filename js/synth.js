/* SleepWell — 오프라인 노이즈 신디사이저
 *
 * 왜 실시간 합성(Web Audio)을 안 쓰는가:
 *   1) iOS는 화면을 잠그면 AudioContext를 중단시킨다 → 자는 도중 소리가 끊긴다.
 *   2) iOS는 HTMLMediaElement.volume 설정을 무시한다 → JS로 페이드를 못 한다.
 * 그래서 볼륨/필터 변화를 전부 "구워서" WAV로 만들고 <audio>로 재생한다.
 * <audio>는 잠금화면에서도 계속 돈다.
 */
(function (global) {
  'use strict';

  var SR = 22050;              // 노이즈용으로 충분 (Nyquist 11kHz), 메모리 절반
  var HOOK_SEC = 20;           // 울음을 덮는 구간
  var INDUCTION_SEC = 120;     // 유도 2분
  var TAIL_SEC = 8;            // 유도 뒤 유지상태로 조금 더 (전환 이음새 숨김)
  var FADEOUT_SEC = 12;        // 종료 타이머 페이드아웃
  var HOLD_TARGET_SEC = 30;    // 유지 루프 목표 길이
  var TARGET_RMS = 0.13;       // 유지 구간 기준 레벨 (약 -17.7 dBFS)

  // ---------- 유틸 ----------

  function makeRng(seed) {
    var s = seed >>> 0 || 2463534242;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 2147483648 - 1;
    };
  }

  function rmsOf(buf) {
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function encodeWav(samples, sr) {
    var n = samples.length;
    var ab = new ArrayBuffer(44 + n * 2);
    var dv = new DataView(ab);
    function str(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    var o = 44;
    for (var i = 0; i < n; i++) {
      var v = samples[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      o += 2;
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // ---------- 신스 ----------

  function Synth(p, seed) {
    this.p = p;
    this.rng = makeRng(seed);
    this.k0 = 0; this.k1 = 0; this.k2 = 0; this.k3 = 0; this.k4 = 0; this.k5 = 0; this.k6 = 0;
    this.brown = 0;
    this.lp1 = 0; this.lp2 = 0;
    this.hx = 0; this.hy = 0;
    this.beatPhase = 0; this.modPhase = 0; this.humPhase = 0;
    // 빗방울 보이스 풀. 내부 루프에서 sin/exp를 부르지 않도록
    // 사인은 2극 재귀 공진기로, 감쇠는 곱셈 계수로 돌린다.
    var DMAX = 10;
    this.dMax = DMAX;
    this.dS1 = new Float64Array(DMAX);
    this.dS2 = new Float64Array(DMAX);
    this.dC = new Float64Array(DMAX);
    this.dEnv = new Float64Array(DMAX);
    this.dK = new Float64Array(DMAX);
    this.dNext = 0;
  }

  /* out을 채운다. progressAt(i) → 0..1 (0 = Hook, 1 = Hold) */
  Synth.prototype.render = function (out, progressAt) {
    var p = this.p, N = out.length, BLK = 64;
    var TWO_PI = Math.PI * 2;

    // 상태를 지역변수로 꺼내 쓰고 마지막에 되돌린다 (내부 루프 속도)
    var rng = this.rng;
    var k0 = this.k0, k1 = this.k1, k2 = this.k2, k3 = this.k3, k4 = this.k4, k5 = this.k5, k6 = this.k6;
    var brown = this.brown, lp1 = this.lp1, lp2 = this.lp2, hx = this.hx, hy = this.hy;
    var beatPhase = this.beatPhase, modPhase = this.modPhase, humPhase = this.humPhase;
    var dMax = this.dMax, dS1 = this.dS1, dS2 = this.dS2, dC = this.dC, dEnv = this.dEnv, dK = this.dK;
    var dNext = this.dNext;

    var isBrown = p.noise === 'brown';
    var hpR = Math.exp(-TWO_PI * p.hpf / SR);
    var humInc = p.hum > 0 ? p.hum / SR : 0;
    var dropRate = p.drops ? 16 / SR : 0;

    for (var i0 = 0; i0 < N; i0 += BLK) {
      var u = progressAt(i0);
      var iu = 1 - u;

      // 컨트롤레이트(64샘플)로만 갱신 — 파라미터는 모두 연속 변화
      var cut = p.cutStart * Math.pow(p.cutHold / p.cutStart, u);
      var a = 1 - Math.exp(-TWO_PI * cut / SR);
      var gain = p.gainStart * Math.pow(p.gainHold / p.gainStart, u);
      var bpm = p.bpmStart * iu + p.bpmHold * u;
      var beatInc = bpm / 60 / SR;
      var period = 60 / bpm;
      var heart = p.heartStart * iu + p.heartHold * u;
      var modInc = (p.modRateStart * iu + p.modRateHold * u) / SR;
      var modD = p.modDepthStart * iu + p.modDepthHold * u;

      var end = i0 + BLK; if (end > N) end = N;
      for (var i = i0; i < end; i++) {
        var w = rng();
        var x;

        if (isBrown) {
          brown = (brown + 0.02 * w) / 1.02;
          x = brown * 3.2;
        } else {
          // Paul Kellet 핑크노이즈
          k0 = 0.99886 * k0 + w * 0.0555179;
          k1 = 0.99332 * k1 + w * 0.0750759;
          k2 = 0.96900 * k2 + w * 0.1538520;
          k3 = 0.86650 * k3 + w * 0.3104856;
          k4 = 0.55000 * k4 + w * 0.5329522;
          k5 = -0.7616 * k5 - w * 0.0168980;
          x = (k0 + k1 + k2 + k3 + k4 + k5 + k6 + w * 0.5362) * 0.33;
          k6 = w * 0.115926;
        }

        // 빗방울 transient
        if (dropRate) {
          if (rng() * 0.5 + 0.5 < dropRate) {
            var r1 = rng() * 0.5 + 0.5, r2 = rng() * 0.5 + 0.5, r3 = rng() * 0.5 + 0.5;
            var wf = TWO_PI * (700 + r1 * 1900) / SR;
            var slot = dNext; dNext = (dNext + 1) % dMax;
            dC[slot] = 2 * Math.cos(wf);
            dS1[slot] = Math.sin(wf); dS2[slot] = 0;
            dEnv[slot] = 0.25 + r2 * 0.5;
            dK[slot] = Math.exp(-1 / ((0.012 + r3 * 0.022) * SR));
          }
          for (var d = 0; d < dMax; d++) {
            var e = dEnv[d];
            if (e < 5e-4) continue;
            var s1 = dS1[d];
            x += s1 * e;
            dS1[d] = dC[d] * s1 - dS2[d];
            dS2[d] = s1;
            dEnv[d] = e * dK[d];
          }
        }

        // 하이패스 (DC 차단 / 저역 정리)
        hy = hpR * (hy + x - hx); hx = x; x = hy;

        // 2극 저역통과 — "멀어지는" 핵심
        lp1 += a * (x - lp1);
        lp2 += a * (lp1 - lp2);
        x = lp2;

        // 모터 허밍
        if (humInc) {
          x += (Math.sin(TWO_PI * humPhase) * 0.10 + Math.sin(TWO_PI * humPhase * 2) * 0.04) * 0.5;
          humPhase += humInc; if (humPhase >= 1) humPhase -= 1;
        }

        // 심장박동 (lub-dub)
        if (heart > 0) {
          var tau = beatPhase * period;
          var h = 0;
          if (tau < 0.22) h += Math.sin(TWO_PI * 46 * tau) * Math.exp(-tau / 0.050);
          var t2 = tau - 0.30 * period;
          if (t2 >= 0 && t2 < 0.20) h += 0.62 * Math.sin(TWO_PI * 40 * t2) * Math.exp(-t2 / 0.045);
          x += h * heart * 0.55;
        }
        beatPhase += beatInc; if (beatPhase >= 1) beatPhase -= 1;

        // 쉬-쉬 리듬 (진폭 변조)
        var amp = gain;
        if (modInc > 0 && modD > 0) {
          var lfo = 0.5 - 0.5 * Math.cos(TWO_PI * modPhase);
          amp *= (1 - modD) + modD * Math.pow(lfo, 1.6);
          modPhase += modInc; if (modPhase >= 1) modPhase -= 1;
        }

        out[i] = x * amp;
      }
    }

    this.k0 = k0; this.k1 = k1; this.k2 = k2; this.k3 = k3; this.k4 = k4; this.k5 = k5; this.k6 = k6;
    this.brown = brown; this.lp1 = lp1; this.lp2 = lp2; this.hx = hx; this.hy = hy;
    this.beatPhase = beatPhase; this.modPhase = modPhase; this.humPhase = humPhase;
    this.dNext = dNext;
    return out;
  };

  // ---------- 트랙 조립 ----------

  /* 유지 루프의 기본 주기(초). 이 주기의 정수배로 루프를 잘라야
     심박/쉬싱 리듬이 이음새에서 어긋나지 않는다. */
  function basePeriod(p) {
    if (p.heartHold > 0) return 60 / p.bpmHold;
    if (p.modRateHold > 0) return 1 / p.modRateHold;
    return 1.0;
  }

  function renderHold(p) {
    var bp = basePeriod(p);
    var nB = Math.max(1, Math.round(HOLD_TARGET_SEC / bp));
    var L = Math.round(nB * bp * SR);   // 루프 길이
    var X = Math.round(bp * SR);        // 워밍업 = 크로스페이드 길이 = 정확히 1주기
    var raw = new Float32Array(X + L + X);
    new Synth(p, 0x9e3779b9).render(raw, function () { return 1; });

    // 앞 X는 필터 워밍업이므로 버리고, 뒤 X를 앞에 등파워로 겹쳐 이음새를 없앤다.
    var loop = new Float32Array(L);
    for (var i = 0; i < L; i++) loop[i] = raw[X + i];
    for (var j = 0; j < X; j++) {
      var th = (j / X) * (Math.PI / 2);
      loop[j] = loop[j] * Math.sin(th) + raw[X + L + j] * Math.cos(th);
    }
    return loop;
  }

  function renderInduction(p) {
    var total = Math.round((INDUCTION_SEC + TAIL_SEC) * SR);
    var hookN = HOOK_SEC * SR;
    var descN = (INDUCTION_SEC - HOOK_SEC) * SR;
    var buf = new Float32Array(total);
    new Synth(p, 0x51ed270b).render(buf, function (i) {
      if (i < hookN) return 0;
      var s = (i - hookN) / descN;
      if (s >= 1) return 1;
      return s * s * (3 - 2 * s);   // smoothstep: 천천히 시작해서 천천히 안착
    });
    // 시작 클릭 방지
    var fi = Math.round(0.03 * SR);
    for (var i = 0; i < fi; i++) buf[i] *= i / fi;
    return buf;
  }

  function renderFadeout(loop) {
    var n = Math.round(FADEOUT_SEC * SR);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var t = i / n;
      var g = (1 - t) * (1 - t);
      out[i] = loop[i % loop.length] * g;
    }
    var fo = Math.round(0.3 * SR);
    for (var j = 0; j < fo; j++) out[n - fo + j] *= 1 - j / fo;
    return out;
  }

  function finalize(buf, norm) {
    for (var i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * norm);
    return buf;
  }

  /* 프리셋 하나를 3개 트랙으로 굽는다.
     induction : 128초, 유도 시퀀스 (루프 아님)
     hold      : 약 30초, 이음새 없는 무한 루프
     fadeout   : 12초, 종료 타이머용 */
  function renderPreset(p) {
    var t0 = performance.now();

    var hold = renderHold(p);
    var norm = TARGET_RMS / (rmsOf(hold) || 1);
    finalize(hold, norm);

    var induction = finalize(renderInduction(p), norm);
    var fade = renderFadeout(hold);

    var assets = {
      presetId: p.id,
      induction: URL.createObjectURL(encodeWav(induction, SR)),
      hold: URL.createObjectURL(encodeWav(hold, SR)),
      fadeout: URL.createObjectURL(encodeWav(fade, SR)),
      inductionSec: induction.length / SR,
      holdSec: hold.length / SR,
      fadeoutSec: fade.length / SR,
      renderMs: Math.round(performance.now() - t0)
    };
    return assets;
  }

  function revoke(assets) {
    if (!assets) return;
    ['induction', 'hold', 'fadeout'].forEach(function (k) {
      try { URL.revokeObjectURL(assets[k]); } catch (e) { }
    });
  }

  function silentUrl() {
    return URL.createObjectURL(encodeWav(new Float32Array(Math.round(SR * 0.05)), SR));
  }

  global.SW = {
    SR: SR,
    HOOK_SEC: HOOK_SEC,
    INDUCTION_SEC: INDUCTION_SEC,
    renderPreset: renderPreset,
    revoke: revoke,
    silentUrl: silentUrl
  };
})(window);
