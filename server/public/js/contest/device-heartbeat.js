'use strict';
(function () {
  var KEY = 'oj:client-device-id:v1';
  var timer = null;

  function deviceId() {
    var id = localStorage.getItem(KEY);
    if (id && /^[a-zA-Z0-9_-]{16,64}$/.test(id)) return id;
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'browser-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    localStorage.setItem(KEY, id);
    return id;
  }

  function browserName() {
    if (navigator.userAgentData && navigator.userAgentData.brands) {
      return navigator.userAgentData.brands
        .filter(function (b) { return b.brand !== 'Not_A Brand' && b.brand !== 'Not A(Brand'; })
        .map(function (b) { return b.brand + ' ' + b.version; }).join(', ');
    }
    var chrome = navigator.userAgent.match(/(?:Chrome|CriOS)\/([\d.]+)/);
    return chrome ? 'Chrome ' + chrome[1] : navigator.userAgent.slice(0, 120);
  }

  function payload() {
    var screenInfo = window.screen
      ? window.screen.width + '×' + window.screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'
      : '';
    return {
      deviceId: deviceId(),
      page: location.pathname,
      client: {
        browser: browserName(),
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        screen: screenInfo,
        language: navigator.language || '',
        timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
        crossOriginIsolated: window.crossOriginIsolated === true
      }
    };
  }

  async function beat() {
    if (document.visibilityState === 'hidden') return;
    try {
      var result = await api('/api/contest/devices/heartbeat', {
        method: 'POST',
        body: JSON.stringify(payload())
      });
      var delay = Number(result.nextHeartbeatMs) || 20000;
      clearTimeout(timer);
      timer = setTimeout(beat, delay);
    } catch (_) {
      clearTimeout(timer);
      timer = setTimeout(beat, 30000);
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') beat();
  });
  beat();
})();
