/* SleepWell — 플레이어 / UI / 기록 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var LS_LOG = 'sleepwell.log.v1';
  var LS_PREF = 'sleepwell.pref.v1';
  var TIMERS = [
    { min: 30, label: '30분' },
    { min: 45, label: '45분' },
    { min: 60, label: '60분' },
    { min: 0, label: '무한' }
  ];

  var A = $('#a-main');   // 유도 트랙 (128초, 1회)
  var B = $('#a-hold');   // 유지 루프 (무한) / 페이드아웃

  var pref = load(LS_PREF, { presetId: 'shush', timerMin: 45, wake: false });
  var cache = null;        // {presetId, assets}
  var session = null;      // {presetId, t0, logged, timerId}
  var tickId = null, dimId = null, wakeLock = null, silent = null;

  // ---------- 저장소 ----------
  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v || dflt; } catch (e) { return dflt; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function savePref() { save(LS_PREF, pref); }

  function getLog() { var l = load(LS_LOG, []); return Array.isArray(l) ? l : []; }
  function addLog(entry) { var l = getLog(); l.unshift(entry); save(LS_LOG, l.slice(0, 300)); }

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
      b.className = 'preset';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(p.id === pref.presetId));
      b.innerHTML = '<span class="emo">' + p.emoji + '</span><span class="nm">' + p.name + '</span>';
      b.addEventListener('click', function () {
        pref.presetId = p.id; savePref();
        buildPresets(); updateDesc();
        prerender();
      });
      wrap.appendChild(b);
    });
  }

  function updateDesc() { $('#preset-desc').textContent = window.SW_getPreset(pref.presetId).desc; }

  function buildTimers() {
    var wrap = $('#timers');
    wrap.innerHTML = '';
    TIMERS.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = t.label;
      b.setAttribute('aria-pressed', String(t.min === pref.timerMin));
      b.addEventListener('click', function () { pref.timerMin = t.min; savePref(); buildTimers(); });
      wrap.appendChild(b);
    });
  }

  function syncWakeToggle() { $('#toggle-wake').setAttribute('aria-checked', String(!!pref.wake)); }

  // ---------- 렌더링 (소리 굽기) ----------
  function prerender() {
    if (cache && cache.presetId === pref.presetId) return Promise.resolve(cache.assets);
    var p = window.SW_getPreset(pref.presetId);
    setPlayLabel('소리 만드는 중…', true);
    return new Promise(function (resolve) {
      // 스피너/라벨이 먼저 그려지도록 한 프레임 양보
      requestAnimationFrame(function () {
        setTimeout(function () {
          if (cache) window.SW.revoke(cache.assets);
          var assets = window.SW.renderPreset(p);
          cache = { presetId: p.id, assets: assets };
          setPlayLabel('시작', false);
          resolve(assets);
        }, 0);
      });
    });
  }

  function setPlayLabel(text, disabled) {
    $('#play-label').textContent = text;
    $('#btn-play').disabled = !!disabled;
  }

  // ---------- 오디오 언락 ----------
  /* iOS는 "사용자 제스처 핸들러 안에서 play()를 호출한 적 있는" 엘리먼트만
     이후 프로그램적으로 재생할 수 있다. 탭 순간 무음 WAV로 두 엘리먼트를 깨운다. */
  function unlock() {
    if (!silent) silent = window.SW.silentUrl();
    [A, B].forEach(function (el) {
      if (el.dataset.unlocked) return;
      try {
        el.src = silent;
        var pr = el.play();
        // 무음 재생 약속이 늦게 resolve 되면서 방금 시작한 본 트랙을 멈추지 않도록,
        // src가 아직 무음일 때만 pause 한다.
        if (pr && pr.then) pr.then(function () { if (el.src === silent) el.pause(); }, function () { });
        el.dataset.unlocked = '1';
      } catch (e) { }
    });
  }

  // ---------- 재생 ----------
  function start() {
    unlock();                       // 반드시 제스처 안에서 동기 호출
    prerender().then(function (assets) {
      A.loop = false;
      A.src = assets.induction;
      B.loop = true;
      B.src = assets.hold;
      B.load();
      A.currentTime = 0;
      var pr = A.play();
      if (pr && pr.catch) pr.catch(function (e) { toast('재생 실패: 화면을 한 번 더 탭해주세요'); });

      session = { presetId: pref.presetId, t0: Date.now(), logged: false, timerId: null };
      if (pref.timerMin > 0) {
        session.timerId = setTimeout(fadeOut, pref.timerMin * 60 * 1000);
      }
      showPlayer();
      requestWake();
      setMediaSession();
    });
  }

  A.addEventListener('ended', function () {
    if (!session) return;
    B.loop = true;
    B.currentTime = 0;
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

  B.addEventListener('ended', function () { if (!B.loop && session) stop(true); });

  function stop(auto) {
    if (session && session.timerId) clearTimeout(session.timerId);
    try { A.pause(); } catch (e) { }
    try { B.pause(); } catch (e) { }
    A.removeAttribute('src'); B.removeAttribute('src');
    session = null;
    releaseWake();
    showHome();
    if (auto) toast('타이머 종료');
  }

  // ---------- 화면 전환 ----------
  function showPlayer() {
    $('#home').hidden = true;
    $('#player').hidden = false;
    $('#btn-slept').disabled = false;
    $('#btn-slept').textContent = '잠들었어요 😴';
    tick();
    tickId = setInterval(tick, 500);
    armDim();
  }

  function showHome() {
    clearInterval(tickId); tickId = null;
    disarmDim(); hideDim();
    $('#player').hidden = true;
    $('#home').hidden = false;
  }

  function tick() {
    if (!session) return;
    var el = (Date.now() - session.t0) / 1000;
    $('#elapsed').textContent = mmss(el);
    var IND = window.SW.INDUCTION_SEC, HOOK = window.SW.HOOK_SEC;
    var pct = Math.min(1, el / IND);
    $('#bar-fill').style.width = (pct * 100).toFixed(1) + '%';

    if (el < HOOK) {
      $('#phase-label').textContent = '덮는 중';
      $('#phase-sub').textContent = '울음을 덮는 구간입니다. 지금 볼륨이 울음소리보다 살짝 크면 적당합니다.';
    } else if (el < IND) {
      $('#phase-label').textContent = '유도 중';
      $('#phase-sub').textContent = '소리가 ' + mmss(IND - el) + ' 동안 서서히 멀어집니다. 안아서 토닥이는 리듬을 함께 유지해 주세요.';
    } else {
      $('#phase-label').textContent = '유지 중';
      $('#phase-sub').textContent = pref.timerMin > 0
        ? '총 ' + pref.timerMin + '분 뒤 서서히 꺼집니다.'
        : '정지할 때까지 계속됩니다.';
    }
  }

  // ---------- 기록 ----------
  function markSlept() {
    if (!session || session.logged) return;
    var sec = Math.round((Date.now() - session.t0) / 1000);
    addLog({ t: Date.now(), preset: session.presetId, sec: sec });
    session.logged = true;
    $('#btn-slept').disabled = true;
    $('#btn-slept').textContent = mmss(sec) + ' 기록됨 ✓';
    toast(mmss(sec) + ' 만에 잠들었어요. 소리는 계속 둡니다.');
  }

  function statsHtml() {
    var log = getLog();
    if (!log.length) {
      return '<p class="empty">아직 기록이 없습니다.<br>재우고 나서 “잠들었어요”를 눌러주세요.</p>' +
        '<p style="font-size:12.5px;color:#6f6990;line-height:1.7">' +
        '며칠만 쌓이면 윤서에게 어떤 소리가 제일 빨리 먹히는지 숫자로 나옵니다. ' +
        '그 프리셋을 기본값으로 쓰면 됩니다.</p>';
    }
    var by = {};
    log.forEach(function (e) { (by[e.preset] = by[e.preset] || []).push(e.sec); });
    var rows = Object.keys(by).map(function (id) {
      var p = window.SW_getPreset(id);
      var secs = by[id];
      return { id: id, name: p.emoji + ' ' + p.name, n: secs.length, med: median(secs), best: Math.min.apply(null, secs) };
    }).sort(function (a, b) { return a.med - b.med; });

    var h = '<table class="stats"><thead><tr><th>소리</th><th>횟수</th><th>중앙값</th><th>최단</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      h += '<tr class="' + (i === 0 && r.n >= 3 ? 'best' : '') + '"><td>' + r.name + '</td><td>' + r.n +
        '</td><td>' + mmss(r.med) + '</td><td>' + mmss(r.best) + '</td></tr>';
    });
    h += '</tbody></table>';

    if (rows[0].n >= 3) {
      h += '<h3>지금까지 가장 빠른 건 ' + rows[0].name + ' (중앙값 ' + mmss(rows[0].med) + ')</h3>';
    } else {
      h += '<h3>각 소리를 3회 이상 써야 비교가 의미 있어집니다.</h3>';
    }

    h += '<h3>최근 기록</h3><div class="log-list">';
    log.slice(0, 12).forEach(function (e) {
      var d = new Date(e.t);
      var when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      h += '<div><span>' + when + ' · ' + window.SW_getPreset(e.preset).name + '</span><span>' + mmss(e.sec) + '</span></div>';
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
    '<li>매번 같은 소리를 쓰면 수면 의식(sleep cue)이 되어 더 빨리 듣습니다.</li>' +
    '</ul>' +
    '<h3>이 앱이 하지 않는 것</h3><ul>' +
    '<li>의학적 판단을 하지 않습니다. 평소와 다른 울음이면 소리를 끄고 아이 상태를 먼저 보세요.</li>' +
    '</ul>';

  function openSheet(title, html) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    var clear = $('#btn-clear');
    if (clear) clear.addEventListener('click', function () {
      if (confirm('기록을 전부 지울까요?')) { save(LS_LOG, []); $('#sheet-body').innerHTML = statsHtml(); }
    });
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

  // ---------- 디밍 ----------
  function armDim() {
    disarmDim();
    dimId = setTimeout(function () { if (session) $('#dim').hidden = false; }, 8000);
  }
  function disarmDim() { clearTimeout(dimId); dimId = null; }
  function hideDim() { $('#dim').hidden = true; }

  $('#dim').addEventListener('click', function () { hideDim(); armDim(); });
  $('#player').addEventListener('pointerdown', function () { if (session) armDim(); });

  // ---------- Wake Lock ----------
  function requestWake() {
    if (!pref.wake || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }, function () { });
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && session && pref.wake) requestWake();
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
      navigator.mediaSession.setActionHandler('pause', function () { stop(false); });
      navigator.mediaSession.setActionHandler('stop', function () { stop(false); });
    } catch (e) { }
  }

  // ---------- 바인딩 ----------
  $('#btn-play').addEventListener('click', start);
  $('#btn-stop').addEventListener('click', function () { stop(false); });
  $('#btn-slept').addEventListener('click', markSlept);
  $('#btn-stats').addEventListener('click', function () { openSheet('기록', statsHtml()); });
  $('#btn-safety').addEventListener('click', function () { openSheet('안전 수칙', SAFETY_HTML); });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#toggle-wake').addEventListener('click', function () {
    pref.wake = !pref.wake; savePref(); syncWakeToggle();
    if (!pref.wake) releaseWake(); else if (session) requestWake();
  });

  // 재생 중 새로고침/이탈 방지용 정리
  window.addEventListener('pagehide', function () { releaseWake(); });

  // ---------- 시작 ----------
  buildPresets();
  updateDesc();
  buildTimers();
  syncWakeToggle();
  // 첫 탭이 즉시 소리나도록 기본 프리셋을 미리 구워둔다
  setTimeout(prerender, 400);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* http 환경에선 실패해도 앱은 동작 */ });
  }
})();
