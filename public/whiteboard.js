/* Whiteboard — runs on the computer. Receives brush events (ZIGSIM via the
   server, or a legacy in-browser controller) and paints. */
(() => {
  const BOARD_BG = '#f7f7f8';
  const COLORS = ['#1b1d22', '#ff3b3b', '#4f8cff', '#23c552', '#ff9f1c', '#a55eff', BOARD_BG];

  const socket = io();
  socket.on('connect', () => socket.emit('hello', 'display'));

  const paint = document.getElementById('paint');
  const cursor = document.getElementById('cursor');
  const pctx = paint.getContext('2d');
  const cctx = cursor.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Current style (owned by the whiteboard now that the phone is just a sensor).
  let curColor = COLORS[0];
  let curSize = 14;
  let manualPen = false; // SPACE held -> paint (fallback when ZIGSIM has no touch)

  function resize() {
    const snap = paint.width ? pctx.getImageData(0, 0, paint.width, paint.height) : null;
    for (const c of [paint, cursor]) {
      c.width = Math.floor(innerWidth * dpr);
      c.height = Math.floor(innerHeight * dpr);
      c.style.width = innerWidth + 'px';
      c.style.height = innerHeight + 'px';
    }
    if (snap) pctx.putImageData(snap, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  // One brush per source id (ZIGSIM uses the id "zigsim").
  const brushes = new Map();
  function brush(id) {
    if (!brushes.has(id)) {
      brushes.set(id, { id, x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, px: null, py: null,
        down: false, peff: false, color: curColor, size: curSize });
    }
    return brushes.get(id);
  }

  socket.on('brush:move', ({ id, x, y }) => { const b = brush(id); b.x = x; b.y = y; });
  socket.on('brush:down', ({ id }) => { brush(id).down = true; });
  socket.on('brush:up', ({ id }) => { brush(id).down = false; });
  socket.on('brush:color', ({ id, color }) => { brush(id).color = color; });
  socket.on('brush:size', ({ id, size }) => { brush(id).size = size; });
  socket.on('brush:clear', clearBoard);
  socket.on('controller:left', ({ id }) => brushes.delete(id));

  // ZIGSIM connection status
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('statusText');
  const card = document.getElementById('card');
  socket.on('zig', ({ connected, source }) => {
    dot.classList.toggle('live', connected);
    statusText.textContent = connected
      ? `Phone connected · ${source || 'sensor'}`
      : 'Waiting for phone…';
    card.classList.toggle('hidden', connected);
  });

  // --- Palette + size UI ---------------------------------------------------
  const palette = document.getElementById('palette');
  COLORS.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'swatch' + (i === 0 ? ' sel' : '') + (c === BOARD_BG ? ' eraser' : '');
    el.style.background = c;
    if (c === BOARD_BG) el.textContent = '⌫';
    el.title = c === BOARD_BG ? 'Eraser' : c;
    el.onclick = () => {
      curColor = c;
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
      el.classList.add('sel');
      for (const b of brushes.values()) b.color = curColor;
    };
    palette.appendChild(el);
  });
  document.getElementById('size').oninput = (e) => {
    curSize = +e.target.value;
    for (const b of brushes.values()) b.size = curSize;
  };

  // --- Buttons + keyboard --------------------------------------------------
  const flipXBtn = document.getElementById('flipX');
  const flipYBtn = document.getElementById('flipY');
  document.getElementById('setupBtn').onclick = () => card.classList.toggle('hidden');
  document.getElementById('saveBtn').onclick = savePNG;
  document.getElementById('clearBtn').onclick = clearBoard;
  document.getElementById('recenterBtn').onclick = () => socket.emit('zig:recenter');
  flipXBtn.onclick = () => socket.emit('zig:flip', { axis: 'x' });
  flipYBtn.onclick = () => socket.emit('zig:flip', { axis: 'y' });

  socket.on('zig:axes', ({ invertX, invertY }) => {
    flipXBtn.classList.toggle('active', invertX);
    flipYBtn.classList.toggle('active', invertY);
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); manualPen = true; }
    else if (e.key === 'r' || e.key === 'R') socket.emit('zig:recenter');
    else if (e.key === 'x' || e.key === 'X') socket.emit('zig:flip', { axis: 'x' });
    else if (e.key === 'y' || e.key === 'Y') socket.emit('zig:flip', { axis: 'y' });
    else if (e.key === 'c' || e.key === 'C') clearBoard();
    else if (e.key === 's' || e.key === 'S') savePNG();
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') manualPen = false; });

  function clearBoard() { pctx.clearRect(0, 0, paint.width, paint.height); }

  function savePNG() {
    const out = document.createElement('canvas');
    out.width = paint.width; out.height = paint.height;
    const o = out.getContext('2d');
    o.fillStyle = BOARD_BG; o.fillRect(0, 0, out.width, out.height);
    o.drawImage(paint, 0, 0);
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `whiteboard-${Date.now()}.png`;
    a.click();
  }

  // Fill in the ZIGSIM address/port on the setup card.
  fetch('/api/info').then((r) => r.json()).then(({ ip, zigPort }) => {
    document.getElementById('ip').textContent = ip;
    document.getElementById('port').textContent = zigPort;
  }).catch(() => {});

  // --- Render loop ---------------------------------------------------------
  function frame() {
    cctx.clearRect(0, 0, cursor.width, cursor.height);
    for (const b of brushes.values()) {
      b.sx += (b.x - b.sx) * 0.45;
      b.sy += (b.y - b.sy) * 0.45;
      const X = b.sx * paint.width;
      const Y = b.sy * paint.height;
      const w = b.size * dpr;

      // Effective pen: explicit brush:down, or SPACE held (ZIGSIM fallback).
      const eff = b.down || (b.id === 'zigsim' && manualPen);
      if (eff && !b.peff) { b.px = X; b.py = Y; } // pen just went down — start fresh
      b.peff = eff;

      if (eff) {
        pctx.strokeStyle = b.color;
        pctx.lineWidth = w;
        pctx.lineCap = 'round';
        pctx.lineJoin = 'round';
        pctx.beginPath();
        pctx.moveTo(b.px, b.py);
        pctx.lineTo(X, Y);
        pctx.stroke();
        b.px = X; b.py = Y;
      }

      // Live cursor
      cctx.beginPath();
      cctx.arc(X, Y, Math.max(5 * dpr, w / 2) + (eff ? 0 : 3 * dpr), 0, Math.PI * 2);
      cctx.lineWidth = 2 * dpr;
      cctx.strokeStyle = eff ? b.color : 'rgba(20,22,28,.45)';
      cctx.stroke();
      if (eff) { cctx.fillStyle = b.color + '33'; cctx.fill(); }
    }
    requestAnimationFrame(frame);
  }
  frame();
})();
