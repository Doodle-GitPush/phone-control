/* Real Table Tennis — swing the phone to hit, tilt to aim. */
(() => {
  const cv  = document.getElementById('game');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const socket = io();
  socket.on('connect', () => socket.emit('hello', 'display'));

  // Setup card
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

  // ── Constants ────────────────────────────────────────────────────────────
  const BALL_R       = 10;
  const PADDLE_H     = 14;
  const P_EDGE       = 72;
  const SPEED_INIT   = 5.5;
  const SPEED_MAX    = 22;
  const SPEED_BUMP   = 1.05;
  const AI_SPEED     = 5;
  const AI_HIT_RATE  = 0.78;   // AI returns this fraction of balls
  const SWING_THRESH = 4.5;    // m/s² linear-accel magnitude to register a swing
  const SWING_COOL   = 400;    // ms cooldown between swings
  const HIT_GRACE    = 320;    // ms window: swing then ball arrives (or ball first, then swing)
  const HIT_ZONE_PX  = 90;    // px around paddle center where ball can be hit

  function pW()      { return Math.min(W * 0.18, 120); }
  function playerY() { return H - P_EDGE; }
  function aiY()     { return P_EDGE; }

  // ── ZIGSIM inputs ────────────────────────────────────────────────────────
  let phoneX      = 0.5;
  let zigLive     = false;
  let zigSrc      = '';
  let hasAccel    = false;
  let hasGyro     = false;

  // Swing state
  let lastSwingAt = 0;           // timestamp of last detected swing
  let lastSwingPower = 0;        // normalised 0-1
  let lastSwingSpin  = 0;        // gyro.z at swing time

  // A "pending hit": either we swung and ball not yet in zone, or ball in zone and we haven't swung yet.
  // We store the time and resolve when the other condition is met.
  let pendingSwingAt  = 0;       // time swing was registered (0 = no pending swing)
  let pendingBallAt   = 0;       // time ball entered hit zone (0 = ball not in zone)

  socket.on('brush:move', ({ id, x }) => { if (id === 'zigsim') phoneX = x; });
  socket.on('zig', ({ connected, source }) => { zigLive = connected; zigSrc = source || ''; });

  socket.on('sensor:raw', ({ linearAccel, gyro }) => {
    if (linearAccel) hasAccel = true;
    if (gyro)        hasGyro  = true;

    if (!linearAccel) return;
    const mag = Math.hypot(linearAccel.x, linearAccel.y, linearAccel.z);
    const now = Date.now();
    if (mag > SWING_THRESH && now - lastSwingAt > SWING_COOL) {
      lastSwingAt    = now;
      lastSwingPower = Math.min(mag / 12, 1.5);
      lastSwingSpin  = gyro ? gyro.z : 0;
      pendingSwingAt = now;
      g.swingFlash   = 12;     // visual feedback even if miss
    }
  });

  // ── Game state ────────────────────────────────────────────────────────────
  const g = {
    bx: 0, by: 0, bvx: 0, bvy: 0,
    spin: 0,        // lateral drift per frame from gyro
    trail: [],
    px: 0, ax: 0, aiTarget: 0, aiFrame: 0,
    ps: 0, as: 0,
    phase: 'idle',  // idle | playing | scored
    idleFrames: 0,
    flashAlpha: 0, flashClr: '79,140,255',
    lastScorer: '',
    swingFlash: 0,  // frames of white paddle glow on any swing
    hitFlash: 0,    // frames of hit confirmation glow
    hitLabel: '',   // 'PERFECT' | 'GOOD' | ''
    hitLabelAlpha: 0,
    aiHitting: false,
  };

  let initialized = false;

  function launch(toPlayer) {
    g.bx = W / 2; g.by = H / 2; g.trail = [];
    g.spin = 0;
    const angle = (Math.random() - 0.5) * 0.6;
    const dir   = toPlayer ? 1 : -1;
    g.bvx = Math.sin(angle) * SPEED_INIT;
    g.bvy = dir * Math.cos(angle) * SPEED_INIT;
    g.phase = 'playing'; g.idleFrames = 0;
    pendingSwingAt = 0; pendingBallAt = 0;
    g.aiFrame = 0; g.aiTarget = W / 2;
  }

  function scored(byPlayer) {
    if (byPlayer) g.ps++; else g.as++;
    g.lastScorer  = byPlayer ? 'player' : 'ai';
    g.phase       = 'scored';
    g.flashAlpha  = 0.38;
    g.flashClr    = byPlayer ? '79,140,255' : '255,75,75';
    setTimeout(() => { if (g.phase === 'scored') { g.phase = 'idle'; g.idleFrames = 0; } }, 1400);
  }

  function doHit(power, spin, fromAI) {
    const half  = pW() / 2;
    const padX  = fromAI ? g.ax : g.px;
    const relX  = (g.bx - padX) / half;
    const spd   = Math.min(SPEED_INIT * (0.8 + power * 0.7) * SPEED_BUMP, SPEED_MAX);
    const ang   = Math.max(-0.7, Math.min(0.7, relX * 0.65));
    g.bvx       = Math.sin(ang) * spd;
    g.bvy       = fromAI ? Math.cos(ang) * spd : -Math.cos(ang) * spd;
    g.spin      = spin * 0.12;
    if (!fromAI) {
      g.by       = playerY() - PADDLE_H / 2 - BALL_R;
      const dist = Math.abs(g.bx - g.px);
      const qual = dist < 20 ? 'PERFECT' : 'GOOD';
      g.hitFlash      = 14;
      g.hitLabel      = qual;
      g.hitLabelAlpha = 1;
    } else {
      g.by = aiY() + PADDLE_H / 2 + BALL_R;
    }
    pendingSwingAt = 0; pendingBallAt = 0;
  }

  // ── Keyboard fallback ─────────────────────────────────────────────────────
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') { e.preventDefault(); if (g.phase === 'idle') launch(true); }
    if (e.key === 'r' || e.key === 'R') socket.emit('zig:recenter');
    // Spacebar also acts as a swing when playing (keyboard fallback)
    if (e.code === 'Space' && g.phase === 'playing') {
      pendingSwingAt = Date.now();
      lastSwingPower = 0.8; lastSwingSpin = 0;
      g.swingFlash = 12;
    }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // ── Physics tick ──────────────────────────────────────────────────────────
  function tick() {
    const half = pW() / 2;
    const now  = Date.now();

    // Player paddle
    if (keys['ArrowLeft'])       g.px = Math.max(half, g.px - 9);
    else if (keys['ArrowRight']) g.px = Math.min(W - half, g.px + 9);
    else {
      g.px += (phoneX * W - g.px) * 0.18;
    }
    g.px = Math.max(half, Math.min(W - half, g.px));

    // AI paddle
    g.aiFrame++;
    if (g.aiFrame % 9 === 0) {
      if (g.bvy < 0) {
        const frames = (aiY() - g.by) / (g.bvy || -0.1);
        let pred = g.bx + g.bvx * Math.max(0, frames) + (Math.random() - 0.5) * 60;
        g.aiTarget = Math.max(half, Math.min(W - half, pred));
      } else {
        g.aiTarget = W / 2;
      }
    }
    g.ax += Math.sign(g.aiTarget - g.ax) * Math.min(AI_SPEED, Math.abs(g.aiTarget - g.ax));
    g.ax = Math.max(half, Math.min(W - half, g.ax));

    // Ball movement
    g.trail.push({ x: g.bx, y: g.by });
    if (g.trail.length > 10) g.trail.shift();
    g.bx += g.bvx + g.spin;
    g.by += g.bvy;
    g.spin *= 0.96;    // spin decays

    // Wall bounces
    if (g.bx - BALL_R < 0)  { g.bx = BALL_R;     g.bvx =  Math.abs(g.bvx); }
    if (g.bx + BALL_R > W)  { g.bx = W - BALL_R; g.bvx = -Math.abs(g.bvx); }

    // ── Player hit zone logic ───────────────────────────────────────────────
    const py     = playerY();
    const ballNearPlayer = g.bvy > 0 &&
      Math.abs(g.by - py) < HIT_ZONE_PX &&
      Math.abs(g.bx - g.px) < half + BALL_R + 15;

    if (ballNearPlayer) {
      if (pendingBallAt === 0) pendingBallAt = now;

      // Case A: swing is pending, ball just arrived
      if (pendingSwingAt > 0 && now - pendingSwingAt < HIT_GRACE) {
        doHit(lastSwingPower, lastSwingSpin, false);
        return;
      }
      // Case B: ball is here — did a recent swing just happen?
      if (pendingSwingAt > 0 && now - pendingSwingAt < HIT_GRACE) {
        doHit(lastSwingPower, lastSwingSpin, false);
        return;
      }
    } else {
      pendingBallAt = 0;
    }

    // If ball swings pending AND ball enters zone within grace period
    if (pendingSwingAt > 0 && now - pendingSwingAt < HIT_GRACE && ballNearPlayer) {
      doHit(lastSwingPower, lastSwingSpin, false);
      return;
    }

    // Ball passes player paddle (missed swing) → AI scores
    if (g.by > H + BALL_R * 2) { scored(false); return; }

    // ── AI hit zone logic ────────────────────────────────────────────────────
    const ay = aiY();
    if (g.bvy < 0 &&
        g.by - BALL_R <= ay + PADDLE_H / 2 + 5 &&
        g.by + BALL_R >= ay - PADDLE_H / 2 - 5 &&
        Math.abs(g.bx - g.ax) < half + BALL_R) {
      if (!g.aiHitting) {
        g.aiHitting = true;
        if (Math.random() < AI_HIT_RATE) {
          doHit(0.7 + Math.random() * 0.4, (Math.random() - 0.5) * 3, true);
        }
        // If AI misses, ball continues past and scores for player
      }
    } else {
      g.aiHitting = false;
    }

    if (g.by < -BALL_R * 2) { scored(true); return; }

    // Hit label fade
    if (g.hitLabelAlpha > 0) g.hitLabelAlpha -= 0.025;

    // Swing flash countdown
    if (g.swingFlash > 0) g.swingFlash--;
    if (g.hitFlash > 0) g.hitFlash--;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function draw() {
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#196b39';
    ctx.fillRect(0, 0, W, H);

    // Score flash
    if (g.flashAlpha > 0) {
      ctx.fillStyle = `rgba(${g.flashClr},${g.flashAlpha.toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
      g.flashAlpha -= 0.009;
    }

    // Table lines
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.moveTo(8, H / 2); ctx.lineTo(W - 8, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2); ctx.fill();

    // Scores
    const sc = Math.round(Math.min(W, H) * 0.11);
    ctx.textAlign = 'center';
    ctx.font = `bold ${sc}px -apple-system,sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillText(g.as, W / 2, H * 0.32);
    ctx.fillText(g.ps, W / 2, H * 0.74);
    const ls = Math.round(Math.min(W, H) * 0.025);
    ctx.font = `600 ${ls}px -apple-system,sans-serif`;
    ctx.fillStyle = 'rgba(255,75,75,0.45)';
    ctx.fillText('AI', W / 2, H * 0.22);
    ctx.fillStyle = 'rgba(79,140,255,0.45)';
    ctx.fillText('YOU', W / 2, H * 0.84);

    // Hit zone glow when ball near player paddle
    const py  = playerY();
    const ay  = aiY();
    const half = pW() / 2;
    const ballNearPlayer = g.phase === 'playing' && g.bvy > 0 &&
      Math.abs(g.by - py) < HIT_ZONE_PX &&
      Math.abs(g.bx - g.px) < half + 30;
    if (ballNearPlayer) {
      const grd = ctx.createRadialGradient(g.px, py, 0, g.px, py, 80);
      grd.addColorStop(0, 'rgba(255,230,80,0.22)');
      grd.addColorStop(1, 'rgba(255,230,80,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, py - 80, W, 160);
      // "SWING!" prompt
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(H * 0.03)}px -apple-system,sans-serif`;
      ctx.fillStyle = `rgba(255,230,80,${0.5 + 0.4 * Math.sin(Date.now() / 120)})`;
      ctx.fillText('SWING!', W / 2, py - 30);
    }

    // Ball trail
    for (let i = 0; i < g.trail.length; i++) {
      const t = g.trail[i], frac = (i + 1) / g.trail.length;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_R * frac * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(frac * 0.22).toFixed(2)})`;
      ctx.fill();
    }

    // Ball
    if (g.phase !== 'idle') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(g.bx + 3, g.by + 5, BALL_R * 0.9, BALL_R * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(g.bx, g.by, BALL_R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(g.bx - BALL_R * 0.3, g.by - BALL_R * 0.3, BALL_R * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const p = 0.45 + 0.25 * Math.sin(Date.now() / 300);
      ctx.fillStyle = `rgba(255,255,255,${p.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, BALL_R, 0, Math.PI * 2); ctx.fill();
    }

    // Paddles
    const pColor = g.hitFlash > 0 ? '#80c0ff' : (g.swingFlash > 0 ? '#ffffff' : '#4f8cff');
    if (g.hitFlash > 0 || g.swingFlash > 0) { ctx.shadowColor = pColor; ctx.shadowBlur = 20; }
    drawPaddle(g.px, py, half, pColor);
    ctx.shadowBlur = 0;
    drawPaddle(g.ax, ay, half, '#ff4b4b');

    // Hit label
    if (g.hitLabelAlpha > 0) {
      ctx.textAlign = 'center';
      const ls2 = Math.round(H * 0.04);
      ctx.font = `bold ${ls2}px -apple-system,sans-serif`;
      const clr = g.hitLabel === 'PERFECT' ? '255,200,50' : '79,140,255';
      ctx.fillStyle = `rgba(${clr},${g.hitLabelAlpha.toFixed(2)})`;
      ctx.fillText(g.hitLabel, W / 2, py - 55);
    }

    // Sensor warning
    if (!hasAccel && g.phase !== 'idle') {
      ctx.textAlign = 'center';
      ctx.font = `${Math.round(H * 0.018)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,160,40,0.8)';
      ctx.fillText('⚠ Enable Accelerometer + Gyroscope in ZIGSIM for swing detection', W / 2, H - 20);
    }

    // Idle / scored overlay
    if (g.phase === 'idle') {
      ctx.textAlign = 'center';
      if (g.lastScorer) {
        const ip = g.lastScorer === 'player';
        ctx.font = `bold ${Math.round(H * 0.04)}px -apple-system,sans-serif`;
        ctx.fillStyle = ip ? 'rgba(79,140,255,0.9)' : 'rgba(255,75,75,0.9)';
        ctx.fillText(ip ? 'Point!' : 'Miss!', W / 2, H / 2 + H * 0.07);
      }
      ctx.font = `${Math.round(H * 0.022)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      const hint = zigLive
        ? 'Tilt to aim · Swing phone to hit · SPACE to serve'
        : 'Arrow keys to aim · SPACE to swing/serve';
      ctx.fillText(hint, W / 2, H / 2 + H * 0.13);
    }

    // ZIGSIM status dot
    const dx = W - 22, dy = 22;
    ctx.fillStyle = zigLive ? '#2bd576' : '#606472';
    ctx.beginPath(); ctx.arc(dx, dy, 5, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function drawPaddle(x, y, half, color) {
    const ph = PADDLE_H;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - half, y - ph / 2, half * 2, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.roundRect(x - half + 4, y - ph / 2 + 2, half * 2 - 8, ph / 2 - 2, ph / 4);
    ctx.fill();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  function frame() {
    if (!initialized) {
      g.px = W / 2; g.ax = W / 2; g.aiTarget = W / 2;
      initialized = true;
    }
    if (g.phase === 'idle') {
      g.idleFrames++;
      if (g.idleFrames > 90) launch(true);
    }
    if (g.phase === 'playing') tick();
    draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
