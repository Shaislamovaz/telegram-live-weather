/*!
 * Telegram Live Weather — WeatherLayer engine
 * Framework-agnostic, zero dependencies, Canvas 2D.
 * MIT License
 *
 * Two canvases:
 *   background — behind messages (gradient, clouds, fog, sun rays, stars, rain, glass drops, far snow)
 *   foreground — above messages, pointer-events: none (snow caps on bubbles, splashes, near flakes, glare)
 *
 * The host app supplies getBubbles() -> [{ el, x, y, w, h, r }] in layer-local CSS pixels
 * and calls frame(timeMs) once per animation frame.
 */
(function (global) {
  'use strict';

  const TW = (global.TgWeather = global.TgWeather || {});

  // ---------- helpers -------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const approach = (cur, target, rate, s) => cur + (target - cur) * (1 - Math.exp(-rate * s));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // ---------- palettes: 4 gradient points, like Telegram's animated wallpapers
  const RAW = {
    // 'none' = the classic Telegram wallpaper, no weather effects
    none:   { day: ['#dbddbb', '#6ba587', '#d5d88d', '#88b884'], night: ['#121d22', '#1c2b2a', '#16231f', '#22302d'] },
    clear: { day: ['#ffe2a8', '#f9b16e', '#9fd8f2', '#63b3ea'], night: ['#0a1730', '#16295a', '#24194a', '#0d2440'] },
    cloudy: { day: ['#d6dfe8', '#aebdcd', '#e9edf2', '#93a6bb'], night: ['#1a222d', '#27313f', '#1f2834', '#323d4d'] },
    rain:   { day: ['#8197ab', '#5d758b', '#a5b6c5', '#4e6377'], night: ['#101a25', '#1b2938', '#14202d', '#223243'] },
    storm:  { day: ['#4f5866', '#363f4c', '#5d6674', '#2a323e'], night: ['#090d15', '#131924', '#0d131d', '#1b222d'] },
    snow:   { day: ['#c4d6ea', '#93afd0', '#d6e3f1', '#7f9ec4'], night: ['#15223a', '#21314f', '#1a2944', '#2b3c5b'] },
    fog:    { day: ['#e1e4e7', '#c9ced3', '#eef0f1', '#b8bec4'], night: ['#1d2125', '#292e33', '#23272c', '#32373d'] },
  };
  const PALETTES = {};
  for (const k in RAW) PALETTES[k] = { day: RAW[k].day.map(hex), night: RAW[k].night.map(hex) };

  // ---------- which effects a condition turns on (weights 0..1+)
  const EFFECTS = ['sun', 'rain', 'snow', 'fog', 'stars', 'moon', 'storm', 'clouds'];
  function targetsFor(cond, night) {
    const t = {}; EFFECTS.forEach((k) => (t[k] = 0));
    switch (cond) {
      case 'clear':  if (night) { t.stars = 1; t.moon = 1; } else t.sun = 1; break;
      case 'cloudy': t.clouds = 1; if (night) t.stars = 0.25; else t.sun = 0.3; break;
      case 'rain':   t.rain = 1; t.clouds = 0.45; break;
      case 'storm':  t.rain = 1.35; t.storm = 1; t.clouds = 0.8; break;
      case 'snow':   t.snow = 1; if (night) t.stars = 0.35; break;
      case 'fog':    t.fog = 1; break;
    }
    return t;
  }

  const COL = 3;          // snow-cap column width, px
  const CAP_MAX = 10;     // max snow height on a bubble, px

  class WeatherLayer {
    /**
     * @param {object} o
     * @param {HTMLCanvasElement} o.background
     * @param {HTMLCanvasElement} o.foreground
     * @param {() => Array<{el:Element,x:number,y:number,w:number,h:number,r:number}>} o.getBubbles
     * @param {number} o.width  CSS px
     * @param {number} o.height CSS px
     * @param {number} [o.dpr]
     * @param {number} [o.quality] particle multiplier, 0.3 (low-end) … 1
     * @param {boolean} [o.reducedMotion] gradient only, no particles
     */
    constructor(o) {
      this.bg = o.background; this.fg = o.foreground;
      this.b = this.bg.getContext('2d'); this.f = this.fg.getContext('2d');
      this.getBubbles = o.getBubbles || (() => []);
      this.onEvent = o.onEvent || null; // optional hook: 'lightning', 'shooting-star' (e.g. for sound)
      this.dpr = o.dpr || Math.min(global.devicePixelRatio || 1, 2);
      this.quality = o.quality == null ? 1 : o.quality;
      this.reduced = !!o.reducedMotion;
      this.cond = 'clear'; this.night = false;
      this.target = targetsFor('clear', false);
      this.w = Object.assign({}, this.target);
      this.colors = PALETTES.clear.day.map((c) => c.slice());
      this.caps = new WeakMap();
      this.time = 0; this.last = null;
      this.flash = 0; this.bolt = null; this.nextBolt = 2500; this.pendingFlash = -1;
      this.shoot = null; this.nextShoot = 3500;
      this.splashes = []; this.chunks = []; this.drops = [];
      this.resize(o.width, o.height);
    }

    resize(w, h) {
      this.W = w; this.H = h;
      for (const c of [this.bg, this.fg]) {
        c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr);
        c.style.width = w + 'px'; c.style.height = h + 'px';
      }
      this.seed();
    }

    seed() {
      const { W, H } = this, q = this.quality;
      this.stars = Array.from({ length: Math.round(110 * q) }, () => ({
        x: rand(0, W), y: Math.pow(Math.random(), 1.4) * H * 0.75, r: rand(0.4, 1.5), ph: rand(0, 6.28), sp: rand(0.6, 2.2),
      }));
      this.motes = Array.from({ length: Math.round(34 * q) }, () => ({
        x: rand(0, W), y: rand(0, H), r: rand(0.8, 2.6), vy: rand(4, 14), ph: rand(0, 6.28),
      }));
      this.fogs = Array.from({ length: 9 }, (_, i) => ({
        x: rand(-0.2, 1.2) * W, y: (i / 8) * H * 1.1 - H * 0.05, r: rand(0.45, 0.8) * W, vx: rand(4, 12) * (Math.random() < 0.5 ? -1 : 1),
      }));
      this.clouds = Array.from({ length: 5 }, (_, i) => ({
        x: rand(0, W), y: rand(0.02, 0.45) * H, s: rand(0.7, 1.4), vx: rand(5, 11), seed: i,
        puffs: Array.from({ length: 6 }, () => ({ dx: rand(-70, 70), dy: rand(-18, 18), r: rand(34, 64) })),
      }));
      this.streaks = Array.from({ length: Math.round(300 * q) }, () => this.newStreak(true));
      this.flakes = Array.from({ length: Math.round(230 * q) }, () => this.newFlake(true));
    }

    newStreak(anywhere) {
      const z = Math.random();
      return { x: rand(-0.25, 1) * this.W, y: anywhere ? rand(-this.H, this.H) : rand(-160, -20), z, len: 10 + z * 20, sp: 650 + z * 650 };
    }
    newFlake(anywhere) {
      const z = Math.pow(Math.random(), 1.3);
      return { x: rand(-0.05, 1.05) * this.W, y: anywhere ? rand(-this.H, this.H) : rand(-40, -6), z, r: 0.8 + z * 2.8, sp: 18 + z * 52, ph: rand(0, 6.28), amp: rand(8, 26) };
    }

    // ---------- public API ---------------------------------------------------
    setWeather(cond, night, instant) {
      if (!PALETTES[cond]) cond = 'clear';
      this.cond = cond; this.night = !!night;
      this.target = targetsFor(cond, this.night);
      if (instant) {
        Object.assign(this.w, this.target);
        this.colors = PALETTES[cond][this.night ? 'night' : 'day'].map((c) => c.slice());
      }
      if (cond === 'storm') this.nextBolt = 1400;
    }

    /** Raindrops on the "glass" part around a freshly sent bubble. rect in local px. */
    onMessageSent(r) {
      if (this.w.rain < 0.15) return;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      for (const d of this.drops) {
        const nx = clamp(d.x, r.x, r.x + r.w), ny = clamp(d.y, r.y, r.y + r.h);
        const dist = Math.hypot(d.x - nx, d.y - ny), reach = 70;
        if (dist > reach) continue;
        const k = 1 - dist / reach;
        const dir = d.x < cx ? -1 : 1;
        d.vx += dir * rand(260, 420) * k;
        d.vy += (d.y < cy ? -1 : 1) * rand(30, 90) * k;
        if (dist === 0 && d.r > 2.2) d.slide = true;
      }
    }

    /** Scroll/fling sheds snow from bubble tops. */
    onScroll(dy) {
      const strength = clamp(Math.abs(dy) / 22, 0.12, 0.85);
      for (const b of this.bubbles || []) {
        const cap = this.caps.get(b.el);
        if (cap) this.shed(cap, b, strength, Math.sign(dy));
      }
    }

    // ---------- frame --------------------------------------------------------
    frame(now) {
      const dt = this.last == null ? 16 : clamp(now - this.last, 0, 50);
      this.last = now; this.time += dt;
      const s = dt / 1000, t = this.time / 1000;

      for (const k of EFFECTS) this.w[k] = approach(this.w[k], this.target[k], 1.5, s);
      const pal = PALETTES[this.cond][this.night ? 'night' : 'day'];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) this.colors[i][j] = approach(this.colors[i][j], pal[i][j], 1.7, s);

      this.bubbles = this.getBubbles();
      const b = this.b, f = this.f, d = this.dpr;
      b.setTransform(d, 0, 0, d, 0, 0); f.setTransform(d, 0, 0, d, 0, 0);
      f.clearRect(0, 0, this.W, this.H);

      this.drawGradient(b, t);
      if (this.reduced) return;

      const w = this.w;
      if (w.clouds > 0.01) this.drawClouds(b, s, w.clouds);
      if (w.fog > 0.01) this.drawFog(b, f, s, w.fog);
      if (w.sun > 0.01) this.drawSun(b, f, s, t, w.sun);
      if (w.stars > 0.01 || w.moon > 0.01) this.drawNight(b, s, t, w.stars, w.moon);
      if (w.rain > 0.01 || this.drops.length) this.drawRain(b, f, s, w.rain);
      this.updateCaps(f, s, w.snow);
      if (w.snow > 0.01) this.drawSnow(b, f, s, t, w.snow);
      this.drawChunks(f, s);
      this.drawStorm(b, f, dt, w.storm);
    }

    // ---------- background gradient (4 moving colour points) -----------------
    drawGradient(ctx, t) {
      const { W, H } = this, c = this.colors;
      ctx.fillStyle = rgba(c[0], 1); ctx.fillRect(0, 0, W, H);
      const pts = [
        [0.18 + 0.12 * Math.sin(t * 0.13), 0.16 + 0.1 * Math.cos(t * 0.11)],
        [0.86 + 0.1 * Math.cos(t * 0.09), 0.32 + 0.12 * Math.sin(t * 0.12)],
        [0.22 + 0.12 * Math.cos(t * 0.1), 0.82 + 0.08 * Math.sin(t * 0.14)],
        [0.82 + 0.1 * Math.sin(t * 0.08), 0.88 + 0.08 * Math.cos(t * 0.1)],
      ];
      const R = Math.max(W, H) * 0.7;
      for (let i = 0; i < 4; i++) {
        const [px, py] = pts[i];
        const g = ctx.createRadialGradient(px * W, py * H, 0, px * W, py * H, R);
        g.addColorStop(0, rgba(c[i], 0.95)); g.addColorStop(1, rgba(c[i], 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
    }

    // ---------- clouds ------------------------------------------------------
    drawClouds(ctx, s, a) {
      const col = this.night ? [150, 165, 190] : [255, 255, 255];
      for (const cl of this.clouds) {
        cl.x += cl.vx * s; if (cl.x - 160 > this.W) cl.x = -160;
        for (const p of cl.puffs) {
          const x = cl.x + p.dx * cl.s, y = cl.y + p.dy * cl.s, r = p.r * cl.s;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, rgba(col, 0.42 * a)); g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
        }
      }
    }

    // ---------- fog ---------------------------------------------------------
    drawFog(b, f, s, a) {
      const col = this.night ? [150, 158, 168] : [255, 255, 255];
      for (const fg of this.fogs) {
        fg.x += fg.vx * s;
        if (fg.x - fg.r > this.W) fg.x = -fg.r; if (fg.x + fg.r < 0) fg.x = this.W + fg.r;
        const g = b.createRadialGradient(fg.x, fg.y, 0, fg.x, fg.y, fg.r);
        g.addColorStop(0, rgba(col, 0.5 * a)); g.addColorStop(1, rgba(col, 0));
        b.fillStyle = g; b.fillRect(fg.x - fg.r, fg.y - fg.r, fg.r * 2, fg.r * 2);
      }
      // a thin veil in front, only at the edges, so text stays readable
      const v = f.createLinearGradient(0, 0, 0, this.H);
      v.addColorStop(0, rgba(col, 0.22 * a)); v.addColorStop(0.18, rgba(col, 0));
      v.addColorStop(0.8, rgba(col, 0)); v.addColorStop(1, rgba(col, 0.28 * a));
      f.fillStyle = v; f.fillRect(0, 0, this.W, this.H);
    }

    // ---------- sun: glow, rays, floating motes, glare over bubbles ----------
    drawSun(b, f, s, t, a) {
      const { W, H } = this, sx = W * 0.9, sy = -H * 0.05;
      const g = b.createRadialGradient(sx, sy, 0, sx, sy, W * 1.1);
      g.addColorStop(0, `rgba(255,246,214,${0.75 * a})`); g.addColorStop(0.35, `rgba(255,226,170,${0.28 * a})`); g.addColorStop(1, 'rgba(255,220,160,0)');
      b.fillStyle = g; b.fillRect(0, 0, W, H);

      b.globalCompositeOperation = 'lighter';
      const L = H * 1.25;
      for (let i = 0; i < 9; i++) {
        const ang = Math.PI * 0.58 + i * 0.105 + 0.035 * Math.sin(t * 0.35 + i * 1.7);
        const spread = 0.022 + 0.014 * Math.sin(t * 0.5 + i);
        const x1 = sx + Math.cos(ang - spread) * L, y1 = sy + Math.sin(ang - spread) * L;
        const x2 = sx + Math.cos(ang + spread) * L, y2 = sy + Math.sin(ang + spread) * L;
        const lg = b.createLinearGradient(sx, sy, sx + Math.cos(ang) * L, sy + Math.sin(ang) * L);
        const al = (0.09 + 0.05 * Math.sin(t * 0.7 + i * 2.1)) * a;
        lg.addColorStop(0, `rgba(255,250,225,${al})`); lg.addColorStop(1, 'rgba(255,250,225,0)');
        b.fillStyle = lg; b.beginPath(); b.moveTo(sx, sy); b.lineTo(x1, y1); b.lineTo(x2, y2); b.closePath(); b.fill();
      }
      for (const m of this.motes) {
        m.y -= m.vy * s; m.x += Math.sin(t * 0.6 + m.ph) * 6 * s;
        if (m.y < -5) { m.y = H + 5; m.x = rand(0, W); }
        const al = a * 0.55 * (0.5 + 0.5 * Math.sin(t * 1.3 + m.ph));
        const mg = b.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 3);
        mg.addColorStop(0, `rgba(255,248,220,${al})`); mg.addColorStop(1, 'rgba(255,248,220,0)');
        b.fillStyle = mg; b.fillRect(m.x - m.r * 3, m.y - m.r * 3, m.r * 6, m.r * 6);
      }
      b.globalCompositeOperation = 'source-over';

      // a slow sheen of sunlight sweeps across the bubbles every 7s
      const p = (this.time % 7000) / 1700;
      if (p < 1) {
        const bx = lerp(-W * 0.4, W * 1.4, easeInOut(p));
        for (const bb of this.bubbles) {
          f.save(); f.beginPath(); f.roundRect(bb.x, bb.y, bb.w, bb.h, bb.r); f.clip();
          f.translate(bx, bb.y + bb.h / 2); f.rotate(-0.42);
          const sg = f.createLinearGradient(-55, 0, 55, 0);
          sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, `rgba(255,255,255,${0.32 * a})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
          f.fillStyle = sg; f.fillRect(-55, -400, 110, 800);
          f.restore();
        }
      }
    }

    // ---------- night: stars, moon, shooting star ----------------------------
    drawNight(ctx, s, t, sa, ma) {
      for (const st of this.stars) {
        const al = sa * (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * st.sp + st.ph)));
        ctx.fillStyle = `rgba(235,240,255,${al})`;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 6.283); ctx.fill();
      }
      if (ma > 0.01) {
        const mx = this.W * 0.76, my = this.H * 0.2, r = 20;
        const g = ctx.createRadialGradient(mx, my, r * 0.6, mx, my, r * 7);
        g.addColorStop(0, `rgba(220,230,255,${0.35 * ma})`); g.addColorStop(1, 'rgba(220,230,255,0)');
        ctx.fillStyle = g; ctx.fillRect(mx - r * 7, my - r * 7, r * 14, r * 14);
        const mg = ctx.createRadialGradient(mx - 6, my - 6, 2, mx, my, r);
        mg.addColorStop(0, `rgba(255,253,240,${ma})`); mg.addColorStop(1, `rgba(214,222,240,${ma})`);
        ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, r, 0, 6.283); ctx.fill();
        ctx.fillStyle = `rgba(160,172,200,${0.35 * ma})`;
        for (const [cx, cy, cr] of [[-6, 4, 4], [5, -5, 3], [7, 7, 2.2], [-2, -9, 1.8]]) { ctx.beginPath(); ctx.arc(mx + cx, my + cy, cr, 0, 6.283); ctx.fill(); }
      }
      // shooting star
      this.nextShoot -= s * 1000;
      if (sa > 0.6 && this.nextShoot <= 0 && !this.shoot) {
        this.shoot = { x: rand(0.2, 0.9) * this.W, y: rand(0.03, 0.25) * this.H, vx: -rand(380, 520), vy: rand(150, 220), life: 1 };
        this.nextShoot = rand(5000, 8000);
        this.onEvent && this.onEvent('shooting-star');
      }
      if (this.shoot) {
        const sh = this.shoot; sh.x += sh.vx * s; sh.y += sh.vy * s; sh.life -= s * 1.3;
        if (sh.life <= 0) this.shoot = null;
        else {
          const tx = sh.x - sh.vx * 0.16, ty = sh.y - sh.vy * 0.16;
          const lg = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
          lg.addColorStop(0, `rgba(255,255,255,${sh.life * sa})`); lg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = lg; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(tx, ty); ctx.stroke();
        }
      }
    }

    // ---------- rain: streaks, splashes on bubbles, drops on glass -----------
    drawRain(b, f, s, a) {
      const { W, H } = this, wind = 0.2 + (this.w.storm * 0.12);
      const n = Math.round(this.streaks.length * clamp(a / 1.35, 0, 1));
      const col = this.night ? [175, 195, 225] : [255, 255, 255];
      b.lineCap = 'round';
      for (let band = 0; band < 3; band++) {
        b.beginPath();
        b.strokeStyle = rgba(col, (0.16 + band * 0.12) * Math.min(a, 1));
        b.lineWidth = 0.7 + band * 0.55;
        for (let i = 0; i < n; i++) {
          const r = this.streaks[i];
          if (((r.z * 3) | 0) !== band) continue;
          const py = r.y;
          r.y += r.sp * s; r.x += r.sp * wind * s;
          if (r.z > 0.5) {
            for (const bb of this.bubbles) {
              if (py < bb.y && r.y >= bb.y && r.x > bb.x + 10 && r.x < bb.x + bb.w - 10) {
                this.splash(r.x, bb.y); Object.assign(r, this.newStreak(false)); break;
              }
            }
          }
          if (r.y - r.len > H || r.x > W + 40) Object.assign(r, this.newStreak(false));
          b.moveTo(r.x, r.y); b.lineTo(r.x - r.len * wind, r.y - r.len);
        }
        b.stroke();
      }

      // splashes (foreground, sitting on bubble edges)
      f.fillStyle = rgba(col, 0.8);
      for (let i = this.splashes.length - 1; i >= 0; i--) {
        const p = this.splashes[i];
        p.vy += 900 * s; p.x += p.vx * s; p.y += p.vy * s; p.life -= s * 2.6;
        if (p.life <= 0) { this.splashes.splice(i, 1); continue; }
        f.globalAlpha = p.life; f.beginPath(); f.arc(p.x, p.y, p.r, 0, 6.283); f.fill();
      }
      f.globalAlpha = 1;

      this.updateDrops(b, s, a);
    }

    splash(x, y) {
      if (this.splashes.length > 160) return;
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) this.splashes.push({ x, y: y - 1, vx: rand(-70, 70), vy: rand(-170, -70), r: rand(0.6, 1.3), life: 1 });
    }

    updateDrops(ctx, s, a) {
      const { W, H } = this, drops = this.drops;
      // spawn
      const max = Math.round(140 * this.quality * clamp(a, 0, 1));
      if (drops.length < max && Math.random() < s * 26 * a) {
        drops.push({ x: rand(0, W), y: rand(0, H * 0.95), r: rand(2, 3.8), grow: rand(0.35, 1), vx: 0, vy: 0, slide: false, life: 1, trail: false });
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (a < 0.2) d.life -= s * 0.8;                       // evaporate when rain stops
        if (d.trail) d.life -= s * 0.35;
        if (!d.slide && !d.trail) d.r = Math.min(d.r + d.grow * s * a, 6.5);
        if (!d.slide && !d.trail && d.r > 5.2 && Math.random() < s * 0.6) d.slide = true;
        if (d.slide) {
          d.vy = Math.min(d.vy + 260 * s, 150);
          d.vx += Math.sin(this.time / 140 + i) * 20 * s;
          if (Math.random() < s * 9) drops.push({ x: d.x, y: d.y - d.r, r: rand(0.6, 1.2), grow: 0, vx: 0, vy: 0, slide: false, life: 1, trail: true });
          // absorb drops in the path
          for (let j = drops.length - 1; j >= 0; j--) {
            const o = drops[j];
            if (o === d || o.slide || o.trail) continue;
            if (Math.abs(o.x - d.x) < d.r + o.r && Math.abs(o.y - d.y) < d.r + o.r) {
              d.r = Math.min(Math.sqrt(d.r * d.r + o.r * o.r * 0.5), 6); drops.splice(j, 1); if (j < i) i--;
            }
          }
        } else {
          d.vy = approach(d.vy, 0, 5, s);
        }
        d.vx = approach(d.vx, 0, 4.5, s);
        d.x += d.vx * s; d.y += d.vy * s;
        if (d.y - d.r > H || d.life <= 0 || d.x < -10 || d.x > W + 10) { drops.splice(i, 1); continue; }
        this.drawDrop(ctx, d.x, d.y, d.r, d.life * clamp(a * 1.2, 0.25, 1));
      }
    }

    drawDrop(ctx, x, y, r, al) {
      const ry = r * 1.08;
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, ry);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * al})`);
      g.addColorStop(0.55, `rgba(255,255,255,${0.1 * al})`);
      g.addColorStop(1, `rgba(10,25,45,${0.45 * al})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r, ry, 0, 0, 6.283); ctx.fill();
      if (r > 1.6) {
        ctx.strokeStyle = `rgba(255,255,255,${0.45 * al})`; ctx.lineWidth = r * 0.22;
        ctx.beginPath(); ctx.arc(x, y + r * 0.05, r * 0.68, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${0.85 * al})`;
        ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.42, r * 0.2, 0, 6.283); ctx.fill();
      }
    }

    // ---------- snow: flakes + caps that pile on bubbles ---------------------
    capFor(bb) {
      let cap = this.caps.get(bb.el);
      const n = Math.max(2, Math.ceil(bb.w / COL) + 1);
      if (!cap || cap.n !== n) {
        const next = { n, cols: new Float32Array(n), noise: Float32Array.from({ length: n }, () => rand(0.6, 1.3)) };
        if (cap) for (let j = 0; j < n; j++) {         // keep the snow: resample the old height map to the new width
          const u = (j / (n - 1)) * (cap.n - 1), i0 = Math.floor(u), i1 = Math.min(cap.n - 1, i0 + 1), f = u - i0;
          next.cols[j] = cap.cols[i0] * (1 - f) + cap.cols[i1] * f;
          next.noise[j] = cap.noise[Math.min(cap.n - 1, Math.round(u))];
        }
        cap = next; this.caps.set(bb.el, cap);
      }
      return cap;
    }
    envelope(lx, w, r) { return smooth(r * 0.15, r * 1.05, lx) * smooth(r * 0.15, r * 1.05, w - lx); }
    baseY(bb, lx) {
      const r = bb.r, w = bb.w;
      if (lx < r) { const dx = r - lx; return bb.y + r - Math.sqrt(Math.max(0, r * r - dx * dx)); }
      if (lx > w - r) { const dx = lx - (w - r); return bb.y + r - Math.sqrt(Math.max(0, r * r - dx * dx)); }
      return bb.y;
    }
    addSnow(bb, x, amount) {
      const cap = this.capFor(bb), i = Math.round((x - bb.x) / COL);
      for (let j = i - 3; j <= i + 3; j++) {
        if (j < 0 || j >= cap.n) continue;
        const lim = CAP_MAX * this.envelope(j * COL, bb.w, bb.r);
        cap.cols[j] = Math.min(lim, cap.cols[j] + amount * Math.exp(-((j - i) * (j - i)) / 4));
      }
    }
    shed(cap, bb, strength, dir) {
      for (let j = 0; j < cap.n; j += 2) {
        const amt = cap.cols[j] * strength;
        if (amt > 0.5 && this.chunks.length < 600) {
          const lx = j * COL;
          this.chunks.push({ x: bb.x + lx, y: this.baseY(bb, lx) - cap.cols[j] * 0.5, vx: rand(-45, 45), vy: rand(-90, 10) - dir * 40, r: clamp(amt * 0.45, 0.8, 2.6), life: 1 });
        }
        cap.cols[j] -= amt; if (j + 1 < cap.n) cap.cols[j + 1] -= cap.cols[j + 1] * strength;
      }
    }

    updateCaps(f, s, a) {
      const melt = a < 0.35 ? (this.w.rain > 0.2 ? 1.6 : 0.5) : 0;
      for (const bb of this.bubbles) {
        const cap = (this.caps.has(bb.el) || a > 0.05) ? this.capFor(bb) : null;
        if (!cap) continue;
        const c = cap.cols; let max = 0;
        for (let j = 0; j < cap.n; j++) {
          if (a > 0.05) {
            const lim = CAP_MAX * this.envelope(j * COL, bb.w, bb.r);
            c[j] = Math.min(lim, c[j] + s * 1.1 * a * cap.noise[j]);
          }
          if (melt) c[j] *= Math.exp(-melt * s);
        }
        for (let j = 1; j < cap.n - 1; j++) c[j] = c[j] * 0.94 + (c[j - 1] + c[j + 1]) * 0.03;
        for (let j = 0; j < cap.n; j++) if (c[j] > max) max = c[j];
        if (max < 0.35 || bb.y < -20 || bb.y > this.H + 20) continue;
        this.drawCap(f, bb, cap);
      }
    }

    drawCap(f, bb, cap) {
      const c = cap.cols;
      f.save();
      f.shadowColor = this.night ? 'rgba(0,0,0,0.35)' : 'rgba(30,60,100,0.22)';
      f.shadowBlur = 5; f.shadowOffsetY = 1.5;
      const g = f.createLinearGradient(0, bb.y - CAP_MAX, 0, bb.y + 4);
      g.addColorStop(0, this.night ? '#f2f6ff' : '#ffffff'); g.addColorStop(1, this.night ? '#c7d3ea' : '#dde8f5');
      f.fillStyle = g;
      f.beginPath();
      for (let j = 0; j < cap.n; j++) {
        const lx = Math.min(j * COL, bb.w), px = bb.x + lx, py = this.baseY(bb, lx) - c[j];
        if (j === 0) f.moveTo(px, py);
        else { const plx = Math.min((j - 1) * COL, bb.w); const qx = bb.x + (plx + lx) / 2; const qy = (this.baseY(bb, plx) - c[j - 1] + py) / 2; f.quadraticCurveTo(bb.x + plx, this.baseY(bb, plx) - c[j - 1], qx, qy); }
      }
      for (let j = cap.n - 1; j >= 0; j--) { const lx = Math.min(j * COL, bb.w); f.lineTo(bb.x + lx, this.baseY(bb, lx) + 0.5); }
      f.closePath(); f.fill();
      f.shadowColor = 'transparent';
      // a fine edge on the top surface only, fading where the cap is thin
      f.lineWidth = 0.7; f.lineJoin = 'round';
      for (let j = 1; j < cap.n; j++) {
        const h = Math.min(c[j], c[j - 1]); if (h < 1.2) continue;
        const l0 = Math.min((j - 1) * COL, bb.w), l1 = Math.min(j * COL, bb.w);
        f.strokeStyle = (this.night ? 'rgba(170,190,230,' : 'rgba(120,150,195,') + Math.min(0.4, (h - 1.2) * 0.2) + ')';
        f.beginPath(); f.moveTo(bb.x + l0, this.baseY(bb, l0) - c[j - 1]); f.lineTo(bb.x + l1, this.baseY(bb, l1) - c[j]); f.stroke();
      }
      f.restore();
    }

    drawSnow(b, f, s, t, a) {
      const n = Math.round(this.flakes.length * clamp(a, 0, 1));
      const wind = 10 * Math.sin(t * 0.25);
      for (let i = 0; i < n; i++) {
        const k = this.flakes[i];
        const py = k.y;
        k.y += k.sp * s; k.x += (Math.sin(t * 0.9 + k.ph) * k.amp * 0.6 + wind) * s;
        if (k.z > 0.3 && k.z < 0.8) {
          for (const bb of this.bubbles) {
            if (py < bb.y && k.y >= bb.y - 1 && k.x > bb.x + 4 && k.x < bb.x + bb.w - 4) {
              this.addSnow(bb, k.x, 0.55 + k.r * 0.25); Object.assign(k, this.newFlake(false)); break;
            }
          }
        }
        if (k.y > this.H + 10) Object.assign(k, this.newFlake(false));
        const near = k.z > 0.82, ctx = near ? f : b;
        const al = a * (near ? 0.7 : 0.45 + 0.5 * k.z);
        if (near) {
          const g = ctx.createRadialGradient(k.x, k.y, 0, k.x, k.y, k.r * 1.6);
          g.addColorStop(0, `rgba(255,255,255,${al})`); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(k.x, k.y, k.r * 1.6, 0, 6.283); ctx.fill();
        } else {
          ctx.fillStyle = `rgba(255,255,255,${al})`;
          ctx.beginPath(); ctx.arc(k.x, k.y, k.r, 0, 6.283); ctx.fill();
        }
      }
    }

    drawChunks(f, s) {
      if (!this.chunks.length) return;
      f.fillStyle = this.night ? '#e9effc' : '#ffffff';
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        const p = this.chunks[i];
        p.vy += 760 * s; p.vx *= 0.99; p.x += p.vx * s; p.y += p.vy * s;
        if (p.y > this.H + 10) { this.chunks.splice(i, 1); continue; }
        f.beginPath(); f.arc(p.x, p.y, p.r, 0, 6.283); f.fill();
      }
    }

    // ---------- storm: lightning ---------------------------------------------
    drawStorm(b, f, dt, a) {
      if (a > 0.5) {
        this.nextBolt -= dt;
        if (this.nextBolt <= 0) {
          this.flash = 1; this.pendingFlash = 130; this.bolt = this.makeBolt(); this.nextBolt = rand(3800, 6500);
          this.onEvent && this.onEvent('lightning');
        }
      }
      if (this.pendingFlash > 0) { this.pendingFlash -= dt; if (this.pendingFlash <= 0) this.flash = Math.max(this.flash, 0.75); }
      if (this.flash <= 0.01) return;
      if (this.bolt && this.flash > 0.3) {
        b.save(); b.strokeStyle = `rgba(240,245,255,${this.flash})`; b.lineWidth = 2.2;
        b.shadowColor = 'rgba(190,210,255,0.9)'; b.shadowBlur = 14; b.lineJoin = 'round';
        b.beginPath(); this.bolt.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y))); b.stroke(); b.restore();
      }
      b.fillStyle = `rgba(225,232,255,${0.5 * this.flash})`; b.fillRect(0, 0, this.W, this.H);
      f.fillStyle = `rgba(225,232,255,${0.1 * this.flash})`; f.fillRect(0, 0, this.W, this.H);
      this.flash = Math.max(0, this.flash - dt / 260);
    }
    makeBolt() {
      let x = rand(0.25, 0.8) * this.W, y = -10; const pts = [[x, y]];
      while (y < this.H * 0.55) { y += rand(18, 42); x += rand(-26, 26); pts.push([x, y]); }
      return pts;
    }
  }

  TW.WeatherLayer = WeatherLayer;
  TW.PALETTES = PALETTES;
  TW.targetsFor = targetsFor;
})(typeof window !== 'undefined' ? window : globalThis);
