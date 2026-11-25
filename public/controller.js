/* Controller — runs on the phone. Reads tilt + touch and streams brush events. */
(() => {
  const socket = io();
  const conn = document.getElementById('conn');
  socket.on('connect', () => {
    socket.emit('hello', 'controller');
    conn.textContent = 'connected to whiteboard ✓';
  });
  socket.on('disconnect', () => { conn.textContent = 'disconnected — reconnecting…'; });

  // --- Palette -------------------------------------------------------------
  const BOARD_BG = '#f7f7f8'; // eraser paints with the board colour
  const COLORS = ['#1b1d22', '#ff3b3b', '#4f8cff', '#23c552', '#ff9f1c', '#a55eff', BOARD_BG];
  let color = COLORS[0];
  let size = 10;

  const swatches = document.getElementById('swatches');
  COLORS.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'swatch' + (i === 0 ? ' sel' : '') + (c === BOARD_BG ? ' eraser' : '');
    el.style.background = c;
    if (c === BOARD_BG) el.textContent = '⌫';
    el.onclick = () => {
      color = c;
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
      el.classList.add('sel');
      document.documentElement.style.setProperty('--brush', c === BOARD_BG ? '#9aa0ab' : c);
      socket.emit('brush:color', { color });
    };
    swatches.appendChild(el);
  });

  document.getElementById('size').oninput = (e) => {
    size = +e.target.value;
    socket.emit('brush:size', { size });
  };

  // --- Tilt → position -----------------------------------------------------
  // Capture an origin orientation, then map deviation from it to the canvas.
  // `range` degrees of tilt span the full board; smaller range = faster aim.
  let beta0 = null, gamma0 = null;
  // `range` = degrees of tilt needed to reach a board edge. Slider is inverted
  // so sliding right (higher value) = smaller range = faster, twitchier aim.
  const sensToRange = (v) => (380 - v) / 10; // 60..320 -> 32°..6°
  let range = sensToRange(200);
  document.getElementById('sens').oninput = (e) => { range = sensToRange(+e.target.value); };

  function onOrient(e) {
    if (e.gamma == null || e.beta == null) return;
    if (gamma0 == null) { gamma0 = e.gamma; beta0 = e.beta; }
    const nx = clamp01(0.5 + (e.gamma - gamma0) / (range * 2));
    const ny = clamp01(0.5 + (e.beta - beta0) / (range * 2));
    socket.emit('brush:move', { x: nx, y: ny });
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  document.getElementById('recenter').onclick = () => {
    beta0 = gamma0 = null; // next reading becomes the new centre
    navigator.vibrate && navigator.vibrate(15);
  };
  document.getElementById('clear').onclick = () => {
    socket.emit('brush:clear');
    navigator.vibrate && navigator.vibrate([10, 40, 10]);
  };

  // --- Pen down (hold the pad) --------------------------------------------
  const pad = document.getElementById('pad');
  let penDown = false;
  function down(e) {
    if (e.cancelable) e.preventDefault();
    if (penDown) return;
    penDown = true;
    pad.classList.add('painting');
    socket.emit('brush:down');
    navigator.vibrate && navigator.vibrate(8);
  }
  function up(e) {
    if (e && e.cancelable) e.preventDefault();
    if (!penDown) return;
    penDown = false;
    pad.classList.remove('painting');
    socket.emit('brush:up');
  }
  pad.addEventListener('touchstart', down, { passive: false });
  pad.addEventListener('touchend', up, { passive: false });
  pad.addEventListener('touchcancel', up, { passive: false });
  // Mouse fallback (desktop testing)
  pad.addEventListener('mousedown', down);
  addEventListener('mouseup', up);

  // --- Keep screen awake while painting -----------------------------------
  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
  });

  // --- Start (one tap — required by iOS to grant motion access) -----------
  const startEl = document.getElementById('start');
  document.getElementById('startBtn').onclick = async () => {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          conn.textContent = 'Motion access denied — enable it in Settings ▸ Safari.';
          return;
        }
      }
    } catch (_) { /* non-iOS browsers throw; safe to ignore */ }

    window.addEventListener('deviceorientation', onOrient);
    keepAwake();
    startEl.classList.add('hidden');
  };
})();
