/* =========================================================
   arakesit 3D — sıfır bağımlılıklı 3D yazıcı animasyonu
   Three.js gibi büyük kütüphaneler yerine ~5 KB'lık küçük bir
   canvas motoru: mobilde hızlı açılır, ekranda değilken durur.
   ========================================================= */
(() => {
  'use strict';

  /* ---------- Clickjacking koruması (yedek) ----------
     Asıl koruma sunucu başlığıdır (X-Frame-Options / frame-ancestors, bkz. _headers).
     Statik barındırmada başlık yoksa, sayfa başka bir sitenin iframe'i içindeyse gizlenir. */
  if (window.top !== window.self) {
    document.documentElement.hidden = true;
    try { window.top.location.href = window.self.location.href; } catch (_) { /* cross-origin: gizli kalır */ }
    return;
  }

  /* ---------- Küçük yardımcılar ---------- */
  const $ = (s) => document.querySelector(s);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const yearEl = $('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Scroll reveal ---------- */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-in'));
  }

  /* ---------- Mobil Instagram butonu: hero geçilince görünür ---------- */
  const fab = $('.fab');
  const hero = $('#hero');
  const cta = $('.cta');
  if (fab && hero && 'IntersectionObserver' in window) {
    let heroVisible = true, ctaVisible = false;
    const update = () => fab.classList.toggle('is-visible', !heroVisible && !ctaVisible);
    new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; update(); }, { threshold: 0.05 }).observe(hero);
    if (cta) new IntersectionObserver(([e]) => { ctaVisible = e.isIntersecting; update(); }, { threshold: 0.2 }).observe(cta);
  }

  /* =========================================================
     3D YAZICI ANİMASYONU
     ========================================================= */
  const canvas = $('#printer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const layerEl = $('#layer-num');

  // Model: [x0, y0, z0, x1, y1, z1] — eksen hizalı kutular (z yukarı)
  const MODEL = [
    [-56, -36, 0, 56, 36, 10],      // taban
    [-44, -26, 10, -8, 10, 78],     // ana gövde
    [-8, -26, 10, 22, 10, 56],      // orta basamak
    [22, -26, 10, 44, 10, 36],      // alçak basamak
    [-44, 14, 10, 44, 30, 24],      // ön tepsi
    [-34, -16, 78, -18, 0, 88],     // üst düğme
  ];
  const H = 88;                 // toplam yükseklik
  const LAYER_MM = 0.12;         // gösterilen katman kalınlığı
  const LINE_STEP = 2.2;        // görsel katman çizgisi aralığı
  const PLATE = [-82, -62, -4, 82, 62, 0];

  // Kamera
  const PHI = 0.52;             // yükseklik açısı (~30°)
  const D = 520;                // kamera uzaklığı
  const ZC = 34;                // dönme merkezi yüksekliği
  const sinP = Math.sin(PHI), cosP = Math.cos(PHI);

  // Zamanlama
  const T_PRINT = 11, T_HOLD = 2.6, T_FADE = 0.7;
  const T_CYCLE = T_PRINT + T_HOLD + T_FADE;

  let W = 0, Hc = 0, cx = 0, cy = 0, scale = 1, dpr = 1;
  let theta = -0.6, sinT = 0, cosT = 1;
  let dragVel = 0, dragging = false, lastX = 0;
  let running = false, visible = true, rafId = 0, last = 0, clock = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width)); Hc = Math.max(1, Math.round(r.height));
    canvas.width = W * dpr; canvas.height = Hc * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2; cy = Hc * 0.55;
    scale = Math.min(W / 215, Hc / 170);
    if (!running) draw();
  }

  // Dünya → ekran
  function P(x, y, z) {
    const pz = z - ZC;
    const rx = x * cosT - y * sinT;
    const ry = x * sinT + y * cosT;
    const sx = rx, sy = ry * sinP + pz * cosP;
    const depth = ry * cosP - pz * sinP + D;
    const k = scale * D / depth;
    return [cx + sx * k, cy - sy * k];
  }

  function poly(pts, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  const rgb = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

  // Kutuların doğru çizim sırası (ayırıcı eksen ile ressam algoritması)
  function order(boxes, C) {
    const n = boxes.length;
    const behind = (a, b) => { // -1: a önce, 1: b önce, 0: belirsiz
      for (let k = 0; k < 3; k++) {
        if (a[k + 3] <= b[k] + 1e-6) { if (C[k] >= b[k]) return -1; if (C[k] <= a[k + 3]) return 1; }
        if (b[k + 3] <= a[k] + 1e-6) { if (C[k] >= a[k]) return 1; if (C[k] <= b[k + 3]) return -1; }
      }
      return 0;
    };
    const indeg = new Array(n).fill(0), adj = boxes.map(() => []);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const r = behind(boxes[i], boxes[j]);
      if (r < 0) { adj[i].push(j); indeg[j]++; } else if (r > 0) { adj[j].push(i); indeg[i]++; }
    }
    const out = [], q = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) q.push(i);
    while (q.length) { const i = q.shift(); out.push(boxes[i]); for (const j of adj[i]) if (!--indeg[j]) q.push(j); }
    if (out.length < n) boxes.forEach((b) => { if (!out.includes(b)) out.push(b); });
    return out;
  }

  function drawBox(b, C, L, opts) {
    const [x0, y0, z0, x1, y1, z1] = b;
    const c = opts.color;
    const shade = (nx, ny, nz) => {
      const d = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const f = opts.ambient + (1 - opts.ambient) * d;
      return rgb(c[0] * f, c[1] * f, c[2] * f, opts.alpha);
    };
    const faces = [];
    if (C[0] < x0) faces.push([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], -1, 0, 0]);
    if (C[0] > x1) faces.push([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 1, 0, 0]);
    if (C[1] < y0) faces.push([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, -1, 0]);
    if (C[1] > y1) faces.push([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], 0, 1, 0]);

    for (const f of faces) {
      const pts = [P(...f[0]), P(...f[1]), P(...f[2]), P(...f[3])];
      poly(pts, shade(f[4], f[5], f[6]));
      // katman çizgileri
      if (opts.lines) {
        ctx.beginPath();
        const a = f[0], e = f[1];
        for (let z = z0 + LINE_STEP; z < z1 - 0.3; z += LINE_STEP) {
          const p1 = P(a[0], a[1], z), p2 = P(e[0], e[1], z);
          ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
        }
        ctx.strokeStyle = `rgba(0,0,0,${0.07 * opts.alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (C[2] > z1) {
      const top = [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
      if (opts.fresh) {
        poly(top, rgb(255, 238, 214, opts.alpha));
        ctx.lineWidth = 2;
        poly(top, null, rgb(255, 159, 10, opts.alpha));
      } else {
        poly(top, shade(0, 0, 1));
      }
    }
  }

  function draw() {
    // Döngü durumu
    let t = reduceMotion ? T_PRINT + 0.01 : clock % T_CYCLE;
    const printing = t < T_PRINT;
    const h = printing ? H * (t / T_PRINT) : H;
    const alpha = t > T_PRINT + T_HOLD ? Math.max(0, 1 - (t - T_PRINT - T_HOLD) / T_FADE) : 1;

    sinT = Math.sin(theta); cosT = Math.cos(theta);
    const C = [-D * cosP * sinT, -D * cosP * cosT, D * sinP + ZC];
    const Lv = [-0.45, -0.62, 0.64];
    const L = [Lv[0] * cosT + Lv[1] * sinT, -Lv[0] * sinT + Lv[1] * cosT, Lv[2]];

    ctx.clearRect(0, 0, W, Hc);
    ctx.lineJoin = 'round';

    // Baskı tablası
    drawBox(PLATE, C, L, { color: [58, 58, 62], ambient: 0.55, alpha: 1, lines: false });
    // tabla ızgarası
    ctx.beginPath();
    for (let x = -70; x <= 70; x += 14) { const a = P(x, -56, 0), b = P(x, 56, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    for (let y = -56; y <= 56; y += 14) { const a = P(-76, y, 0), b = P(76, y, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.stroke();

    // Basılmış kısım (h'de kesilmiş)
    const clipped = [];
    const active = [];
    for (const b of MODEL) {
      if (b[2] >= h) continue;
      const z1 = Math.min(b[5], h);
      const box = [b[0], b[1], b[2], b[3], b[4], z1];
      box.fresh = printing && b[5] > h;
      if (box.fresh) active.push(box);
      clipped.push(box);
    }
    for (const b of order(clipped, C)) {
      drawBox(b, C, L, { color: [240, 240, 245], ambient: 0.42, alpha, lines: true, fresh: b.fresh });
    }

    // Nozul + portal
    if (alpha > 0) drawHead(h, active, printing, t, alpha);

    if (layerEl) layerEl.textContent = String(Math.round(h / LAYER_MM)).padStart(3, '0');
  }

  function drawHead(h, active, printing, t, alpha) {
    let nx = 0, ny = 0, nz = h;
    if (printing && active.length) {
      const speed = 1.3;
      const box = active[Math.floor(t * speed) % active.length];
      const f = (t * speed) % 1;
      const [x0, y0, , x1, y1] = box;
      const w = x1 - x0, d = y1 - y0, per = 2 * (w + d);
      let s = f * per;
      if (s < w) { nx = x0 + s; ny = y0; }
      else if ((s -= w) < d) { nx = x1; ny = y0 + s; }
      else if ((s -= d) < w) { nx = x1 - s; ny = y1; }
      else { s -= w; nx = x0; ny = y1 - s; }
    } else {
      // park pozisyonu: yukarı çık
      const k = Math.min(1, (t - T_PRINT) / 0.8);
      nx = 70 * k; ny = -50 * k; nz = H + 22 * k;
    }
    const zr = nz + 14;
    ctx.globalAlpha = alpha;

    // X rayı
    const r1 = P(-88, ny, zr), r2 = P(88, ny, zr);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, scale * 2.2);
    ctx.strokeStyle = 'rgba(160,160,168,0.55)';
    ctx.beginPath(); ctx.moveTo(r1[0], r1[1]); ctx.lineTo(r2[0], r2[1]); ctx.stroke();

    // Kafa gövdesi
    const s = 6;
    const L = [0, 0, 1];
    const C = [-D * cosP * sinT, -D * cosP * cosT, D * sinP + ZC];
    drawBox([nx - s, ny - s, nz + 5, nx + s, ny + s, zr + 4], C, L, { color: [44, 44, 48], ambient: 0.8, alpha: 1, lines: false });

    // Nozul ucu
    const a = P(nx - 2.4, ny, nz + 5), b = P(nx + 2.4, ny, nz + 5), tip = P(nx, ny, nz);
    poly([a, b, tip], '#c9a227');

    // Sıcak uç parıltısı
    if (printing) {
      const g = ctx.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], scale * 9);
      g.addColorStop(0, 'rgba(255,170,40,0.95)');
      g.addColorStop(0.3, 'rgba(255,130,20,0.35)');
      g.addColorStop(1, 'rgba(255,120,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(tip[0], tip[1], scale * 9, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    clock += dt;
    if (!dragging) {
      theta += dt * 0.28 + dragVel;
      dragVel *= 0.92;
    }
    draw();
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduceMotion || !visible || document.hidden) return;
    running = true; last = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(rafId); }

  // Sürükleyerek döndürme (dikey kaydırmayı engellemez)
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; dragVel = 0; });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - lastX) * 0.008;
    theta += dx; dragVel = dx * 0.5; lastX = e.clientX;
    if (!running) draw();
  });
  const endDrag = () => { dragging = false; };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);

  // Görünür değilken animasyonu durdur (pil + performans)
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  else addEventListener('resize', resize);

  resize();
  start();
})();

