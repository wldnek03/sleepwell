/* SleepWell — 사운드 프리셋 정의
 *
 * 공통 설계: "2분 유도 시퀀스"
 *   0~20초   Hook    : 울음을 덮을 만큼 크고 밝게 시작
 *   20~120초 Descent : 볼륨 ↓ + 저역통과 cutoff ↓ (소리가 멀어지고 뭉개짐) + 심박 감속
 *   120초~   Hold    : 어둡고 일정한 상태로 무한 루프
 *
 * *Start 값 = Hook 구간 파라미터, *Hold 값 = Hold 구간 파라미터.
 */
(function (global) {
  'use strict';

  var PRESETS = [
    {
      id: 'shush',
      name: '쉬-쉬',
      emoji: '🤫',
      desc: '울음을 덮는 리듬형 쉬싱. 이미 울고 있을 때 가장 강력합니다. (5S 기법)',
      noise: 'pink',
      hpf: 220,
      cutStart: 9000, cutHold: 2600,
      gainStart: 1.0, gainHold: 0.42,
      heartStart: 0, heartHold: 0, bpmStart: 70, bpmHold: 56,
      modRateStart: 1.45, modRateHold: 0.72,
      modDepthStart: 0.88, modDepthHold: 0.28,
      hum: 0, drops: false
    },
    {
      id: 'womb',
      name: '자궁 소리',
      emoji: '🫧',
      desc: '저음 중심 + 느려지는 심장박동. 생후 6개월 이전에 특히 잘 듣습니다.',
      noise: 'brown',
      hpf: 28,
      cutStart: 5500, cutHold: 320,
      gainStart: 1.0, gainHold: 0.44,
      heartStart: 0.55, heartHold: 0.34, bpmStart: 74, bpmHold: 54,
      modRateStart: 0, modRateHold: 0,
      modDepthStart: 0, modDepthHold: 0,
      hum: 0, drops: false
    },
    {
      id: 'dryer',
      name: '드라이기',
      emoji: '💨',
      desc: '모터 허밍이 섞인 두꺼운 소음. 집안 생활소음을 통째로 덮어버립니다.',
      noise: 'brown',
      hpf: 60,
      cutStart: 8000, cutHold: 1500,
      gainStart: 1.0, gainHold: 0.45,
      heartStart: 0, heartHold: 0, bpmStart: 70, bpmHold: 60,
      modRateStart: 0, modRateHold: 0,
      modDepthStart: 0, modDepthHold: 0,
      hum: 112, drops: false
    },
    {
      id: 'rain',
      name: '빗소리',
      emoji: '🌧️',
      desc: '창밖 빗소리. 소음에 예민한 아이, 그리고 같이 자는 어른에게 편합니다.',
      noise: 'pink',
      hpf: 420,
      cutStart: 10000, cutHold: 3200,
      gainStart: 1.0, gainHold: 0.40,
      heartStart: 0, heartHold: 0, bpmStart: 70, bpmHold: 60,
      modRateStart: 0.30, modRateHold: 0.17,
      modDepthStart: 0.30, modDepthHold: 0.16,
      hum: 0, drops: true
    }
  ];

  global.SW_PRESETS = PRESETS;
  global.SW_getPreset = function (id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[0];
  };
})(window);
