/* Kaleidoscope — physical sensor control only, no auto or manual pattern selection.
   Spin phone → cycles patterns (gyro.z drives both fold spin and pattern blend)
   Tilt          → shifts origin + changes color hue (gravity vector)
   Nod/rock      → tumbles inner content (gyro.x/y accumulated warp)
   Shake         → distortion burst (linearAccel magnitude)
   Touch ZIGSIM  → outward ripple (brush:down) */
(() => {
  // ── Shaders ───────────────────────────────────────────────────────────────
  const VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

  const FS = `
precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_segs;
uniform vec2  u_tilt;    // (-1..1) from gravity — origin shift
uniform float u_spin;    // integrated gyro.z — fold rotation
uniform vec2  u_warp;    // integrated gyro.x/y (decaying) — inner tumble
uniform vec2  u_grav;    // gravity.x/y normalized -1..1 — hue shift
uniform float u_energy;  // linearAccel shake energy 0..1.5
uniform float u_pulse;   // touch ripple 0..1
uniform float u_patf;    // 0..5 continuous pattern blend from spin
uniform int   u_scheme;  // color scheme index

#define PI  3.14159265
#define TAU 6.28318530

/* ── Utilities ── */
vec3 hsv(float h, float s, float v) {
  vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

/* ── Patterns ── */
float plasma(vec2 p, float t) {
  float v  = sin(p.x * 7.0   + t);
        v += sin(p.y * 8.5   + t * 1.1);
        v += sin((p.x+p.y) * 6.0 + t * 0.7);
        v += sin(length(p)   * 12.0 - t * 2.0);
        v += noise(p * 3.0 + t * 0.15) * 0.6;
  return v * 0.185 + 0.5;
}

float crystal(vec2 p, float t) {
  float r = length(p), a = atan(p.y, p.x);
  float rings = sin(r * 20.0 - t * 2.0);
  float rays  = sin(a * 10.0 + t * 0.4 + sin(r * 6.0 + t) * 1.2);
  vec2  q     = abs(fract(p * 3.5 + t * 0.04) - 0.5);
  float grid  = 1.0 - smoothstep(0.03, 0.07, min(q.x, q.y));
  return clamp((rings * 0.38 + rays * 0.38 + grid * 0.24) * 0.5 + 0.5, 0.0, 1.0);
}

float vortex(vec2 p, float t) {
  float r = length(p), a = atan(p.y, p.x);
  float s1 = sin(a * 3.0  + r * 18.0 - t * 3.5);
  float s2 = sin(a * 5.0  - r * 12.0 + t * 2.2);
  float s3 = sin(r * 32.0 - t * 5.0) * exp(-r * 1.6);
  float s4 = sin(a * 7.0  + r * 8.0  + t * 1.4) * 0.4;
  return (s1 + s2 + s3 + s4) * 0.18 + 0.5;
}

float flower(vec2 p, float t) {
  float r = length(p), a = atan(p.y, p.x);
  float n    = 5.0 + sin(t * 0.07) * 2.0;
  float rose = abs(cos(a * n * 0.5 + t * 0.22));
  float v    = sin(r * 14.0 * (0.3 + rose * 0.7) - t * 2.5);
        v   += sin(r * 22.0 - t * 1.8) * 0.35;
        v   += noise(vec2(r * 6.0 - t * 0.1, a * 3.0)) * 0.3;
  return v * 0.3 + 0.55;
}

float fractal(vec2 p, float t) {
  vec2  z   = p * 1.85;
  vec2  off = vec2(sin(t * 0.11) * 0.5 + 0.28, cos(t * 0.09) * 0.5 + 0.28);
  float sc  = 1.52 + sin(t * 0.07) * 0.22;
  float v   = 0.0;
  for (int i = 0; i < 7; i++) {
    z  = abs(z) - off;
    z *= sc;
    v += exp(-length(z) * 1.9) / (float(i) + 1.0);
  }
  return clamp(v * 0.68, 0.0, 1.0);
}

/* Sample one of the 5 patterns by float index (0..4) */
float samplePat(vec2 p, float t, float idx) {
  if (idx < 0.5) return plasma(p, t);
  if (idx < 1.5) return crystal(p, t);
  if (idx < 2.5) return vortex(p, t);
  if (idx < 3.5) return flower(p, t);
  return fractal(p, t);
}

/* ── Color schemes ── */
vec3 colorize(float v, float hue, int scheme) {
  if (scheme == 1) return hsv(mix(0.0, 0.13, v), 0.95 - v*0.08, 0.4 + v*0.6);
  if (scheme == 2) return hsv(mix(0.55, 0.68, v), 1.0 - v*0.72, 0.5 + v*0.5);
  if (scheme == 3) return hsv(mix(0.22, 0.44, v), 0.72, 0.38 + v*0.62);
  if (scheme == 4) return hsv(hue, 1.0, clamp(v * 1.5, 0.0, 1.0));
  return hsv(hue, 0.82, 0.88 + v*0.12);  // rainbow
}

/* ── Main ── */
void main() {
  /* Centered UV */
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv -= u_tilt * 0.24;

  float r     = length(uv);
  float theta = atan(uv.y, uv.x) + u_spin;

  /* Kaleidoscope fold */
  float S     = max(2.0, u_segs);
  float slice = TAU / S;
  theta = mod(theta, TAU);
  float fold = mod(theta, slice);
  if (fold > slice * 0.5) fold = slice - fold;
  vec2 p = vec2(cos(fold), sin(fold)) * r;

  /* Secondary tumble: gyro.x/y rotate + scale the inner content
     — like the glass pieces shifting when you nod or rock the kaleidoscope */
  float wangle = u_warp.x * 0.18;
  float cw = cos(wangle), sw = sin(wangle);
  p = vec2(p.x*cw - p.y*sw, p.x*sw + p.y*cw);
  p *= 1.0 + clamp(u_warp.y * 0.06, -0.20, 0.20);

  /* Shake burst */
  float e = u_energy * 0.38 * exp(-r * 2.2);
  p += vec2(sin(r*28.0 + u_time*9.0), cos(r*28.0 + u_time*9.0)) * e;

  /* Touch ripple */
  float pls = u_pulse * sin(r*32.0 - u_time*12.0) * exp(-r*1.8) * 0.28;
  p += normalize(p + vec2(0.001)) * pls;

  float t = u_time;

  /* Smooth pattern blend driven by physical rotation (u_patf = 0..5 continuous) */
  float pnorm = mod(u_patf, 5.0);
  float pidx  = floor(pnorm);
  float pfrac = fract(pnorm);
  float pnext = mod(pidx + 1.0, 5.0);

  float va = samplePat(p, t, pidx);
  float vb = samplePat(p, t, pnext);
  float v  = mix(va, vb, smoothstep(0.1, 0.9, pfrac));

  /* Color — gravity tilt shifts hue (like rotating a kaleidoscope under different light) */
  float hue = v * 0.65 + u_time * 0.007 + u_grav.x * 0.28 + u_grav.y * 0.15;
  vec3 col = colorize(v, hue, u_scheme);

  /* Glow, vignette, burst highlights */
  col += vec3(0.18) * exp(-r * 4.5);
  col *= 1.0 - smoothstep(0.32, 1.05, r * 0.80);
  col += vec3(u_pulse  * 0.18) * exp(-r * 2.5);
  col += vec3(u_energy * 0.12) * exp(-r * 3.0);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  // ── WebGL setup ───────────────────────────────────────────────────────────
  const canvas = document.getElementById('glc');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
  if (!gl) {
    document.body.innerHTML = '<p style="color:#fff;padding:40px">WebGL not supported.</p>';
    return;
  }

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER,   VS));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  // Full-screen quad (2 triangles)
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Uniforms
  const U = {};
  for (const n of ['u_res','u_time','u_segs','u_tilt','u_spin',
                   'u_warp','u_grav','u_energy','u_pulse','u_patf','u_scheme']) {
    U[n] = gl.getUniformLocation(prog, n);
  }

  // Resize (cap DPR at 1.5)
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  function resize() {
    canvas.width  = Math.round(window.innerWidth  * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socket = io();
  socket.on('connect', () => socket.emit('hello', 'display'));

  fetch('/api/info').then(r => r.json()).then(({ ip, zigPort }) => {
    const el = document.getElementById('ip'), ep = document.getElementById('port');
    if (el) el.textContent = ip;
    if (ep) ep.textContent = zigPort;
  }).catch(() => {});

  document.getElementById('closeCard').addEventListener('click', () =>
    document.getElementById('card').classList.add('hidden'));
  document.getElementById('setupBtn').addEventListener('click', () =>
    document.getElementById('card').classList.toggle('hidden'));

  // ── Sensor state ──────────────────────────────────────────────────────────
  let tiltX = 0, tiltY = 0;       // from brush:move (gravity-derived)
  let spinAngle   = 0;             // integrated gyro.z → fold rotation + pattern blend
  let warpX = 0,  warpY = 0;      // integrated gyro.x/y → inner tumble (decays)
  let gravNX = 0, gravNY = 0;     // normalized gravity.x/y → color hue shift
  let energy  = 0;                 // linearAccel shake burst
  let pulse   = 0;                 // touch ripple
  let lastGyroAt = 0;

  socket.on('brush:move', ({ id, x, y }) => {
    if (id !== 'zigsim') return;
    tiltX = (x - 0.5) * 2;
    tiltY = (y - 0.5) * 2;
  });

  socket.on('brush:down', ({ id }) => {
    if (id === 'zigsim') pulse = 1.0;
  });

  socket.on('zig', ({ connected, source }) => {
    document.getElementById('dot').classList.toggle('live', connected);
    document.getElementById('statusText').textContent = connected
      ? `Phone · ${source || 'sensor'}` : 'Waiting for phone…';
  });

  socket.on('sensor:raw', ({ gyro, linearAccel, gravity }) => {
    if (gyro) {
      const now = Date.now();
      if (lastGyroAt) {
        const dt = Math.min((now - lastGyroAt) / 1000, 0.05);
        // z-axis: spin the fold AND advance through patterns
        spinAngle += gyro.z * dt * 0.9;
        // x/y axes: tumble the inner content (like nodding or rocking the tube)
        warpX += gyro.x * dt;
        warpY += gyro.y * dt;
        // cap warp to avoid wild distortion
        warpX = Math.max(-3.5, Math.min(3.5, warpX));
        warpY = Math.max(-3.5, Math.min(3.5, warpY));
      }
      lastGyroAt = Date.now();
    }
    if (gravity) {
      // Normalize by g≈9.8 → -1..1 range
      gravNX = gravity.x / 9.8;
      gravNY = gravity.y / 9.8;
    }
    if (linearAccel) {
      const mag = Math.hypot(linearAccel.x, linearAccel.y, linearAccel.z);
      energy = Math.min(1.5, energy + mag * 0.055);
    }
  });

  // ── Controls (segments + color only) ──────────────────────────────────────
  let currentSegments = 6;
  let currentScheme   = 0;

  function setActive(selector, dataAttr, value) {
    document.querySelectorAll(selector).forEach(b =>
      b.classList.toggle('sel', b.dataset[dataAttr] === String(value)));
  }

  document.querySelectorAll('.btn-seg').forEach(b =>
    b.addEventListener('click', () => {
      currentSegments = parseInt(b.dataset.s);
      setActive('.btn-seg', 's', currentSegments);
    }));

  document.querySelectorAll('.btn-col').forEach(b =>
    b.addEventListener('click', () => {
      currentScheme = parseInt(b.dataset.c);
      setActive('.btn-col', 'c', currentScheme);
    }));

  // Keyboard: Q/W/E/R/T → segments, ←/→ arrows → nudge spin (for keyboard testing)
  window.addEventListener('keydown', e => {
    const segMap = { q:3, w:4, e:6, r:8, t:12 };
    if (segMap[e.key]) {
      currentSegments = segMap[e.key];
      setActive('.btn-seg', 's', currentSegments);
    }
    if (e.key === 'ArrowLeft')  spinAngle -= 0.15;
    if (e.key === 'ArrowRight') spinAngle += 0.15;
  });

  // ── Pattern name HUD ──────────────────────────────────────────────────────
  const PAT_ICONS  = ['🌊', '💎', '🌀', '🌸', '🔮'];
  const PAT_NAMES  = ['Plasma', 'Crystal', 'Vortex', 'Flower', 'Fractal'];
  const patNameEl  = document.getElementById('patName');
  let   lastPatIdx = -1;
  let   flashTimer = null;

  function updatePatHUD(idx) {
    if (idx === lastPatIdx) return;
    lastPatIdx = idx;
    patNameEl.textContent = PAT_ICONS[idx] + ' ' + PAT_NAMES[idx];
    patNameEl.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => patNameEl.classList.remove('flash'), 1800);
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  const startTime = Date.now();
  let lastFrameAt = startTime;

  function frame() {
    const now     = Date.now();
    const dt      = Math.min((now - lastFrameAt) / 1000, 0.05);
    lastFrameAt   = now;
    const elapsed = (now - startTime) / 1000;

    // Tiny ambient drift so it's alive even without a phone
    spinAngle += 0.04 * dt;

    // Decay warp (settles over ~2-3 seconds after last gyro.x/y motion)
    warpX *= Math.pow(0.985, dt * 60);
    warpY *= Math.pow(0.985, dt * 60);

    // Decay energy + pulse
    energy *= Math.pow(0.93, dt * 60);
    pulse  *= Math.pow(0.97, dt * 60);

    // Pattern blend: one full 360° spin → cycles all 5 patterns (72° per pattern)
    // As you spin faster, patterns flash by; slow deliberate rotation lets you settle on one
    const patternBlend = ((spinAngle * 5 / (Math.PI * 2)) % 5 + 5) % 5;

    // Uniforms
    gl.uniform2f(U.u_res,    canvas.width, canvas.height);
    gl.uniform1f(U.u_time,   elapsed);
    gl.uniform1f(U.u_segs,   currentSegments);
    gl.uniform2f(U.u_tilt,   tiltX, tiltY);
    gl.uniform1f(U.u_spin,   spinAngle);
    gl.uniform2f(U.u_warp,   warpX, warpY);
    gl.uniform2f(U.u_grav,   gravNX, gravNY);
    gl.uniform1f(U.u_energy, energy);
    gl.uniform1f(U.u_pulse,  pulse);
    gl.uniform1f(U.u_patf,   patternBlend);
    gl.uniform1i(U.u_scheme, currentScheme);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Update pattern name (only when crossing a whole-number boundary)
    updatePatHUD(Math.floor(patternBlend) % 5);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
