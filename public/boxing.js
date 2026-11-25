/* Rhythm Boxing — punch the phone on the beat to hit targets. */
(() => {
  const cv  = document.getElementById('game');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const socket = io();
  socket.on('connect', () => socket.emit('hello', 'display'));

  fetch('/api/info').then(r => r.json()).then(({ ip, zigPort }) => {
    const i = document.getElementById('ip'), p = document.getElementById('port');
    if (i) i.textContent = ip;
    if (p) p.textContent = zigPort;
  }).catch(() => {});
  document.getElementById('closeCard').addEventListener('click', () =>
    document.getElementById('card').classList.add('hidden'));
  document.getElementById('setupBtn').addEventListener('click', () =>
    document.getElementById('card').classList.toggle('hidden'));

  // ── Canvas ──────────────────────────────────────────────────────────────
  let W = 0, H = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    cv.width  = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width  = W + 'px';
    cv.style.height = H + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Audio ─────────────────────────────────────────────────────────────────
  let ac = null;

  function ensureAudio() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }

  function kick() {
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator(), env = ac.createGain();
    osc.connect(env); env.connect(ac.destination);
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    env.gain.setValueAtTime(0.85, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.start(t); osc.stop(t + 0.25);
  }

  function hihat(vol = 0.25) {
    if (!ac) return;
    const t = ac.currentTime;
    const len = Math.ceil(ac.sampleRate * 0.06);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const filt = ac.createBiquadFilter();
    filt.type = 'highpass'; filt.frequency.value = 7500;
    const env = ac.createGain();
    src.connect(filt); filt.connect(env); env.connect(ac.destination);
    env.gain.setValueAtTime(vol, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.start(t); src.stop(t + 0.06);
  }

  function hitSfx(quality) {
    if (!ac) return;
    const t = ac.currentTime;
    const freq = quality === 'PERFECT' ? 880 : quality === 'GREAT' ? 660 : 440;
    const osc = ac.createOscillator(), env = ac.createGain();
    osc.connect(env); env.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.2, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.4, t + 0.1);
    env.gain.setValueAtTime(0.55, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.start(t); osc.stop(t + 0.15);
  }

  // ── Constants ─────────────────────────────────────────────────────────────
  const BPM        = 120;
  const BEAT_MS    = 60000 / BPM;   // 500 ms
  const TARGET_R   = 36;             // px
  const PUNCH_THRESH = 4.8;          // m/s² linear accel to register punch
  const PUNCH_COOL   = 340;          // ms cooldown
  // Timing windows (fraction of beat; hit moment = 0.5 of target lifetime)
  const WIN_PERFECT = 0.15;
  const WIN_GREAT   = 0.30;
  const WIN_GOOD    = 0.50;

  // ── ZIGSIM inputs ─────────────────────────────────────────────────────────
  let zigLive = false, hasAccel = false;
  let punchCooldownAt = 0;

  socket.on('zig', ({ connected }) => { zigLive = connected; });
  socket.on('sensor:raw', ({ linearAccel }) => {
    if (linearAccel) hasAccel = true;
    if (!linearAccel || g.phase !== 'playing') return;
    const mag = Math.hypot(linearAccel.x, linearAccel.y, linearAccel.z);
    const now = Date.now();
    if (mag > PUNCH_THRESH && now > punchCooldownAt) {
      punchCooldownAt = now + PUNCH_COOL;
      registerPunch();
    }
  });

  // ── Game state ────────────────────────────────────────────────────────────
  const g = {
    phase: 'ready',
    score: 0, combo: 0, bestCombo: 0,
    targets: [],    // { x, y, spawnTime, hit, expired }
    popups: [],     // { text, x, y, color, alpha, vy }
    beatNum: 0, lastBeat: -1, beatPhase: 0,
    gameStart: 0,
    flashAlpha: 0, flashClr: '255,255,255',
  };

  function getMultiplier() {
    return parseFloat(Math.min(1 + Math.floor(g.combo / 5) * 0.5, 4.0).toFixed(1));
  }

  function addPopup(text, x, y, color) {
    g.popups.push({ text, x, y, color, alpha: 1, vy: -1.2 });
  }

  function onBeat(beatIndex) {
    const beat = beatIndex % 4;
    if (beat === 0 || beat === 2) kick();
    hihat(beat === 0 || beat === 2 ? 0.18 : 0.3);

    const margin = 100;
    const tx = margin + Math.random() * (W - 2 * margin);
    const ty = margin + 30 + Math.random() * (H - 2 * margin - 60);
    g.targets.push({ x: tx, y: ty, spawnTime: performance.now(), hit: false, expired: false });
  }

  function registerPunch() {
    const now = performance.now();
    let best = null, bestOff = Infinity;

    for (const t of g.targets) {
      if (t.hit || t.expired) continue;
      const age = (now - t.spawnTime) / BEAT_MS;
      const off = Math.abs(age - 0.5);
      if (off < bestOff) { bestOff = off; best = t; }
    }

    if (best && bestOff < WIN_GOOD) {
      best.hit = true;
      let quality, pts;
      if (bestOff < WIN_PERFECT)     { quality = 'PERFECT'; pts = 100; }
      else if (bestOff < WIN_GREAT)  { quality = 'GREAT';   pts = 70;  }
      else                           { quality = 'GOOD';    pts = 40;  }

      g.combo++;
      g.bestCombo = Math.max(g.bestCombo, g.combo);
      const mult = getMultiplier();
      g.score += Math.round(pts * mult);

      hitSfx(quality);
      const clr = quality === 'PERFECT' ? '#ffd700' : quality === 'GREAT' ? '#7eb0ff' : '#4bd88a';
      addPopup(quality, best.x, best.y - 20, clr);
      if (mult > 1) addPopup(`×${mult}`, best.x, best.y - 55, 'rgba(255,255,255,0.8)');

      g.flashAlpha = 0.22;
      g.flashClr = quality === 'PERFECT' ? '255,210,30' : quality === 'GREAT' ? '79,140,255' : '43,213,118';
    } else {
      // Swing with no valid target
      g.flashAlpha = 0.1; g.flashClr = '255,100,100';
    }
  }

  function startGame() {
    ensureAudio();
    g.phase = 'playing';
    g.score = 0; g.combo = 0; g.targets = []; g.popups = [];
    g.gameStart = performance.now();
    g.lastBeat = -1;
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (g.phase === 'ready') { startGame(); return; }
      if (g.phase === 'playing') {
        const now = Date.now();
        if (now > punchCooldownAt) {
          punchCooldownAt = now + PUNCH_COOL;
          registerPunch();
        }
      }
    }
  });

  // ── Tick ──────────────────────────────────────────────────────────────────
  function tick() {
    const now = performance.now();
    const elapsed = now - g.gameStart;
    const beat = Math.floor(elapsed / BEAT_MS);
    g.beatPhase = (elapsed % BEAT_MS) / BEAT_MS;

    if (beat > g.lastBeat) {
      g.lastBeat = beat;
      onBeat(beat);
    }

    // Expire targets + combo break on miss
    for (const t of g.targets) {
      if (t.hit || t.expired) continue;
      const age = (now - t.spawnTime) / BEAT_MS;
      if (age > 1.05) {
        t.expired = true;
        if (!t.hit) {
          g.combo = 0;
          addPopup('MISS', t.x, t.y, '#ff4444');
        }
      }
    }
    g.targets = g.targets.filter(t => (now - t.spawnTime) / BEAT_MS < 1.3);

    for (const p of g.popups) { p.y += p.vy; p.alpha -= 0.02; }
    g.popups = g.popups.filter(p => p.alpha > 0);

    if (g.flashAlpha > 0) g.flashAlpha -= 0.012;
  }

  // ── Draw ──────────────────────────────────────────────────────────────────
  function draw() {
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d0009';
    ctx.fillRect(0, 0, W, H);

    // Beat pulse rings (background atmosphere)
    if (g.phase === 'playing') {
      for (let r = 0; r < 3; r++) {
        const phase = (g.beatPhase + r / 3) % 1;
        const rr = Math.min(W, H) * (0.15 + 0.35 * phase);
        const alpha = (1 - phase) * 0.07;
        ctx.beginPath(); ctx.arc(W / 2, H / 2, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,50,50,${alpha})`;
        ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // Punch flash overlay
    if (g.flashAlpha > 0) {
      ctx.fillStyle = `rgba(${g.flashClr},${g.flashAlpha.toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // ── Targets ──────────────────────────────────────────────────────────────
    const now = performance.now();
    for (const t of g.targets) {
      if (t.expired) continue;
      const age  = (now - t.spawnTime) / BEAT_MS;
      if (age < 0 || age > 1.1) continue;

      // Target alpha
      const tAlpha = t.hit
        ? Math.max(0, 1 - (age - 0.5) * 4)
        : (age < 0.08 ? age / 0.08 : age > 0.82 ? Math.max(0, (1 - age) / 0.18) : 1);
      if (tAlpha <= 0) continue;

      // Approach ring: 3× → 1× as age goes 0 → 0.5
      const approachFrac = Math.min(1, age / 0.5);
      const approachR    = TARGET_R * (3 - 2 * approachFrac);

      // Color based on current timing proximity
      const off = Math.abs(age - 0.5);
      const col = off < WIN_PERFECT ? '#ffd700' : off < WIN_GREAT ? '#7eb0ff' : '#ff4b4b';

      ctx.globalAlpha = tAlpha;

      // Approach ring
      if (!t.hit && approachR > TARGET_R + 1) {
        ctx.beginPath(); ctx.arc(t.x, t.y, approachR, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
      }

      // Target fill
      ctx.beginPath(); ctx.arc(t.x, t.y, TARGET_R, 0, Math.PI * 2);
      if (t.hit) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
      } else {
        const rgb = off < WIN_PERFECT ? '255,215,0' : off < WIN_GREAT ? '79,140,255' : '255,75,75';
        ctx.fillStyle = `rgba(${rgb},0.14)`;
      }
      ctx.fill();
      ctx.strokeStyle = t.hit ? 'rgba(255,255,255,0.25)' : col;
      ctx.lineWidth = 3; ctx.stroke();

      // Crosshair inside
      if (!t.hit) {
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(t.x - 11, t.y); ctx.lineTo(t.x + 11, t.y);
        ctx.moveTo(t.x, t.y - 11); ctx.lineTo(t.x, t.y + 11);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }

    // Popups
    ctx.textAlign = 'center';
    for (const p of g.popups) {
      if (p.alpha <= 0) continue;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.font = `bold ${Math.round(H * 0.032)}px -apple-system,sans-serif`;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // Score HUD
    if (g.phase === 'playing') {
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(H * 0.07)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(g.score.toLocaleString(), W / 2, 72);

      const mult = getMultiplier();
      ctx.font = `600 ${Math.round(H * 0.022)}px -apple-system,sans-serif`;
      ctx.fillStyle = g.combo > 0 ? 'rgba(255,210,30,0.85)' : 'rgba(255,255,255,0.35)';
      ctx.fillText(
        g.combo > 0 ? `${g.combo} COMBO  ×${mult}` : 'No combo',
        W / 2, 104
      );

      // Beat progress bar
      const bw = W * 0.55, bh = 5, bx = (W - bw) / 2, by = H - 28;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 3); ctx.fill();
      const barFill = 1 - g.beatPhase; // full at beat, drains to 0
      ctx.fillStyle = `rgba(255,60,60,${0.5 + 0.4 * barFill})`;
      ctx.beginPath(); ctx.roundRect(bx, by, bw * barFill, bh, 3); ctx.fill();

      if (!hasAccel) {
        ctx.font = `${Math.round(H * 0.018)}px -apple-system,sans-serif`;
        ctx.fillStyle = 'rgba(255,160,40,0.8)';
        ctx.fillText('⚠ Enable Accelerometer in ZIGSIM — SPACE works as punch', W / 2, H - 46);
      }
    }

    // Ready screen
    if (g.phase === 'ready') {
      ctx.textAlign = 'center';
      const t2 = Date.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t2 * (BPM / 60) * Math.PI * 2);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 65 + pulse * 22, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,60,60,${0.25 + pulse * 0.35})`;
      ctx.lineWidth = 3; ctx.stroke();

      ctx.font = `${Math.round(H * 0.07)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText('🥊', W / 2, H / 2 - 10);
      ctx.font = `bold ${Math.round(H * 0.036)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText('Rhythm Boxing', W / 2, H / 2 + 50);
      ctx.font = `${Math.round(H * 0.022)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.fillText('Punch phone or press SPACE to start', W / 2, H / 2 + 90);
    }

    // Status dot
    ctx.fillStyle = zigLive ? '#2bd576' : '#606472';
    ctx.beginPath(); ctx.arc(W - 22, 22, 5, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function frame() {
    if (g.phase === 'playing') tick();
    draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
