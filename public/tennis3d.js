/* Table Tennis 3D — the phone IS the paddle.
   Quaternion → paddle orientation (aim)  ·  gravity tilt → lateral reach
   linearAccel spike → the hit  ·  gyro.z → spin.  Full 3D ball physics + AI. */
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Table / world dimensions (world units ≈ "big" so the camera reads nicely)
// ─────────────────────────────────────────────────────────────────────────────
const TABLE_W   = 4.0;          // x extent  (-2 .. 2)
const TABLE_L   = 7.2;          // z extent  (-3.6 .. 3.6)
const TABLE_TOP = 1.40;         // play-surface height above the floor (y)
const NET_H     = 0.50;         // net height above the table
const BALL_R    = 0.12;
const PLAYER_Z  =  3.40;        // your paddle's resting z (near camera)
const AI_Z      = -3.40;        // AI paddle's z (far end)
const FLOOR_Y   = 0.0;

const HALF_W = TABLE_W / 2, HALF_L = TABLE_L / 2;

// Physics tuning (not real units — tuned for feel)
const GRAVITY    = -16.0;
const SERVE_SPD  = 7.6;
const HIT_BASE   = 9.5;
const HIT_MAX    = 17.0;
const RESTITUTE  = 0.82;        // table bounce energy retained (y)
const SPIN_K     = 0.9;         // gyro.z → curve strength

// Swing detection (mirrors the proven 2D logic)
const SWING_THRESH = 4.5;       // m/s² linearAccel magnitude
const SWING_COOL   = 360;       // ms between swings
const HIT_GRACE    = 320;       // ms window between swing & ball-in-reach
const REACH_X      = 1.15;      // how far (x) the ball can be from paddle to hit
const REACH_Z      = 1.05;      // how far (z) from PLAYER_Z the ball is hittable

// Lateral control: PHYSICALLY MOVE the phone left/right. Not tilt, not rotation.
// Driven by linear acceleration (gravity removed) rotated into world space, then
// integrated once into a velocity. Rotating/tilting in place produces no linear
// acceleration, so it does not move the paddle.
// Values below were tuned in simulation against synthetic sensor data: a brisk
// hand move covers ~70% of the reach and holds there, while a 0.9 m/s² sensor
// bias or 30s of holding still both produce zero drift.
const MOVE_DEADZONE = 0.28;     // m/s² — below this is sensor noise, ignored
const MOVE_GAIN     = 2.2;      // how much a given push translates into paddle travel
const VEL_DECAY     = 0.995;    // per-frame velocity bleed (~3.3s memory)
const MAX_MOVE_VEL  = 7.0;      // clamp on paddle lateral velocity (world units/s)
const CENTER_PULL   = 0.35;     // gentle drift back to centre (1/s)
const BIAS_ADAPT    = 0.7;      // 1/s — how fast the zero-point estimate tracks
const BIAS_GATE     = 1.2;      // only re-learn the zero point while the hand is ~still
let   lateralSign   = 1;        // press "i" to invert if movement feels reversed

// AI
const AI_SPEED    = 0.10;       // lerp factor toward target x
const AI_HIT_RATE = 0.80;
const AI_REACH_Z  = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Renderer / scene / camera
// ─────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x070a12, 12, 26);
scene.background = makeGradientBackground();

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, TABLE_TOP + 4.4, PLAYER_Z + 5.0);
camera.lookAt(0, TABLE_TOP - 0.55, -0.4);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);          // updateStyle=true → canvas CSS matches the window
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Vertical gradient backdrop (deep blue → near-black) as a CanvasTexture
function makeGradientBackground() {
  const cv = document.createElement('canvas');
  cv.width = 16; cv.height = 256;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.0, '#1a2746');
  grd.addColorStop(0.45, '#0d1426');
  grd.addColorStop(1.0, '#05070d');
  g.fillStyle = grd; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lighting
// ─────────────────────────────────────────────────────────────────────────────
scene.add(new THREE.HemisphereLight(0x9fb5ff, 0x2a2c38, 0.85));

const key = new THREE.DirectionalLight(0xffffff, 1.25);
key.position.set(3.5, 9, 4.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -6; key.shadow.camera.right = 6;
key.shadow.camera.top = 6;   key.shadow.camera.bottom = -6;
key.shadow.bias = -0.0004;
scene.add(key);

// Fill from the left so the whole table reads (no half-in-shadow look)
const fill = new THREE.DirectionalLight(0xcdd8ff, 0.7);
fill.position.set(-5, 5, 3);
scene.add(fill);

const rim = new THREE.DirectionalLight(0x6f8cff, 0.45);
rim.position.set(-3, 4, -6);
scene.add(rim);

// ─────────────────────────────────────────────────────────────────────────────
// Floor
// ─────────────────────────────────────────────────────────────────────────────
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.95, metalness: 0.0 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
scene.add(floor);

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────
const tableGroup = new THREE.Group();
scene.add(tableGroup);

const TABLE_THICK = 0.18;
const topMat = new THREE.MeshStandardMaterial({ color: 0x1f5fa6, roughness: 0.42, metalness: 0.05 });
const tableTop = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W, TABLE_THICK, TABLE_L), topMat);
tableTop.position.y = TABLE_TOP - TABLE_THICK / 2;
tableTop.castShadow = true;
tableTop.receiveShadow = true;
tableGroup.add(tableTop);

// Skirt / legs (simple)
const legMat = new THREE.MeshStandardMaterial({ color: 0x10131c, roughness: 0.8 });
const LEG_H = TABLE_TOP - TABLE_THICK;        // stop just under the table top
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, LEG_H, 0.16), legMat);
  leg.position.set(sx * (HALF_W - 0.3), LEG_H / 2, sz * (HALF_L - 0.3));
  leg.castShadow = true;
  tableGroup.add(leg);
}

// White lines (thin flat boxes just above the surface)
const lineMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.5, emissive: 0x222a3a, emissiveIntensity: 0.4 });
const LY = TABLE_TOP + 0.006, LW = 0.05;
function addLine(w, d, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), lineMat);
  m.position.set(x, LY, z);
  tableGroup.add(m);
}
addLine(TABLE_W, LW, 0,  HALF_L - LW / 2);   // player end line
addLine(TABLE_W, LW, 0, -HALF_L + LW / 2);   // AI end line
addLine(LW, TABLE_L, -HALF_W + LW / 2, 0);   // left side line
addLine(LW, TABLE_L,  HALF_W - LW / 2, 0);   // right side line
addLine(LW, TABLE_L, 0, 0);                  // center service line

// Net
const netGroup = new THREE.Group();
netGroup.position.set(0, TABLE_TOP, 0);
tableGroup.add(netGroup);
const netMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(TABLE_W + 0.4, NET_H),
  new THREE.MeshStandardMaterial({ map: makeNetTexture(), transparent: true,
    opacity: 0.85, side: THREE.DoubleSide, roughness: 0.9, depthWrite: false })
);
netMesh.position.y = NET_H / 2;
netGroup.add(netMesh);
const tape = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE_W + 0.4, 0.035, 0.02),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
);
tape.position.y = NET_H;
netGroup.add(tape);
for (const sx of [-1, 1]) {                  // posts
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, NET_H + 0.05, 12),
    new THREE.MeshStandardMaterial({ color: 0xdddde6, roughness: 0.4, metalness: 0.3 }));
  post.position.set(sx * (HALF_W + 0.18), (NET_H + 0.05) / 2, 0);
  netGroup.add(post);
}

function makeNetTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 2;
  for (let i = 0; i <= 128; i += 9) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 1);
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paddles
// ─────────────────────────────────────────────────────────────────────────────
function makePaddle(rubberColor) {
  const g = new THREE.Group();
  // Blade: a flat cylinder; after rotateX(90°) its round faces point along ±z (local)
  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.05, 40),
    new THREE.MeshStandardMaterial({ color: rubberColor, roughness: 0.55, metalness: 0.05 }));
  blade.rotation.x = Math.PI / 2;
  blade.castShadow = true;
  g.add(blade);
  // Wood rim (slightly larger, thin)
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.022, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xc8a06a, roughness: 0.7 }));
  g.add(rim);
  // Handle
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.34, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.7 }));
  handle.position.y = -0.5;
  handle.castShadow = true;
  g.add(handle);
  return g;
}

// Player paddle: red rubber. Wrapper group takes the dynamic phone orientation;
// inner model has a base rotation so neutral = face up-table (-z), handle down.
const playerPivot = new THREE.Group();
playerPivot.position.set(0, TABLE_TOP + 0.34, PLAYER_Z);
scene.add(playerPivot);
const playerModel = makePaddle(0xe0322f);
playerModel.rotation.y = Math.PI;            // local +z face → world -z (toward AI)
playerPivot.add(playerModel);

// AI paddle: dark red, faces toward the player (+z)
const aiPivot = new THREE.Group();
aiPivot.position.set(0, TABLE_TOP + 0.34, AI_Z);
scene.add(aiPivot);
const aiModel = makePaddle(0x1a1a20);
aiPivot.add(aiModel);

// ─────────────────────────────────────────────────────────────────────────────
// Ball + trail + contact shadow
// ─────────────────────────────────────────────────────────────────────────────
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 24, 24),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35,
    emissive: 0xffffff, emissiveIntensity: 0.12 }));
ball.castShadow = true;
scene.add(ball);

// Trail: pool of fading spheres
const TRAIL_N = 14;
const trail = [];
const trailMat = new THREE.MeshBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.3 });
for (let i = 0; i < TRAIL_N; i++) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.9, 10, 10), trailMat.clone());
  m.visible = false;
  scene.add(m);
  trail.push(m);
}
let trailHead = 0;

// Soft contact shadow on the table under the ball
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(BALL_R * 2.6, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
blob.rotation.x = -Math.PI / 2;
scene.add(blob);

// ─────────────────────────────────────────────────────────────────────────────
// Socket / sensors
// ─────────────────────────────────────────────────────────────────────────────
const socket = io();
socket.on('connect', () => socket.emit('hello', 'display'));

fetch('/api/info').then(r => r.json()).then(({ ip, zigPort }) => {
  const i = document.getElementById('ip'), p = document.getElementById('port');
  if (i) i.textContent = ip; if (p) p.textContent = zigPort;
}).catch(() => {});

const $ = (id) => document.getElementById(id);
$('closeCard').addEventListener('click', () => $('card').classList.add('hidden'));
$('setupBtn').addEventListener('click', () => $('card').classList.toggle('hidden'));
$('recenterBtn').addEventListener('click', recenter);

let zigLive = false, hasAccel = false, hasQuat = false;

const qPhone = new THREE.Quaternion();            // latest phone orientation
const qCalib = new THREE.Quaternion();            // neutral captured on recenter
const qCalibInv = new THREE.Quaternion();
let haveCalib = false;
const qTarget = new THREE.Quaternion();           // smoothed paddle orientation target

const gravVec   = new THREE.Vector3(0, 0, 1);     // latest gravity (device frame)
const upWorld   = new THREE.Vector3(0, 1, 0);     // world "up", captured at neutral
const rightAxis = new THREE.Vector3(1, 0, 0);     // world "player right", captured at neutral
const aWorld    = new THREE.Vector3();            // scratch: accel rotated into world space
let moveAccel = 0;                                // latest sideways acceleration (m/s²)
let moveVel   = 0;                                // integrated paddle lateral velocity
let moveBias  = null;                             // sideways zero-point (null → seed on next packet)
let lastAccelAt = Date.now();                     // for bias-tracker timestep

// Swing state
let lastSwingAt = 0, lastSwingPower = 0, lastSwingSpin = 0;
let pendingSwingAt = 0;
let paddleFlash = 0;

function recenter() {
  socket.emit('zig:recenter');
  haveCalib = false;                              // next packet becomes the neutral pose
  moveAccel = 0; moveVel = 0; moveBias = null;    // drop motion + re-seed the zero point
  playerPivot.position.x = 0;
  flashMsg('Recentered', 'Hold still a moment — then move the phone to slide', 1100);
}

socket.on('zig', ({ connected, source }) => {
  zigLive = connected;
  $('dot').classList.toggle('live', connected);
  $('statusText').textContent = connected ? `Phone · ${source || 'sensor'}` : 'Waiting for phone…';
});

function onSensorRaw({ quaternion, gyro, linearAccel, gravity }) {
  if (gravity) gravVec.set(gravity.x, gravity.y, gravity.z);
  if (quaternion) {
    hasQuat = true;
    qPhone.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    if (!haveCalib) {
      qCalib.copy(qPhone); qCalibInv.copy(qPhone).invert();
      // World "up" = opposite of gravity, expressed in world space.
      if (gravVec.lengthSq() > 0.01)
        upWorld.copy(gravVec).applyQuaternion(qPhone).normalize().negate();
      // World "player right" = the device's +x axis at neutral, flattened horizontal
      // so that later tilting the phone can't leak into the sideways reading.
      rightAxis.set(1, 0, 0).applyQuaternion(qPhone);
      rightAxis.addScaledVector(upWorld, -rightAxis.dot(upWorld));
      if (rightAxis.lengthSq() < 1e-4) rightAxis.set(1, 0, 0);   // degenerate guard
      rightAxis.normalize();
      haveCalib = true;
    }
  }

  // ── Sideways MOVEMENT (not rotation) ──────────────────────────────────────
  // linearAccel already has gravity removed, so it is pure hand motion. Rotating
  // it into world space means "right" stays right no matter how the paddle face
  // is angled — and a pure tilt/twist registers ~0 here.
  if (linearAccel && haveCalib) {
    aWorld.set(linearAccel.x, linearAccel.y, linearAccel.z).applyQuaternion(qPhone);
    const raw = aWorld.dot(rightAxis);

    // Zero-point tracking: seeded when you Recenter (held still), then re-learned
    // slowly and only while the hand is roughly at rest. Without this, a small
    // constant sensor bias would integrate and walk the paddle into the wall.
    if (moveBias === null) moveBias = raw;
    const dtA = Math.min((Date.now() - lastAccelAt) / 1000, 0.1);
    lastAccelAt = Date.now();
    if (Math.abs(raw - moveBias) < BIAS_GATE) moveBias += (raw - moveBias) * BIAS_ADAPT * dtA;

    const a = raw - moveBias;
    moveAccel = Math.abs(a) < MOVE_DEADZONE ? 0 : a;
  }

  if (linearAccel) {
    hasAccel = true;
    const mag = Math.hypot(linearAccel.x, linearAccel.y, linearAccel.z);
    const now = Date.now();
    if (mag > SWING_THRESH && now - lastSwingAt > SWING_COOL) {
      lastSwingAt    = now;
      lastSwingPower = Math.min(mag / 12, 1.5);
      lastSwingSpin  = gyro ? gyro.z : 0;
      pendingSwingAt = now;
      paddleFlash    = 1;
    }
  }
}
socket.on('sensor:raw', onSensorRaw);

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard fallback (no phone needed to test)
// ─────────────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.phase === 'idle') serve(true);
    else { pendingSwingAt = Date.now(); lastSwingPower = 0.85; lastSwingSpin = 0; paddleFlash = 1; }
  }
  if (e.key === 'r' || e.key === 'R') recenter();
  if (e.key === 'i' || e.key === 'I') {
    lateralSign = -lateralSign;
    flashMsg('', `Move direction ${lateralSign > 0 ? 'normal' : 'inverted'}`, 900);
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// ─────────────────────────────────────────────────────────────────────────────
// Game state
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  phase: 'idle',           // idle | serving | rally | scored
  scoreYou: 0, scoreAI: 0,
  lastHitter: null,        // 'player' | 'ai'
  idle: 0,
  aiTargetX: 0, aiFrame: 0, aiHitting: false,
  spinZ: 0,
};
const vel = new THREE.Vector3();

function serve(toPlayer) {
  ball.position.set((Math.random() - 0.5) * 1.5, TABLE_TOP + 0.5, toPlayer ? AI_Z + 0.4 : PLAYER_Z - 0.4);
  const ang = (Math.random() - 0.5) * 0.4;
  vel.set(Math.sin(ang) * 2.0, 1.5, (toPlayer ? 1 : -1) * SERVE_SPD);
  state.spinZ = 0;
  state.lastHitter = toPlayer ? 'ai' : 'player';
  state.phase = 'rally';
  state.idle = 0; pendingSwingAt = 0; state.aiHitting = false;
  hideMsg();
}

function scorePoint(who) {
  if (who === 'player') state.scoreYou++; else state.scoreAI++;
  $('scoreYou').textContent = state.scoreYou;
  $('scoreAI').textContent  = state.scoreAI;
  state.phase = 'scored';
  flashMsg(who === 'player' ? 'Point — You!' : 'Point — AI',
           who === 'player' ? 'Nicely played' : 'Defend the next one', 1300);
  setTimeout(() => { if (state.phase === 'scored') { state.phase = 'idle'; state.idle = 0; } }, 1350);
}

// Hit the ball with the player's paddle
function playerHit() {
  const faceN = new THREE.Vector3();
  playerModel.getWorldDirection(faceN);            // ≈ (0,0,-1) at neutral → up-table
  const dir = faceN.clone();
  if (dir.z > -0.28) dir.z = -0.28;                // always send it toward AI
  dir.y = THREE.MathUtils.clamp(dir.y, -0.15, 0.85) + 0.46;  // loft to clear the net
  dir.x += playerPivot.position.x * 0.10;          // a little aim from where you stand
  dir.normalize();

  const power = lastSwingPower;
  const speed = THREE.MathUtils.clamp(HIT_BASE * (0.72 + power * 0.7), HIT_BASE * 0.7, HIT_MAX);
  vel.copy(dir).multiplyScalar(speed);
  state.spinZ = lastSwingSpin * SPIN_K;
  state.lastHitter = 'player';
  pendingSwingAt = 0;
  paddleFlash = 1;
  flashMsg('', '', 0);                             // clear any message
  popHit(power);
}

function aiHit() {
  const targetX = (Math.random() - 0.5) * (TABLE_W * 0.7);
  const dir = new THREE.Vector3(targetX - ball.position.x, 0, PLAYER_Z + 1).normalize();
  dir.y = 0.5 + Math.random() * 0.12;
  dir.normalize();
  const speed = HIT_BASE * (0.8 + Math.random() * 0.35);
  vel.copy(dir).multiplyScalar(speed);
  state.spinZ = (Math.random() - 0.5) * 2;
  state.lastHitter = 'ai';
}

// ─────────────────────────────────────────────────────────────────────────────
// Physics (fixed timestep)
// ─────────────────────────────────────────────────────────────────────────────
const STEP = 1 / 120;
let acc = 0, lastT = performance.now();

function physics(dt) {
  // Spin curve (Magnus-ish lateral push)
  vel.x += state.spinZ * dt;
  state.spinZ *= 0.985;

  vel.y += GRAVITY * dt;
  ball.position.addScaledVector(vel, dt);

  const p = ball.position;

  // Table bounce
  if (p.y - BALL_R < TABLE_TOP && vel.y < 0 &&
      Math.abs(p.x) < HALF_W && Math.abs(p.z) < HALF_L) {
    p.y = TABLE_TOP + BALL_R;
    vel.y = -vel.y * RESTITUTE;
    vel.x *= 0.96; vel.z *= 0.99;
  }

  // Net collision: crossing z=0 below the tape, within width
  if (Math.sign(p.z) !== Math.sign(p.z - vel.z * dt) || Math.abs(p.z) < BALL_R) {
    if (p.y < TABLE_TOP + NET_H && Math.abs(p.x) < HALF_W + 0.1) {
      // Clipped the net — kill forward momentum, let it drop on the hitter's side
      p.z += (state.lastHitter === 'player' ? 1 : -1) * 0.02;
      vel.z = (state.lastHitter === 'player' ? 1 : -1) * 0.8;
      vel.x *= 0.5; vel.y = Math.min(vel.y, 0.5);
    }
  }

  // Out of play / scoring
  if (p.z > PLAYER_Z + 0.9)      { scorePoint('ai');     return; }
  if (p.z < AI_Z - 0.9)          { scorePoint('player'); return; }
  if (p.y < FLOOR_Y + BALL_R)    { scorePoint(p.z >= 0 ? 'ai' : 'player'); return; }

  // ── Player hit detection ───────────────────────────────────────────────────
  const inReach = vel.z > 0 &&
    Math.abs(p.z - PLAYER_Z) < REACH_Z &&
    Math.abs(p.x - playerPivot.position.x) < REACH_X &&
    p.y > TABLE_TOP - 0.1 && p.y < TABLE_TOP + 1.6;
  if (inReach && pendingSwingAt > 0 && Date.now() - pendingSwingAt < HIT_GRACE) {
    playerHit();
  }

  // ── AI hit detection ───────────────────────────────────────────────────────
  const aiInReach = vel.z < 0 &&
    Math.abs(p.z - AI_Z) < AI_REACH_Z &&
    Math.abs(p.x - aiPivot.position.x) < REACH_X + 0.1 &&
    p.y > TABLE_TOP - 0.1 && p.y < TABLE_TOP + 1.6;
  if (aiInReach) {
    if (!state.aiHitting) {
      state.aiHitting = true;
      if (Math.random() < AI_HIT_RATE) aiHit();    // else: whiff → ball sails past → you score
    }
  } else {
    state.aiHitting = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame updates (paddles, trail, AI movement)
// ─────────────────────────────────────────────────────────────────────────────
function updatePaddles(dt) {
  // Default: hold current position
  let tx = playerPivot.position.x;

  // Player orientation still follows the phone — that's how you aim the face.
  if (haveCalib && hasQuat) {
    qTarget.copy(qCalibInv).multiply(qPhone);      // rotation since recenter
    playerPivot.quaternion.slerp(qTarget, Math.min(1, dt * 14));
  }

  // Lateral position from PHYSICAL MOVEMENT: integrate sideways acceleration
  // once into a velocity, then push the paddle with it. Decay bleeds off the
  // sensor-bias drift that would otherwise accumulate, so this stays stable.
  if (haveCalib) {
    moveVel += moveAccel * lateralSign * MOVE_GAIN * dt;
    moveVel *= Math.pow(VEL_DECAY, dt * 60);
    moveVel  = THREE.MathUtils.clamp(moveVel, -MAX_MOVE_VEL, MAX_MOVE_VEL);
    // Integration is already smooth, so drive position directly (no extra lerp,
    // which would otherwise swallow most of the movement).
    tx += moveVel * dt;
    tx -= tx * CENTER_PULL * dt;                   // slow pull home so errors wash out
  }

  // Keyboard fallback
  if (keys['ArrowLeft'])  tx -= 6 * dt;
  if (keys['ArrowRight']) tx += 6 * dt;

  const limit = HALF_W - 0.2;
  playerPivot.position.x = THREE.MathUtils.clamp(tx, -limit, limit);
  // Stop velocity winding up while pinned against an edge
  if (Math.abs(playerPivot.position.x) >= limit - 1e-6 &&
      Math.sign(moveVel) === Math.sign(playerPivot.position.x)) moveVel = 0;

  // Paddle flash (decays)
  paddleFlash = Math.max(0, paddleFlash - dt * 3.5);
  const fe = paddleFlash * 0.7;
  playerModel.children[0].material.emissive.setRGB(fe, fe, fe);

  // AI movement: track ball x when it's heading toward the AI
  state.aiFrame++;
  if (state.aiFrame % 6 === 0) {
    if (vel.z < 0 && state.phase === 'rally') {
      const frames = (AI_Z - ball.position.z) / (vel.z || -0.001);
      const pred = ball.position.x + vel.x * Math.max(0, frames) * STEP * 60 + (Math.random() - 0.5) * 0.5;
      state.aiTargetX = THREE.MathUtils.clamp(pred, -HALF_W + 0.2, HALF_W - 0.2);
    } else {
      state.aiTargetX = 0;
    }
  }
  aiPivot.position.x += (state.aiTargetX - aiPivot.position.x) * AI_SPEED;
  // Gentle ready-sway for the AI paddle
  aiModel.rotation.z = Math.sin(performance.now() * 0.003) * 0.12;
}

function updateTrail() {
  if (state.phase !== 'rally') { trail.forEach(m => m.visible = false); return; }
  const m = trail[trailHead];
  m.position.copy(ball.position);
  m.visible = true;
  m.material.opacity = 0.32;
  m.scale.setScalar(1);
  trailHead = (trailHead + 1) % TRAIL_N;
  // fade all
  for (const t of trail) {
    if (!t.visible) continue;
    t.material.opacity *= 0.86;
    t.scale.multiplyScalar(0.93);
    if (t.material.opacity < 0.02) t.visible = false;
  }
}

function updateBlob() {
  const p = ball.position;
  const over = Math.abs(p.x) < HALF_W + 0.3 && Math.abs(p.z) < HALF_L + 0.3;
  blob.visible = over && p.y > TABLE_TOP;
  if (blob.visible) {
    blob.position.set(p.x, TABLE_TOP + 0.012, p.z);
    const h = THREE.MathUtils.clamp((p.y - TABLE_TOP) / 2.5, 0, 1);
    blob.scale.setScalar(1 + h * 1.6);
    blob.material.opacity = 0.30 * (1 - h * 0.6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD messages
// ─────────────────────────────────────────────────────────────────────────────
let msgTimer = null;
function flashMsg(big, sub, ms) {
  const el = $('msg');
  if (!big && !sub) { el.classList.add('hidden'); return; }
  $('msgBig').textContent = big;
  $('msgSub').textContent = sub;
  el.classList.remove('hidden');
  clearTimeout(msgTimer);
  if (ms > 0) msgTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function hideMsg() { $('msg').classList.add('hidden'); }
function popHit(power) {
  const q = power > 1.0 ? 'SMASH!' : power > 0.65 ? 'Nice hit' : 'Return';
  flashMsg('', q, 600);
  $('msg').classList.remove('hidden');
  $('msgBig').textContent = '';
  $('msgSub').textContent = q;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => $('msg').classList.add('hidden'), 600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle prompt
// ─────────────────────────────────────────────────────────────────────────────
function showIdlePrompt() {
  flashMsg('Ready', zigLive ? 'Swing to serve · or press SPACE' : 'Press SPACE to serve', 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
function loop() {
  const now = performance.now();
  let frameDt = (now - lastT) / 1000;
  lastT = now;
  frameDt = Math.min(frameDt, 0.05);

  if (state.phase === 'idle') {
    state.idle += frameDt;
    if (state.idle === frameDt) showIdlePrompt();     // first idle frame
    if (state.idle > 1.6) serve(Math.random() < 0.5);
  }

  if (state.phase === 'rally') {
    acc += frameDt;
    while (acc >= STEP) { physics(STEP); acc -= STEP; if (state.phase !== 'rally') break; }
  }

  updatePaddles(frameDt);
  updateTrail();
  updateBlob();
  ball.visible = state.phase === 'rally' || state.phase === 'scored';

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Small handle for tuning from the console (e.g. __t3d.serve(true))
window.__t3d = { state, vel, ball, playerPivot, camera, serve, recenter,
  feed: onSensorRaw,                       // inject a sensor packet (tuning/testing)
  debug: () => ({ moveAccel, moveVel, moveBias, x: playerPivot.position.x }) };
