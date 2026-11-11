/* SleepWell — 울음 감지기
 *
 * ML 없이 주파수 구조로 판정한다. 아기 울음의 특징 4가지를 전부 만족해야 발화:
 *   1) 배경 소음 기준선보다 충분히 큼 (기준선은 느리게 자동 적응)
 *   2) 에너지가 중역대(300~3000Hz)에 몰려 있음
 *   3) 기본주파수 f0가 250~700Hz이고 배음(2f0)이 뚜렷함
 *      → 어른 말소리(f0 100~250Hz)와 문 닫는 소리/쿵 소리를 걸러낸다
 *   4) 위 조건이 1.2초 이상 지속됨 → 말소리의 음절 단위 끊김을 걸러낸다
 *
 * 한계(정직하게):
 *   - iOS는 화면이 꺼지면 마이크를 끊는다. 대기 모드는 화면을 켜둬야 한다.
 *   - 재생 중에는 스피커 소리를 마이크가 같이 듣는다. 그래서 자동 재생이 시작되면
 *     감지를 멈춘다.
 */
(function (global) {
  'use strict';

  var FRAME_MS = 50;
  var NEED_MS = 1200;                      // 지속 판정 시간
  var NEED = Math.round(NEED_MS / FRAME_MS);
  var DECAY = 2;                           // 비후보 프레임에서 게이지가 빠지는 속도

  var SENS = {                             // 민감도 → 기준선 대비 몇 dB 위부터 후보로 볼지
    high: 7,
    mid: 11,
    low: 16
  };

  function CryDetector() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.freq = null;
    this.timer = null;
    this.sens = 'mid';
    this.base = null;      // 배경 소음 기준선 (dB)
    this.hold = 0;         // 지속 게이지
    this.armedAt = 0;      // 시작 직후 1.5초는 캘리브레이션만
    this.onFrame = null;   // (metrics) => void
    this.onDetect = null;  // () => void
  }

  CryDetector.prototype.start = function () {
    var self = this;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('이 브라우저는 마이크를 지원하지 않습니다'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,   // 울음을 깎아버리면 안 된다
        autoGainControl: false     // 레벨 비교가 깨진다
      }
    }).then(function (stream) {
      var AC = global.AudioContext || global.webkitAudioContext;
      self.stream = stream;
      self.ctx = new AC();
      if (self.ctx.state === 'suspended') self.ctx.resume();
      var src = self.ctx.createMediaStreamSource(stream);
      var an = self.ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.4;
      src.connect(an);
      self.analyser = an;
      self.freq = new Float32Array(an.frequencyBinCount);
      self.base = null;
      self.hold = 0;
      self.armedAt = Date.now() + 1500;
      self.timer = setInterval(function () { self.tick(); }, FRAME_MS);
    });
  };

  CryDetector.prototype.stop = function () {
    clearInterval(this.timer); this.timer = null;
    if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (e) { } this.ctx = null; }
    this.analyser = null;
    this.hold = 0;
  };

  CryDetector.prototype.isRunning = function () { return !!this.timer; };

  CryDetector.prototype.tick = function () {
    var an = this.analyser;
    if (!an) return;
    an.getFloatFrequencyData(this.freq);

    var bw = this.ctx.sampleRate / an.fftSize;
    var f = this.freq, n = f.length;

    function bin(hz) { var b = Math.round(hz / bw); return b < 0 ? 0 : (b >= n ? n - 1 : b); }
    function power(a, b) {
      var s = 0;
      for (var i = a; i <= b; i++) { var d = f[i]; if (d > -160) s += Math.pow(10, d / 10); }
      return s;
    }

    var bLow = bin(80), bCryA = bin(300), bCryB = bin(1000), bMidB = bin(3000), bTop = bin(8000);
    var pTotal = power(bLow, bTop) || 1e-12;
    var pMid = power(bCryA, bMidB);
    var ratio = pMid / pTotal;
    var level = 10 * Math.log10(pTotal);

    /* 기본주파수 f0와 배음 구조.
       "전체 평균보다 큰가"로 보면 음이 또렷할수록 평균이 같이 올라가 불리해진다.
       그래서 각 피크를 주변 이웃과만 비교하는 돌출도(prominence)로 판정한다. */
    function localFloorDb(center, half, skip) {
      var s = 0, c = 0;
      var lo = Math.max(0, center - half), hi = Math.min(n - 1, center + half);
      for (var i = lo; i <= hi; i++) {
        if (Math.abs(i - center) <= skip) continue;
        s += f[i] < -120 ? -120 : f[i]; c++;
      }
      return c ? s / c : -120;
    }
    function peakIn(a, b) {
      var v = -Infinity, k = a;
      for (var i = a; i <= b; i++) if (f[i] > v) { v = f[i]; k = i; }
      return { db: v, bin: k };
    }

    var fund = peakIn(bin(250), bin(700));
    var peakBin = fund.bin;
    var f0 = peakBin * bw;
    var f0Prom = fund.db - localFloorDb(peakBin, 14, 2);

    // 2f0 (비브라토로 번지므로 ±3빈까지 본다)
    var h2 = peakIn(Math.min(n - 1, peakBin * 2 - 3), Math.min(n - 1, peakBin * 2 + 3));
    var h2Prom = h2.db - localFloorDb(h2.bin, 14, 4);

    /* 어른 말소리 배제: 찾은 피크의 절반 자리에도 뚜렷한 피크가 있으면
       진짜 기본주파수가 더 아래(= 어른 목소리)라는 뜻이다. */
    var sb = Math.round(peakBin / 2);
    var sub = peakIn(Math.max(1, sb - 2), Math.max(1, sb + 2));
    var subProm = sub.db - localFloorDb(sub.bin, 14, 3);

    var harmonic = f0Prom > 10 && h2Prom > 6 && subProm < 8;

    // 기준선은 "후보가 아닌" 프레임에서만 천천히 올린다 (울음으로 기준선이 끌려가면 안 됨)
    if (this.base === null) this.base = level;

    var thr = SENS[this.sens];
    var loud = level > this.base + thr;
    var candidate = loud && ratio > 0.5 && harmonic && f0 >= 250;

    if (!candidate) {
      this.base = this.base * 0.99 + level * 0.01;
      this.hold -= DECAY;
    } else {
      this.hold += 1;
    }
    if (this.hold < 0) this.hold = 0;
    if (this.hold > NEED) this.hold = NEED;

    var calibrating = Date.now() < this.armedAt;

    if (this.onFrame) {
      this.onFrame({
        level: level, base: this.base, ratio: ratio, f0: f0,
        loud: loud, f0Prom: f0Prom, h2Prom: h2Prom, subProm: subProm,
        harmonic: harmonic, candidate: candidate,
        progress: this.hold / NEED, calibrating: calibrating,
        spectrum: f, binWidth: bw
      });
    }

    if (!calibrating && this.hold >= NEED) {
      this.hold = 0;
      if (this.onDetect) this.onDetect();
    }
  };

  global.SW_CryDetector = CryDetector;
  global.SW_SENS = SENS;
})(window);
