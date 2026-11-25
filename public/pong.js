/* Phone Pong — phone tilt (ZIGSIM) controls the player paddle. */
(() => {
  const cv = document.getElementById('game');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // -------------------------------------------------------------------------
  // Socket.IO — join as display so we receive ZIGSIM brush:move events.
  // -------------------------------------------------------------------------
  const socket = io();
  socket.on('connect', () => socket.emit('hello', 'display'));

  let phoneX = 0.5;   // ZIGSIM normalized x (0 = left, 1 = right)
  let zigLive = false;
  let zigSource = '';

  socket.on('brush:move', ({ id, x }) => { if (id === 'zigsim') phoneX = x; });
  socket.on('zig', ({ connected, source }) => {
    zigLive = connected;
    zigSource = source || 'sensor';
  });

  // Setup card
  fetch('/api/info').then(r => r.json()).then(({ ip, zigPort }) => {
    const el = document.getElementById('ip');
    const ep = document.getElementById('port');
    if (el) el.textContent = ip;
    if (ep) ep.textContent = zigPort;
  }).catch(() => {});
  document.getElementById('closeCard').addEventListener('click', () =>
    document.getElementById('card').classList.add('hidden'));
  document.getElementById('setupBtn').addEventListener('click', () =>
    document.getElementById('card').classList.toggle('hidden'));

  // -------------------------------------------------------------------------
  // Canvas sizing
  // -------------------------------------------------------------------------
  let W = 0, H = 0;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width  = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width  = W + 'px';
    cv.style.height = H + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // -------------------------------------------------------------------------
  // Game constants
  // -------------------------------------------------------------------------
  const BALL_R      = 10;   // px
  const PADDLE_H    = 14;   // px (height of paddle rect)
  const PADDLE_FRAC = 0.18; // paddle width as fraction of screen width
  const PADDLE_MAX  = 120;  // px cap
  const P_EDGE      = 72;   // px from top/bottom edge to paddle center
  const SPEED_INIT  = 5.5;
  const SPEED_MAX   = 19;
  const SPEED_BUMP  = 1.04; // multiply speed each hit
  const AI_SPEED    = 4.8;  // px per frame max

  function pW()     { return Math.min(W * PADDLE_FRAC, PADDLE_MAX); } // full paddle width
  function playerY(){ return H - P_EDGE; }
  function aiY()    { return P_EDGE; }

  // -------------------------------------------------------------------------
  // Game state
  // -------------------------------------------------------------------------
  const g = {
    bx: 0, by: 0, bvx: 0, bvy: 0,  // ball position + velocity
    trail: [],                        // last N ball positions for trail
    px: 0,                            // player paddle center x
    ax: 0,                            // AI paddle center x
    aiTarget: 0,                      // AI's intended destination
    aiFrame: 0,                       // frame counter for AI re-prediction
    ps: 0, as: 0,                     // scores
    phase: 'idle',                    // idle | playing | scored
    idleFrames: 0,
    flashAlpha: 0,
    flashClr: '79,140,255',
    lastScorer: '',                   // 'player' | 'ai'
    hitFlash: 0,                      // brief paddle glow after hit
  };

  let initialized = false;

  function launch() {
    g.bx = W / 2; g.by = H / 2;
    g.trail = [];
    const angle = (Math.random() - 0.5) * 0.7;
    const toPlayer = Math.random() > 0.5;
    const spd = SPEED_INIT;
    g.bvx = Math.sin(angle) * spd;
    g.bvy = (toPlayer ? 1 : -1) * Math.cos(angle) * spd;
    g.phase = 'playing';
    g.idleFrames = 0;
    g.aiFrame = 0;
    g.aiTarget = W / 2;
  }

  function scored(byPlayer) {
    if (byPlayer) g.ps++; else g.as++;
    g.phase = 'scored';
    g.lastScorer = byPlayer ? 'player' : 'ai';
    g.flashAlpha = 0.38;
    g.flashClr = byPlayer ? '79,140,255' : '255,75,75';
    setTimeout(() => { if (g.phase === 'scored') { g.phase = 'idle'; g.idleFrames = 0; } }, 1400);
  }

  // -------------------------------------------------------------------------
  // Keyboard input
  // -------------------------------------------------------------------------
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') {
      e.preventDefault();
      if (g.phase === 'idle') launch();
    }
    if (e.key === 'r' || e.key === 'R') socket.emit('zig:recenter');
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // -------------------------------------------------------------------------
  // Physics tick
  // -------------------------------------------------------------------------
  function tick() {
    const half = pW() / 2;

    // --- Player paddle ---
    if (keys['ArrowLeft'])       g.px = Math.max(half, g.px - 9);
    else if (keys['ArrowRight']) g.px = Math.min(W - half, g.px + 9);
    else {
      // Smooth follow to ZIGSIM x
      const target = phoneX * W;
      g.px += (target - g.px) * 0.18;
    }
    g.px = Math.max(half, Math.min(W - half, g.px));

    // --- AI paddle (predict ball landing, recalculate every 9 frames) ---
    g.aiFrame++;
    if (g.aiFrame % 9 === 0) {
      if (g.bvy < 0) { // ball moving toward AI
        const frames = (aiY() - g.by) / (g.bvy || -0.1);
        let pred = g.bx + g.bvx * Math.max(0, frames);
        pred += (Math.random() - 0.5) * 55; // imperfect AI
        g.aiTarget = Math.max(half, Math.min(W - half, pred));
      } else {
        g.aiTarget = W / 2; // ball going away — drift to center
      }
    }
    const aiDiff = g.aiTarget - g.ax;
    g.ax += Math.sign(aiDiff) * Math.min(AI_SPEED, Math.abs(aiDiff));
    g.ax = Math.max(half, Math.min(W - half, g.ax));

    // --- Ball movement ---
    g.trail.push({ x: g.bx, y: g.by });
    if (g.trail.length > 10) g.trail.shift();
    g.bx += g.bvx;
    g.by += g.bvy;

    // Wall bounces
    if (g.bx - BALL_R < 0)     { g.bx = BALL_R;     g.bvx =  Math.abs(g.bvx); }
    if (g.bx + BALL_R > W)     { g.bx = W - BALL_R; g.bvx = -Math.abs(g.bvx); }

    // --- Player paddle collision (bottom) ---
    const py = playerY();
    if (g.bvy > 0 &&
        g.by + BALL_R >= py - PADDLE_H / 2 &&
        g.by - BALL_R <= py + PADDLE_H / 2 &&
        Math.abs(g.bx - g.px) <= half + BALL_R) {
      const rel = (g.bx - g.px) / half; // -1..1
      let spd = Math.min(Math.hypot(g.bvx, g.bvy) * SPEED_BUMP, SPEED_MAX);
      const ang = rel * 0.68;
      g.bvx = Math.sin(ang) * spd;
      g.bvy = -Math.cos(ang) * spd;
      g.by  = py - PADDLE_H / 2 - BALL_R;
      g.hitFlash = 8;
    }

    // --- AI paddle collision (top) ---
    const ay = aiY();
    if (g.bvy < 0 &&
        g.by - BALL_R <= ay + PADDLE_H / 2 &&
        g.by + BALL_R >= ay - PADDLE_H / 2 &&
        Math.abs(g.bx - g.ax) <= half + BALL_R) {
      const rel = (g.bx - g.ax) / half;
      let spd = Math.min(Math.hypot(g.bvx, g.bvy) * SPEED_BUMP, SPEED_MAX);
      const ang = rel * 0.68;
      g.bvx = Math.sin(ang) * spd;
      g.bvy =  Math.cos(ang) * spd;
      g.by  = ay + PADDLE_H / 2 + BALL_R;
    }

    // --- Scoring ---
    if (g.by > H + BALL_R * 2) scored(false); // AI scores
    if (g.by < -BALL_R * 2)    scored(true);  // player scores
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function draw() {
    ctx.save();
    ctx.scale(dpr, dpr);

    // Table surface
    ctx.fillStyle = '#196b39';
    ctx.fillRect(0, 0, W, H);

    // Score flash overlay
    if (g.flashAlpha > 0) {
      ctx.fillStyle = `rgba(${g.flashClr},${g.flashAlpha.toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
      g.flashAlpha -= 0.009;
    }

    // Table border
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, W - 8, H - 8);

    // Center dashed line
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.moveTo(8, H / 2);
    ctx.lineTo(W - 8, H / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Center dot
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2);
    ctx.fill();

    // Score numbers (large, faint, each in their half)
    const scoreSize = Math.round(Math.min(W, H) * 0.11);
    ctx.textAlign = 'center';
    ctx.font = `bold ${scoreSize}px -apple-system, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fillText(g.as, W / 2, H * 0.32);
    ctx.fillText(g.ps, W / 2, H * 0.74);

    // Labels
    const labelSize = Math.round(Math.min(W, H) * 0.025);
    ctx.font = `600 ${labelSize}px -apple-system, sans-serif`;
    ctx.fillStyle = 'rgba(255,75,75,0.5)';
    ctx.fillText('AI', W / 2, H * 0.22);
    ctx.fillStyle = 'rgba(79,140,255,0.5)';
    ctx.fillText('YOU', W / 2, H * 0.84);

    // Ball trail
    for (let i = 0; i < g.trail.length; i++) {
      const t = g.trail[i];
      const frac = (i + 1) / g.trail.length;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_R * frac * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(frac * 0.22).toFixed(2)})`;
      ctx.fill();
    }

    // Ball
    if (g.phase !== 'idle') {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(g.bx + 3, g.by + 5, BALL_R * 0.9, BALL_R * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // Body
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(g.bx, g.by, BALL_R, 0, Math.PI * 2);
      ctx.fill();
      // Specular highlight
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(g.bx - BALL_R * 0.3, g.by - BALL_R * 0.3, BALL_R * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Idle: pulsing ball at center
      const pulse = 0.45 + 0.25 * Math.sin(Date.now() / 300);
      ctx.fillStyle = `rgba(255,255,255,${pulse.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, BALL_R, 0, Math.PI * 2);
      ctx.fill();
    }

    // Paddles
    const half = pW() / 2;
    if (g.hitFlash > 0) {
      drawPaddle(g.px, playerY(), half, '#7eb0ff', true);
      g.hitFlash--;
    } else {
      drawPaddle(g.px, playerY(), half, '#4f8cff', false);
    }
    drawPaddle(g.ax, aiY(), half, '#ff4b4b', false);

    // ZIGSIM status dot (top right)
    const dotX = W - 22, dotY = 22;
    ctx.fillStyle = zigLive ? '#2bd576' : '#606472';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
    ctx.fill();
    if (zigLive) {
      ctx.fillStyle = 'rgba(43,213,118,0.2)';
      ctx.beginPath();
      ctx.arc(dotX, dotY, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    // Idle / scored overlay text
    if (g.phase === 'idle') {
      ctx.textAlign = 'center';

      if (g.lastScorer) {
        const isPlayer = g.lastScorer === 'player';
        ctx.font = `bold ${Math.round(H * 0.04)}px -apple-system, sans-serif`;
        ctx.fillStyle = isPlayer ? 'rgba(79,140,255,0.95)' : 'rgba(255,75,75,0.95)';
        ctx.fillText(isPlayer ? 'Point!' : 'Miss!', W / 2, H / 2 + H * 0.07);
      }

      ctx.font = `${Math.round(H * 0.022)}px -apple-system, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      const hint = zigLive
        ? 'Tilt phone left/right · SPACE to serve'
        : 'Arrow keys to move · SPACE to serve';
      ctx.fillText(hint, W / 2, H / 2 + H * 0.13);
    }

    ctx.restore();
  }

  function drawPaddle(x, y, half, color, glow) {
    const ph = PADDLE_H;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - half, y - ph / 2, half * 2, ph, ph / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Sheen
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.roundRect(x - half + 4, y - ph / 2 + 2, half * 2 - 8, ph / 2 - 2, ph / 4);
    ctx.fill();
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  function frame() {
    if (!initialized) {
      g.px = W / 2;
      g.ax = W / 2;
      g.aiTarget = W / 2;
      initialized = true;
    }

    if (g.phase === 'idle') {
      g.idleFrames++;
      if (g.idleFrames > 90) launch(); // auto-serve after ~1.5 s
    }

    if (g.phase === 'playing') tick();

    draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
