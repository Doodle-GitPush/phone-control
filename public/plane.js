/* Paper Plane — tilt to fly, twist for barrel roll, dodge the pillars. */
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

  // ── Canvas ────────────────────────────────────────────────────────────────
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

  // ── Constants (computed lazily so W/H are set) ────────────────────────────
  const PLANE_R     = 16;
  const GROUND_H    = 44;
  const PILLAR_W    = 64;
  const GAP_WORLD   = 360;
  const GAP_H_MAX   = 210;
  const GAP_H_MIN   = 110;
  const SPD_MIN     = 2.2;
  const SPD_MAX     = 5.0;
  const RING_R      = 14;
  const ROLL_THRESH = 3.6;   // rad/s
  const ROLL_DUR    = 650;   // ms for one barrel roll animation

  let PX = 0;  // plane screen X — set on first frame

  // ── ZIGSIM ────────────────────────────────────────────────────────────────
  let phoneY   = 0.5;
  let zigLive  = false;
  let hasGyro  = false;
  let rollActive  = false;
  let rollStart   = 0;
  let lastRollAt  = -9999;

  socket.on('brush:move', ({ id, y }) => { if (id === 'zigsim') phoneY = y; });
  socket.on('zig', ({ connected }) => { zigLive = connected; });
  socket.on('sensor:raw', ({ gyro }) => {
    if (gyro) { hasGyro = true; }
    if (!gyro || g.phase !== 'playing') return;
    if (Math.abs(gyro.z) > ROLL_THRESH && !rollActive && Date.now() - lastRollAt > 1500) {
      startRoll();
    }
  });

  // ── Game state ────────────────────────────────────────────────────────────
  const g = {
    phase: 'ready',  // ready | playing | dying | dead
    worldX: 0,
    planeY: 0, planeVY: 0, targetY: 0,
    pillars: [],  // { worldX, gapY, gapH }
    rings:   [],  // { worldX, y, taken }
    clouds:  [],  // { x, y, rx, ry, spd }
    lastPillarWX: 0,
    dist: 0, ringsHit: 0,
    best: 0,
    // death animation
    dx: 0, dy: 0, dvY: 0, dAngle: 0, dTimer: 0,
  };

  function speed()  { return SPD_MIN + (SPD_MAX - SPD_MIN) * Math.min(1, g.worldX / 10000); }
  function gapH()   { return GAP_H_MAX - (GAP_H_MAX - GAP_H_MIN) * Math.min(1, g.worldX / 10000); }
  function rollPct(){ return rollActive ? Math.min(1, (Date.now() - rollStart) / ROLL_DUR) : 0; }
  function total()  { return g.dist + g.ringsHit * 50; }

  function startRoll() {
    rollActive = true; rollStart = Date.now(); lastRollAt = Date.now();
  }

  function initClouds() {
    g.clouds = [];
    for (let i = 0; i < 8; i++) {
      const layer = i < 3 ? 0 : 1;
      g.clouds.push({
        x: Math.random() * W,
        y: 12 + Math.random() * (H * 0.5),
        rx: 28 + Math.random() * 55, ry: 13 + Math.random() * 22,
        spd: layer === 0 ? 0.18 : 0.44,
      });
    }
  }

  function spawnPillar(wx) {
    const margin = GROUND_H + 50;
    const gh = gapH();
    const gapY = margin + Math.random() * (H - 2 * margin - gh);
    g.pillars.push({ worldX: wx, gapY, gapH: gh });
    if (Math.random() < 0.65) {
      g.rings.push({
        worldX: wx + PILLAR_W / 2 + 30 + Math.random() * 100,
        y: gapY + gh / 2 + (Math.random() - 0.5) * gh * 0.45,
        taken: false,
      });
    }
  }

  function startGame() {
    g.phase = 'playing';
    g.worldX = 0; g.dist = 0; g.ringsHit = 0;
    g.planeY = H / 2; g.targetY = H / 2; g.planeVY = 0;
    g.pillars = []; g.rings = [];
    g.lastPillarWX = GAP_WORLD;
    rollActive = false; lastRollAt = -9999;
    initClouds();
    spawnPillar(g.lastPillarWX);
  }

  function crash() {
    const score = total();
    if (score > g.best) g.best = score;
    g.phase = 'dying';
    g.dx = PX; g.dy = g.planeY;
    g.dvY = g.planeVY + 2.5;
    g.dAngle = 0; g.dTimer = 55;
  }

  // Circle–rect collision
  function hits(cx, cy, r, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(cx, rx + rw));
    const ny = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') {
      e.preventDefault();
      if (g.phase === 'ready' || g.phase === 'dead') { startGame(); return; }
      if (g.phase === 'playing' && !rollActive) startRoll();
    }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // ── Tick ──────────────────────────────────────────────────────────────────
  function tick() {
    const spd = speed();

    // Scroll
    g.worldX += spd;
    g.dist = Math.floor(g.worldX);

    // Clouds
    for (const c of g.clouds) {
      c.x -= spd * c.spd;
      if (c.x < -(c.rx * 3)) {
        c.x = W + c.rx + Math.random() * 120;
        c.y = 12 + Math.random() * H * 0.5;
      }
    }

    // Spawn pillars when right edge of view reaches next slot
    const rightEdge = g.worldX + (W - PX);
    while (rightEdge > g.lastPillarWX + GAP_WORLD) {
      g.lastPillarWX += GAP_WORLD;
      spawnPillar(g.lastPillarWX);
    }

    // Cull distant objects
    g.pillars = g.pillars.filter(p => PX + (p.worldX - g.worldX) > -PILLAR_W - 10);
    g.rings   = g.rings.filter(r =>   PX + (r.worldX - g.worldX) > -RING_R - 10);

    // Plane Y: smooth follow to phone tilt or arrow keys
    const maxY = H - GROUND_H - PLANE_R - 4;
    let ty = phoneY * maxY;
    if (keys['ArrowUp'])   ty = Math.max(PLANE_R + 4, g.planeY - 5);
    if (keys['ArrowDown']) ty = Math.min(maxY, g.planeY + 5);
    g.targetY = ty;
    const prevY = g.planeY;
    g.planeY += (g.targetY - g.planeY) * 0.12;
    g.planeVY = g.planeY - prevY;

    // Roll finish
    if (rollActive && rollPct() >= 1) rollActive = false;

    // Collision (skip during barrel roll — the one superpower)
    if (!rollActive) {
      if (g.planeY < PLANE_R + 4 || g.planeY > H - GROUND_H - PLANE_R - 2) {
        crash(); return;
      }
      for (const p of g.pillars) {
        const sx = PX + (p.worldX - g.worldX);
        if (sx < -PILLAR_W - PLANE_R || sx > W + PILLAR_W) continue;
        const hw = PILLAR_W / 2;
        if (hits(PX, g.planeY, PLANE_R, sx - hw, 0, PILLAR_W, p.gapY) ||
            hits(PX, g.planeY, PLANE_R, sx - hw, p.gapY + p.gapH, PILLAR_W, H)) {
          crash(); return;
        }
      }
    }

    // Ring collection
    for (const r of g.rings) {
      if (r.taken) continue;
      const rx = PX + (r.worldX - g.worldX);
      const dx = rx - PX, dy = r.y - g.planeY;
      if (dx * dx + dy * dy < (PLANE_R + RING_R) * (PLANE_R + RING_R)) {
        r.taken = true; g.ringsHit++;
      }
    }
  }

  function tickDying() {
    g.dvY += 0.45;
    g.dy  += g.dvY;
    g.dAngle += 0.14;
    g.dTimer--;
    if (g.dTimer <= 0) g.phase = 'dead';
  }

  // ── Draw helpers ──────────────────────────────────────────────────────────
  function drawCloud(x, y, rx, ry) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x - rx * 0.42, y + ry * 0.18, rx * 0.65, ry * 0.78, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + rx * 0.38, y + ry * 0.12, rx * 0.55, ry * 0.72, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawPillar(sx, gapY, gh) {
    const hw = PILLAR_W / 2;
    const grd = () => {
      const g2 = ctx.createLinearGradient(sx - hw, 0, sx + hw, 0);
      g2.addColorStop(0, '#4a5568'); g2.addColorStop(0.5, '#718096'); g2.addColorStop(1, '#4a5568');
      return g2;
    };
    if (gapY > 0) {
      ctx.fillStyle = grd(); ctx.fillRect(sx - hw, 0, PILLAR_W, gapY);
      ctx.fillStyle = '#a0aec0'; ctx.fillRect(sx - hw - 5, gapY - 14, PILLAR_W + 10, 14);
    }
    const botY = gapY + gh;
    if (H - botY > 0) {
      ctx.fillStyle = grd(); ctx.fillRect(sx - hw, botY, PILLAR_W, H - botY);
      ctx.fillStyle = '#a0aec0'; ctx.fillRect(sx - hw - 5, botY, PILLAR_W + 10, 14);
    }
  }

  function drawPlane(x, y, pitchAngle, rollAngle = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(pitchAngle);
    const sy = Math.cos(rollAngle); // squish during roll
    ctx.scale(1, sy < 0.02 ? 0.02 : sy);

    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 8; ctx.shadowOffsetY = 5;

    ctx.beginPath();
    ctx.moveTo(28, 0); ctx.lineTo(-16, -18); ctx.lineTo(-6, 0); ctx.lineTo(-16, 18);
    ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = 'rgba(80,130,200,0.3)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-6, 0);
    ctx.strokeStyle = 'rgba(80,130,200,0.2)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-20, -10); ctx.lineTo(-14, 0);
    ctx.fillStyle = 'rgba(180,210,255,0.85)'; ctx.fill();

    ctx.restore();
  }

  // ── Main draw ─────────────────────────────────────────────────────────────
  function draw() {
    ctx.save();
    ctx.scale(dpr, dpr);

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#3a8fc8'); sky.addColorStop(0.65, '#87ceeb'); sky.addColorStop(1, '#b8e4f4');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // Clouds: far layer first
    for (const layer of [0, 1]) {
      ctx.fillStyle = layer === 0 ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.75)';
      for (const c of g.clouds) {
        if (c.spd < 0.3 && layer !== 0) continue;
        if (c.spd >= 0.3 && layer !== 1) continue;
        drawCloud(c.x, c.y, c.rx, c.ry);
      }
    }

    // Pillars
    for (const p of g.pillars) {
      const sx = PX + (p.worldX - g.worldX);
      if (sx < -PILLAR_W - 5 || sx > W + PILLAR_W) continue;
      drawPillar(sx, p.gapY, p.gapH);
    }

    // Rings
    for (const r of g.rings) {
      if (r.taken) continue;
      const rx = PX + (r.worldX - g.worldX);
      if (rx < -30 || rx > W + 30) continue;
      const pulse = 0.88 + 0.12 * Math.sin(Date.now() / 190);
      ctx.beginPath(); ctx.arc(rx, r.y, RING_R * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,215,0,0.9)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = 'rgba(255,215,0,0.18)'; ctx.fill();
    }

    // Ground
    ctx.fillStyle = '#2d6a2d'; ctx.fillRect(0, H - GROUND_H, W, GROUND_H);
    ctx.fillStyle = '#3c8c3c'; ctx.fillRect(0, H - GROUND_H, W, 5);

    // Plane
    if (g.phase === 'playing' || g.phase === 'ready') {
      const pitch = Math.atan2(g.planeVY, 5) * 0.75;
      const rp = rollPct();
      if (rollActive) { ctx.shadowColor = 'rgba(80,200,255,0.55)'; ctx.shadowBlur = 22; }
      drawPlane(PX, g.planeY, pitch, rp * Math.PI * 2);
      ctx.shadowBlur = 0;
    }
    if (g.phase === 'dying') drawPlane(g.dx, g.dy, g.dAngle);

    // HUD — score
    if (g.phase === 'playing') {
      ctx.textAlign = 'right';
      ctx.font = `bold ${Math.round(H * 0.038)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(0,40,100,0.65)';
      ctx.fillText(`${g.dist} m`, W - 22, 44);
      if (g.ringsHit > 0) {
        ctx.font = `600 ${Math.round(H * 0.02)}px -apple-system,sans-serif`;
        ctx.fillText(`🪙 ×${g.ringsHit}`, W - 22, 68);
      }

      // Roll status
      if (rollActive) {
        const rp = rollPct();
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(H * 0.026)}px -apple-system,sans-serif`;
        ctx.fillStyle = `rgba(80,200,255,${(1 - rp * rp).toFixed(2)})`;
        ctx.fillText('BARREL ROLL!', W / 2, 44);
      } else {
        ctx.textAlign = 'center';
        ctx.font = `${Math.round(H * 0.015)}px -apple-system,sans-serif`;
        ctx.fillStyle = 'rgba(0,40,100,0.32)';
        ctx.fillText(hasGyro ? 'Twist wrist → barrel roll' : 'SPACE → barrel roll', W / 2, H - GROUND_H - 12);
      }
    }

    // Ready screen
    if (g.phase === 'ready') {
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(H * 0.04)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(0,40,100,0.75)';
      ctx.fillText('✈️  Paper Plane', W / 2, H * 0.42);
      ctx.font = `${Math.round(H * 0.022)}px -apple-system,sans-serif`;
      ctx.fillStyle = 'rgba(0,40,100,0.5)';
      ctx.fillText('Tilt phone up/down to fly · SPACE to start', W / 2, H * 0.42 + 38);
    }

    // Crash overlay
    if (g.phase === 'dying' || g.phase === 'dead') {
      const alpha = g.phase === 'dying' ? Math.max(0, 1 - g.dTimer / 30) * 0.45 : 0.45;
      ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
      if (g.phase === 'dead') {
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(H * 0.05)}px -apple-system,sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText('CRASHED!', W / 2, H / 2 - 30);
        ctx.font = `${Math.round(H * 0.03)}px -apple-system,sans-serif`;
        ctx.fillText(`${total().toLocaleString()} pts  ·  ${g.dist} m`, W / 2, H / 2 + 12);
        if (g.best > 0) {
          ctx.font = `${Math.round(H * 0.02)}px -apple-system,sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillText(`Best  ${g.best.toLocaleString()} pts`, W / 2, H / 2 + 46);
        }
        ctx.font = `${Math.round(H * 0.02)}px -apple-system,sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.38)';
        ctx.fillText('SPACE to fly again', W / 2, H / 2 + 80);
      }
    }

    // ZIGSIM status dot
    ctx.fillStyle = zigLive ? '#2bd576' : '#606472';
    ctx.beginPath(); ctx.arc(W - 22, 20, 5, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  function frame() {
    if (!PX) {
      PX = Math.round(W * 0.22);
      initClouds();  // show clouds on ready screen
    }
    if (g.phase === 'playing') tick();
    if (g.phase === 'dying')   tickDying();
    draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
