/* SleepWell — 플레이어 / 대기 모드 / UI / 기록 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var LS_LOG = 'sleepwell.log.v1';
  var LS_PREF = 'sleepwell.pref.v1';
  var LS_DET = 'sleepwell.det.v1';
  var TIMERS = [
    { min: 30, label: '30분' },
    { min: 45, label: '45분' },
    { min: 60, label: '60분' },
    { min: 0, label: '무한' }
  ];
  var SENS_LABELS = [
    { id: 'low', label: '낮음' },
    { id: 'mid', label: '보통' },
    { id: 'high', label: '높음' }
  ];

  var A = $('#a-main');   // 유도 트랙 (128초, 1회)
  var B = $('#a-hold');   // 유지 루프 (무한) / 페이드아웃

  var pref = load(LS_PREF, { presetId: 'shush', timerMin: 45, wake: false, sens: 'mid' });
  if (!pref.sens) pref.sens = 'mid';

  var cache = null;        // {presetId, assets}
  var session = null;      // {presetId, t0, logged, timerId, auto}
  var tickId = null, dimId = null, wakeLock = null, silent = null;
  var detector = null, listenMode = false, specCtx = null;

  // ---------- 저장소 ----------
  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v || dflt; } catch (e) { return dflt; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function savePref() { save(LS_PREF, pref); }

  function getLog() { var l = load(LS_LOG, []); return Array.isArray(l) ? l : []; }
  function addLog(entry) { var l = getLog(); l.unshift(entry); save(LS_LOG, l.slice(0, 300)); }
  function getDet() { return load(LS_DET, { detect: 0, fp: 0 }); }
  function bumpDet(key) { var d = getDet(); d[key] = (d[key] || 0) + 1; save(LS_DET, d); }

  // ---------- 포맷 ----------
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._id);
    toast._id = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  // ---------- 홈 UI ----------
  function buildPresets() {
    var wrap = $('#presets');
    wrap.innerHTML = '';
    window.SW_PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'preset'; b.type = 'button';
      b.setAttribute('aria-pressed', String(p.id === pref.presetId));
      b.innerHTML = '<span class="emo">' + p.emoji + '</span><span class="nm">' + p.name + '</span>';
      b.addEventListener('click', function () {
        pref.presetId = p.id; savePref();
        buildPresets(); updateDesc(); prerender();
      });
      wrap.appendChild(b);
    });
  }
  function updateDesc() { $('#preset-desc').textContent = window.SW_getPreset(pref.presetId).desc; }

  function buildChips(el, items, current, onPick) {
    el.innerHTML = '';
    items.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = t.label;
      b.setAttribute('aria-pressed', String(t.id === current));
      b.addEventListener('click', function () { onPick(t.id); });
      el.appendChild(b);
    });
  }
  function buildTimers() {
    buildChips($('#timers'), TIMERS.map(function (t) { return { id: t.min, label: t.label }; }),
      pref.timerMin, function (v) { pref.timerMin = v; savePref(); buildTimers(); });
  }
  function buildSens() {
    buildChips($('#sens'), SENS_LABELS, pref.sens, function (v) {
      pref.sens = v; savePref(); buildSens();
      if (detector) detector.sens = v;
    });
  }
  function syncWakeToggle() { $('#toggle-wake').setAttribute('aria-checked', String(!!pref.wake)); }

  // ---------- 렌더링 (소리 굽기) ----------
  function prerender() {
    if (cache && cache.presetId === pref.presetId) return Promise.resolve(cache.assets);
    var p = window.SW_getPreset(pref.presetId);
    setPlayLabel('소리 만드는 중…', true);
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        setTimeout(function () {
          if (cache) window.SW.revoke(cache.assets);
          cache = { presetId: p.id, assets: window.SW.renderPreset(p) };
          setPlayLabel('시작', false);
          resolve(cache.assets);
        }, 0);
      });
    });
  }
  function setPlayLabel(text, disabled) {
    $('#play-label').textContent = text;
    $('#btn-play').disabled = !!disabled;
  }

  // ---------- 오디오 언락 ----------
  /* iOS는 "사용자 제스처 안에서 play()를 호출한 적 있는" 엘리먼트만 이후 프로그램적으로
     재생할 수 있다. 자동 재생을 하려면 대기 모드 진입 탭에서 미리 깨워둬야 한다. */
  function unlock() {
    if (!silent) silent = window.SW.silentUrl();
    [A, B].forEach(function (el) {
      if (el.dataset.unlocked) return;
      try {
        el.src = silent;
        var pr = el.play();
        if (pr && pr.then) pr.then(function () { if (el.src === silent) el.pause(); }, function () { });
        el.dataset.unlocked = '1';
      } catch (e) { }
    });
  }

  // ---------- 재생 ----------
  function start(auto) {
    unlock();
    prerender().then(function (assets) {
      A.loop = false; A.src = assets.induction;
      B.loop = true; B.src = assets.hold; B.load();
      A.currentTime = 0;
      var pr = A.play();
      if (pr && pr.catch) pr.catch(function () { toast('재생 실패 — 화면을 한 번 더 탭해주세요'); });

      session = { presetId: pref.presetId, t0: Date.now(), logged: false, timerId: null, auto: !!auto };
      if (pref.timerMin > 0) session.timerId = setTimeout(fadeOut, pref.timerMin * 60 * 1000);
      showPlayer();
      requestWake(auto || listenMode);
      setMediaSession();
    });
  }

  A.addEventListener('ended', function () {
    if (!session) return;
    B.loop = true; B.currentTime = 0;
    var pr = B.play();
    if (pr && pr.catch) pr.catch(function () { });
  });

  function fadeOut() {
    if (!session || !cache) return;
    try { A.pause(); } catch (e) { }
    B.loop = false;
    B.src = cache.assets.fadeout;
    var pr = B.play();
    if (pr && pr.catch) pr.catch(function () { });
    $('#phase-sub').textContent = '종료 중…';
  }

  B.addEventListener('ended', function () {
    if (!B.loop && session) {
      // 대기 모드에서 들어온 세션이면 소리가 꺼진 뒤 다시 귀를 연다
      var back = listenMode;
      stopPlayback();
      if (back) { toast('타이머 종료 — 다시 대기합니다'); resumeListen(); }
      else { showHome(); toast('타이머 종료'); }
    }
  });

  function stopPlayback() {
    if (session && session.timerId) clearTimeout(session.timerId);
    try { A.pause(); } catch (e) { }
    try { B.pause(); } catch (e) { }
    A.removeAttribute('src'); B.removeAttribute('src');
    session = null;
    clearInterval(tickId); tickId = null;
    disarmDim(); hideDim();
  }

  function stopAll() {
    stopPlayback();
    stopListen();
    releaseWake();
    showHome();
  }

  // ---------- 화면 전환 ----------
  function showScreen(id) {
    ['home', 'listen', 'player'].forEach(function (s) { $('#' + s).hidden = (s !== id); });
  }

  function showPlayer() {
    showScreen('player');
    $('#btn-slept').disabled = false;
    $('#btn-slept').textContent = '잠들었어요 😴';
    $('#auto-badge').hidden = !(session && session.auto);
    $('#btn-false').hidden = !(session && session.auto);
    tick();
    tickId = setInterval(tick, 500);
    armDim(false);
  }

  function showHome() {
    clearInterval(tickId); tickId = null;
    disarmDim(); hideDim();
    showScreen('home');
  }

  function tick() {
    if (!session) return;
    var el = (Date.now() - session.t0) / 1000;
    $('#elapsed').textContent = mmss(el);
    var IND = window.SW.INDUCTION_SEC, HOOK = window.SW.HOOK_SEC;
    $('#bar-fill').style.width = (Math.min(1, el / IND) * 100).toFixed(1) + '%';

    if (el < HOOK) {
      $('#phase-label').textContent = '덮는 중';
      $('#phase-sub').textContent = '울음을 덮는 구간입니다. 지금 볼륨이 울음소리보다 살짝 크면 적당합니다.';
    } else if (el < IND) {
      $('#phase-label').textContent = '유도 중';
      $('#phase-sub').textContent = '소리가 ' + mmss(IND - el) + ' 동안 서서히 멀어집니다.';
    } else {
      $('#phase-label').textContent = '유지 중';
      $('#phase-sub').textContent = pref.timerMin > 0
        ? '총 ' + pref.timerMin + '분 뒤 서서히 꺼집니다.'
        : '정지할 때까지 계속됩니다.';
    }
  }

  // ---------- 대기 모드 ----------
  function startListen() {
    unlock();                       // 자동 재생을 위해 제스처 안에서 미리 깨운다
    prerender();                    // 감지되면 즉시 울려야 하므로 미리 굽는다
    showScreen('listen');
    $('#listen-state').textContent = '마이크 준비 중…';
    listenMode = true;
    requestWake(true);              // iOS는 화면이 꺼지면 마이크를 끊는다

    detector = new window.SW_CryDetector();
    detector.sens = pref.sens;
    detector.onFrame = onFrame;
    detector.onDetect = onDetect;
    detector.start().then(function () {
      $('#listen-state').textContent = '주변 소음 재는 중…';
      setTimeout(function () {
        if (listenMode) $('#listen-state').textContent = '듣고 있습니다';
      }, 1600);
      armDim(true);
    }, function (err) {
      listenMode = false;
      releaseWake();
      showHome();
      toast(err && err.name === 'NotAllowedError'
        ? '마이크 권한이 필요합니다 (설정 → Safari → 마이크)'
        : '마이크를 열 수 없습니다');
    });
  }

  function resumeListen() {
    listenMode = true;
    showScreen('listen');
    requestWake(true);
    if (detector && detector.isRunning()) { armDim(true); return; }
    detector = new window.SW_CryDetector();
    detector.sens = pref.sens;
    detector.onFrame = onFrame;
    detector.onDetect = onDetect;
    detector.start().then(function () { armDim(true); }, function () { stopAll(); });
  }

  function stopListen() {
    listenMode = false;
    if (detector) { detector.stop(); detector = null; }
  }

  function onDetect() {
    bumpDet('detect');
    if (detector) detector.stop();   // 재생 중에는 자기 소리를 듣게 되므로 감지를 멈춘다
    start(true);
  }

  function onFrame(m) {
    if (m.calibrating) $('#listen-state').textContent = '주변 소음 재는 중…';

    // 게이지: 기준선 대비 0~24dB을 원 둘레에 매핑
    var over = Math.max(0, Math.min(24, m.level - m.base));
    var circ = 326.7;
    var fill = m.progress > 0 ? m.progress : over / 24 * 0.35;
    $('#gauge-fill').style.strokeDashoffset = String(circ * (1 - Math.min(1, fill)));
    $('.gauge').classList.toggle('hot', m.candidate);
    $('#g-level').textContent = isFinite(m.level) ? m.level.toFixed(0) : '—';
    $('#m-base').textContent = isFinite(m.base) ? m.base.toFixed(0) + ' dB' : '—';
    $('#m-ratio').textContent = (m.ratio * 100).toFixed(0) + '%';
    $('#m-f0').textContent = m.f0 ? Math.round(m.f0) + ' Hz' : '—';
    drawSpectrum(m);
  }

  function drawSpectrum(m) {
    var cv = $('#spectrum');
    if (!specCtx) {
      var dpr = window.devicePixelRatio || 1;
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
      specCtx = cv.getContext('2d');
      specCtx.scale(dpr, dpr);
    }
    var w = cv.clientWidth, h = cv.clientHeight, g = specCtx;
    g.clearRect(0, 0, w, h);

    var maxBin = Math.min(m.spectrum.length - 1, Math.round(6000 / m.binWidth));
    var bars = 64, step = maxBin / bars;
    for (var i = 0; i < bars; i++) {
      var a = Math.floor(i * step), b = Math.floor((i + 1) * step);
      var peak = -160;
      for (var j = a; j <= b; j++) if (m.spectrum[j] > peak) peak = m.spectrum[j];
      var v = Math.max(0, Math.min(1, (peak + 100) / 70));   // -100..-30dB → 0..1
      var bh = v * (h - 6);
      var hz = (a + b) / 2 * m.binWidth;
      // 울음 판정 대역(300~1000Hz)만 강조
      g.fillStyle = (hz >= 300 && hz <= 1000)
        ? (m.candidate ? 'rgba(255,215,154,.95)' : 'rgba(90,208,196,.8)')
        : 'rgba(139,123,240,.35)';
      g.fillRect(i * (w / bars) + 1, h - bh - 3, (w / bars) - 2, bh);
    }
    // f0 표시
    if (m.f0) {
      var x = (m.f0 / 6000) * w;
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.fillRect(x, 0, 1, h);
    }
  }

  // ---------- 기록 ----------
  function markSlept() {
    if (!session || session.logged) return;
    var sec = Math.round((Date.now() - session.t0) / 1000);
    addLog({ t: Date.now(), preset: session.presetId, sec: sec, auto: !!session.auto });
    session.logged = true;
    $('#btn-slept').disabled = true;
    $('#btn-slept').textContent = mmss(sec) + ' 기록됨 ✓';
    $('#btn-false').hidden = true;
    toast(mmss(sec) + ' 만에 잠들었어요. 소리는 계속 둡니다.');
  }

  function markFalsePositive() {
    bumpDet('fp');
    stopPlayback();
    toast('오탐으로 기록했습니다. 민감도를 낮춰보세요.');
    resumeListen();
  }

  function statsHtml() {
    var log = getLog();
    var det = getDet();
    var h = '';

    if (det.detect) {
      var ok = det.detect - det.fp;
      var acc = Math.round(ok / det.detect * 100);
      h += '<h3>울음 감지</h3><table class="stats"><tbody>' +
        '<tr><td>자동 시작</td><td>' + det.detect + '회</td></tr>' +
        '<tr><td>오탐</td><td>' + det.fp + '회</td></tr>' +
        '<tr class="' + (acc >= 80 ? 'best' : '') + '"><td>정확도</td><td>' + acc + '%</td></tr>' +
        '</tbody></table>';
    }

    if (!log.length) {
      return h + '<p class="empty">아직 수면 기록이 없습니다.<br>재우고 나서 “잠들었어요”를 눌러주세요.</p>' +
        '<p style="font-size:12.5px;color:#6f6990;line-height:1.7">' +
        '며칠만 쌓이면 우리 아이에게 어떤 소리가 제일 빨리 먹히는지 숫자로 나옵니다.</p>';
    }

    var by = {};
    log.forEach(function (e) { (by[e.preset] = by[e.preset] || []).push(e.sec); });
    var rows = Object.keys(by).map(function (id) {
      var p = window.SW_getPreset(id), secs = by[id];
      return { name: p.emoji + ' ' + p.name, n: secs.length, med: median(secs), best: Math.min.apply(null, secs) };
    }).sort(function (a, b) { return a.med - b.med; });

    h += '<h3>소리별 수면 소요시간</h3>';
    h += '<table class="stats"><thead><tr><th>소리</th><th>횟수</th><th>중앙값</th><th>최단</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      h += '<tr class="' + (i === 0 && r.n >= 3 ? 'best' : '') + '"><td>' + r.name + '</td><td>' + r.n +
        '</td><td>' + mmss(r.med) + '</td><td>' + mmss(r.best) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<h3>' + (rows[0].n >= 3
      ? '가장 빠른 건 ' + rows[0].name + ' (중앙값 ' + mmss(rows[0].med) + ')'
      : '각 소리를 3회 이상 써야 비교가 의미 있어집니다.') + '</h3>';

    h += '<h3>최근 기록</h3><div class="log-list">';
    log.slice(0, 12).forEach(function (e) {
      var d = new Date(e.t);
      var when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      h += '<div><span>' + when + ' · ' + window.SW_getPreset(e.preset).name + (e.auto ? ' 🎤' : '') +
        '</span><span>' + mmss(e.sec) + '</span></div>';
    });
    h += '</div><button class="danger" id="btn-clear">기록 전체 삭제</button>';
    return h;
  }

  var SAFETY_HTML =
    '<p class="warn">백색소음기는 잘못 쓰면 청력에 해롭습니다. 아래는 지켜주세요.</p>' +
    '<h3>볼륨</h3><ul>' +
    '<li>미국소아과학회(AAP) 권고 기준 <b>50dB 이하</b>. 어른이 보통 목소리로 대화할 수 있는 정도입니다.</li>' +
    '<li>이 앱은 처음 20초만 일부러 크게 시작하고 2분에 걸쳐 저절로 줄어듭니다. 그 뒤로 더 키우지 마세요.</li>' +
    '</ul>' +
    '<h3>거리</h3><ul>' +
    '<li>침대·바운서에서 <b>최소 2m</b> 떨어뜨려 두세요. 머리맡에 두지 않습니다.</li>' +
    '<li>폰을 아기 손이 닿는 곳에 두지 마세요.</li>' +
    '</ul>' +
    '<h3>시간</h3><ul>' +
    '<li>밤새 틀어두지 말고 <b>잠든 뒤 30~60분</b>이면 끄는 쪽을 권합니다. 종료 타이머를 쓰세요.</li>' +
    '</ul>' +
    '<h3>대기 모드와 마이크</h3><ul>' +
    '<li>소리는 <b>기기 밖으로 나가지 않습니다.</b> 녹음하지 않고, 어디로도 전송하지 않습니다. 주파수만 보고 바로 버립니다.</li>' +
    '<li>자동 시작은 보조 수단입니다. 평소와 다른 울음이면 소리를 끄고 아이 상태를 먼저 보세요.</li>' +
    '</ul>';

  function openSheet(title, html) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    var clear = $('#btn-clear');
    if (clear) clear.addEventListener('click', function () {
      if (confirm('기록을 전부 지울까요?')) {
        save(LS_LOG, []); save(LS_DET, { detect: 0, fp: 0 });
        $('#sheet-body').innerHTML = statsHtml();
      }
    });
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

  // ---------- 디밍 ----------
  function armDim(listening) {
    disarmDim();
    dimId = setTimeout(function () {
      if (!session && !listenMode) return;
      var d = $('#dim');
      d.classList.toggle('listening', !!listening);
      $('#dim-text').textContent = listening ? '듣고 있습니다 · 탭하면 밝아집니다' : '탭하면 밝아집니다';
      d.hidden = false;
    }, 8000);
  }
  function disarmDim() { clearTimeout(dimId); dimId = null; }
  function hideDim() { $('#dim').hidden = true; }

  $('#dim').addEventListener('click', function () { hideDim(); armDim(listenMode && !session); });
  $('#player').addEventListener('pointerdown', function () { if (session) armDim(false); });
  $('#listen').addEventListener('pointerdown', function () { if (listenMode) armDim(true); });

  // ---------- Wake Lock ----------
  function requestWake(force) {
    if ((!pref.wake && !force) || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }, function () { });
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (listenMode) requestWake(true);
    else if (session && pref.wake) requestWake(false);
  });

  // ---------- 잠금화면 ----------
  function setMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var p = window.SW_getPreset(pref.presetId);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: p.emoji + ' ' + p.name,
        artist: 'SleepWell · 2분 수면 유도',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.setActionHandler('pause', function () { stopAll(); });
      navigator.mediaSession.setActionHandler('stop', function () { stopAll(); });
    } catch (e) { }
  }

  // ---------- 바인딩 ----------
  $('#btn-play').addEventListener('click', function () { start(false); });
  $('#btn-listen').addEventListener('click', startListen);
  $('#btn-listen-stop').addEventListener('click', stopAll);
  $('#btn-stop').addEventListener('click', stopAll);
  $('#btn-slept').addEventListener('click', markSlept);
  $('#btn-false').addEventListener('click', markFalsePositive);
  $('#btn-stats').addEventListener('click', function () { openSheet('기록', statsHtml()); });
  $('#btn-safety').addEventListener('click', function () { openSheet('안전 수칙', SAFETY_HTML); });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#toggle-wake').addEventListener('click', function () {
    pref.wake = !pref.wake; savePref(); syncWakeToggle();
    if (!pref.wake && !listenMode) releaseWake(); else if (session) requestWake(false);
  });
  window.addEventListener('pagehide', function () { releaseWake(); if (detector) detector.stop(); });

  // ---------- 시작 ----------
  buildPresets(); updateDesc(); buildTimers(); buildSens(); syncWakeToggle();
  setTimeout(prerender, 400);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
})();
