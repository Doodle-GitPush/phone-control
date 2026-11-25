'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const express = require('express');
const selfsigned = require('selfsigned');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;          // whiteboard (browser)
const ZIG_PORT = Number(process.env.ZIGSIM_PORT) || 50000; // ZIGSIM UDP input
const USE_HTTPS = process.env.HTTPS === '1';            // only for the legacy web brush

// ---------------------------------------------------------------------------
// Self-signed cert — only needed in HTTPS mode (the optional in-browser brush).
// ZIGSIM talks UDP, so by default we serve the whiteboard over plain HTTP.
// ---------------------------------------------------------------------------
async function loadCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'phone-paint' }],
    { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 3650 * 864e5) }
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const IP = lanIP();
const SCHEME = USE_HTTPS ? 'https' : 'http';

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Connection details shown on the whiteboard so you know what to type in ZIGSIM.
app.get('/api/info', (_req, res) => {
  res.json({ ip: IP, zigPort: ZIG_PORT, scheme: SCHEME, webPort: PORT });
});

// Live diagnostics for debugging the ZIGSIM connection.
app.get('/api/debug', (_req, res) => {
  res.json({
    listeningOnUdpPort: ZIG_PORT,
    zigConnected,
    secondsSinceLastPacket: stats.lastAt ? +((Date.now() - stats.lastAt) / 1000).toFixed(1) : null,
    packetsReceived: stats.total,
    nonJsonPackets: stats.nonJson,
    lastSource: stats.lastSrc,
    lastSensorKeys: stats.lastKeys,
    lastBrushXY: stats.lastXY,
    lastPenDown: stats.lastPen,
    whiteboardsOpen: stats.displays,
    lastRawPacket: stats.lastRaw,
    zig: { x0: zig.x0, y0: zig.y0, gain: zig.gain, source: zig.source, invertX: zig.invertX, invertY: zig.invertY },
  });
});

// ---------------------------------------------------------------------------
// Realtime relay to the whiteboard(s)
// ---------------------------------------------------------------------------
let io;

const BRUSH_EVENTS = ['brush:move', 'brush:down', 'brush:up', 'brush:color', 'brush:size', 'brush:clear'];

function wireRealtime() {
  io.on('connection', (socket) => {
    socket.on('hello', (role) => {
      socket.data.role = role === 'display' ? 'display' : 'controller';
      socket.join(socket.data.role === 'display' ? 'displays' : 'controllers');
      if (socket.data.role === 'display') {
        stats.displays++;
        console.log(`  [web] whiteboard connected (${stats.displays} open)`);
      }
      socket.emit('zig', { connected: zigConnected, source: zig.source });
      socket.emit('zig:axes', { invertX: zig.invertX, invertY: zig.invertY });
    });

    // Legacy in-browser brush: relay its events straight through.
    for (const event of BRUSH_EVENTS) {
      socket.on(event, (payload) => io.to('displays').emit(event, { id: socket.id, ...(payload || {}) }));
    }

    // Whiteboard controls for the ZIGSIM brush.
    socket.on('zig:recenter', () => { zig.x0 = zig.y0 = null; });
    socket.on('zig:gain', ({ gain }) => { if (Number.isFinite(gain)) zig.gain = gain; });
    socket.on('zig:flip', ({ axis }) => {
      if (axis === 'x') zig.invertX = !zig.invertX;
      if (axis === 'y') zig.invertY = !zig.invertY;
      io.to('displays').emit('zig:axes', { invertX: zig.invertX, invertY: zig.invertY });
    });

    socket.on('disconnect', () => {
      if (socket.data.role === 'display') {
        stats.displays = Math.max(0, stats.displays - 1);
        console.log(`  [web] whiteboard disconnected (${stats.displays} open)`);
      }
      if (socket.data.role === 'controller') {
        io.to('displays').emit('brush:up', { id: socket.id });
        io.to('displays').emit('controller:left', { id: socket.id });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// ZIGSIM input — phone sensors streamed over UDP as JSON.
//   gravity / quaternion -> brush x,y      (tilt to move)
//   touch                -> pen down       (hold a finger to paint)
// Axis signs/keys vary by device + app version, so we log the first packets
// and auto-calibrate the "centre" from the first reading.
// ---------------------------------------------------------------------------
const ZIG_ID = 'zigsim';
const zig = { x0: null, y0: null, gain: 1.0, pen: false, source: null, alive: 0,
  invertX: true, invertY: false };
let zigConnected = false;

// Live diagnostics (exposed at /api/debug) so we can see what's arriving.
const stats = {
  total: 0, nonJson: 0, lastSrc: null, lastAt: 0, lastRaw: null,
  lastKeys: null, lastXY: null, lastPen: false, displays: 0,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function quatToTilt(q) {
  const { x, y, z, w } = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  return { x: roll, y: pitch };
}

// Pick the best available tilt source; gainHint normalizes each to ~[-1,1].
function readTilt(sd) {
  if (sd.gravity && typeof sd.gravity.x === 'number')
    return { x: sd.gravity.x, y: sd.gravity.y, source: 'gravity', gainHint: 2.2 };
  if (sd.quaternion && typeof sd.quaternion.w === 'number')
    return { ...quatToTilt(sd.quaternion), source: 'quaternion', gainHint: 1.1 };
  if (sd.accel && typeof sd.accel.x === 'number')
    return { x: sd.accel.x, y: sd.accel.y, source: 'accel', gainHint: 2.2 };
  return null;
}

function readPen(sd) {
  const t = sd.touch ?? sd.touches ?? sd.touchcount ?? sd.touchCount;
  if (Array.isArray(t)) return t.length > 0;
  if (typeof t === 'number') return t > 0.5;
  if (t && typeof t === 'object') return Object.keys(t).length > 0;
  for (const k of Object.keys(sd)) if (/^touch\d+$/i.test(k)) return true;
  return false;
}

function mapZig(data) {
  const sd = data.sensordata || data;
  const tilt = readTilt(sd);
  if (!tilt) { stats.lastXY = null; return; } // arriving, but no usable tilt sensor
  zig.source = tilt.source;
  if (zig.x0 == null) { zig.x0 = tilt.x; zig.y0 = tilt.y; } // auto-calibrate centre

  const g = zig.gain * tilt.gainHint;
  const sx = zig.invertX ? -1 : 1;
  const sy = zig.invertY ? -1 : 1;
  const nx = clamp01(0.5 + (tilt.x - zig.x0) * g * sx);
  const ny = clamp01(0.5 + (tilt.y - zig.y0) * g * sy);
  stats.lastXY = { x: +nx.toFixed(3), y: +ny.toFixed(3) };
  io.to('displays').emit('brush:move', { id: ZIG_ID, x: nx, y: ny });

  // Raw sensor data for games (accel/gyro-driven mechanics).
  const raw = {};
  if (sd.gravity)    raw.gravity    = sd.gravity;
  if (sd.accel)      raw.accel      = sd.accel;
  if (sd.gyro)       raw.gyro       = sd.gyro;
  if (sd.quaternion) raw.quaternion = sd.quaternion;
  if (sd.accel && sd.gravity) {
    raw.linearAccel = {
      x: sd.accel.x - sd.gravity.x,
      y: sd.accel.y - sd.gravity.y,
      z: sd.accel.z - sd.gravity.z,
    };
  }
  if (Object.keys(raw).length) io.to('displays').emit('sensor:raw', raw);

  const pen = readPen(sd);
  stats.lastPen = pen;
  if (pen !== zig.pen) {
    zig.pen = pen;
    io.to('displays').emit(pen ? 'brush:down' : 'brush:up', { id: ZIG_ID });
  }
}

function startZigSim() {
  const udp = dgram.createSocket('udp4');
  const seen = new Set();
  udp.on('message', (msg, rinfo) => {
    const raw = msg.toString();
    stats.total++;
    stats.lastSrc = rinfo.address;
    stats.lastAt = Date.now();
    stats.lastRaw = raw.slice(0, 600);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      stats.nonJson++;
      if (!seen.has(rinfo.address + '#nonjson')) {
        seen.add(rinfo.address + '#nonjson');
        console.log(`\n  [zigsim] ⚠️  packet from ${rinfo.address} is NOT JSON — set ZIGSIM "Data Format" to JSON.`);
        console.log(`  [zigsim] raw: ${raw.slice(0, 160)}\n`);
      }
      return;
    }

    const sd = data.sensordata || data;
    stats.lastKeys = Object.keys(sd);
    if (!seen.has(rinfo.address)) {
      seen.add(rinfo.address);
      console.log(`\n  [zigsim] ✅ first packet from ${rinfo.address}`);
      console.log(`  [zigsim] sensor keys: ${stats.lastKeys.join(', ') || '(none)'}`);
      console.log(`  [zigsim] sample: ${JSON.stringify(data).slice(0, 480)}\n`);
    }
    zig.alive = Date.now();
    mapZig(data);
  });
  udp.on('error', (e) => console.error('  [zigsim] UDP error:', e.message));
  udp.bind(ZIG_PORT, () => console.log(`  [zigsim] listening for UDP/JSON on port ${ZIG_PORT}`));

  // Liveness: tell the whiteboard when the phone starts/stops streaming.
  setInterval(() => {
    const live = Date.now() - zig.alive < 1500;
    if (live !== zigConnected) {
      zigConnected = live;
      io.to('displays').emit('zig', { connected: live, source: zig.source });
      if (!live) io.to('displays').emit('brush:up', { id: ZIG_ID });
    }
  }, 500);
}

async function main() {
  const server = USE_HTTPS
    ? https.createServer(await loadCert(), app)
    : http.createServer(app);
  io = new Server(server);
  wireRealtime();
  server.listen(PORT, '0.0.0.0', onListening);
  startZigSim();
}

function onListening() {
  const line = '  ' + '='.repeat(56);
  console.log('\n  🎨  Phone Paint — ZIGSIM edition\n');
  console.log(line);
  console.log('  1) On THIS computer, open the whiteboard:');
  console.log(`        ${SCHEME}://localhost:${PORT}`);
  console.log('');
  console.log('  2) In ZIGSIM on your phone (same Wi-Fi), set:');
  console.log('        Protocol : UDP');
  console.log('        Format   : JSON');
  console.log(`        Address  : ${IP}`);
  console.log(`        Port     : ${ZIG_PORT}`);
  console.log('        Sensors  : Gravity + Quaternion + Touch');
  console.log('     then press Start.');
  console.log(line);
  console.log('  Tilt to move the brush. Hold a finger on the ZIGSIM screen');
  console.log('  (or hold SPACE on the computer) to paint. Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Failed to start Phone Paint:', err);
  process.exit(1);
});
