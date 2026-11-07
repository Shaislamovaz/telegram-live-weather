/*!
 * Telegram Live Weather — demo app (chat UI, settings sheet, scripted demo)
 * Every animation runs on one clock, so the demo can be rendered frame-by-frame
 * for a perfectly smooth video (?record) or live in the browser.
 * MIT License
 */
(function () {
  'use strict';
  const TW = window.TgWeather;
  const Q = new URLSearchParams(location.search);
  const RECORD = Q.has('record');
  if (RECORD) { // deterministic randomness, so the video and the sound timeline always match
    let seed = 20261107;
    Math.random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  }
  const events = (window.__events = []); // timeline for sound design (record mode)
  const log = (type, data) => events.push(Object.assign({ t: Math.round(clock.now), type }, data));
  const $ = (s) => document.querySelector(s);
  const screen = $('#screen'), chat = $('#chat'), msgs = $('#msgs');
  const bgC = $('#wx-bg'), fgC = $('#wx-fg'), sheet = $('#sheet'), backdrop = $('#backdrop');
  const input = $('#input'), sendBtn = $('#send'), pill = $('#pill'), touch = $('#touch');

  const setMode = () => document.body.classList.toggle('full', !RECORD && innerWidth < 520);
  document.body.classList.toggle('record', RECORD); setMode();

  // ---------- one clock for everything --------------------------------------
  const clock = { now: 0 };
  const tweens = [], timers = [];
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeBack = (t) => { const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  function tween(dur, fn, o = {}) { tweens.push({ start: clock.now + (o.delay || 0), dur, fn, ease: o.ease || easeOut, done: o.done }); }
  function after(ms, fn) { timers.push({ at: clock.now + ms, fn }); }
  function step() {
    for (let i = 0; i < timers.length; i++) if (timers[i].at <= clock.now) { const t = timers.splice(i--, 1)[0]; t.fn(); }
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i]; if (clock.now < tw.start) continue;
      const p = Math.min(1, (clock.now - tw.start) / tw.dur); tw.fn(tw.ease(p), p);
      if (p >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
    }
  }

  // ---------- icons ----------------------------------------------------------
  const C = 'M7 15h10a3.6 3.6 0 0 0 .5-7.2A5.5 5.5 0 0 0 6.6 8.6 3.2 3.2 0 0 0 7 15z';
  const P = {
    clear: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M5.4 18.6l1.5-1.5M17.1 6.9l1.5-1.5"/>',
    moon: '<path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z"/>',
    cloudy: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 11 3.5 3.5 0 0 0 7 18z"/>',
    rain: `<path d="${C}"/><path d="M8.5 18.2 7.6 20.6M12.5 18.2l-.9 2.4M16.5 18.2l-.9 2.4"/>`,
    storm: `<path d="${C}"/><path d="m12.6 15.5-2.1 3.2h3l-2 3"/>`,
    snow: `<path d="${C}"/><path d="M8.5 19h.01M12 18.3h.01M15.5 19h.01M10.2 21.4h.01M13.8 21.4h.01"/>`,
    fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
    off: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m4 15 4.5-4.5 4 4 2.5-2.5L20 17"/>',
  };
  const icon = (k) => `<svg class="wx" viewBox="0 0 24 24">${P[k]}</svg>`;
  document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
  const CHECKS = '<svg viewBox="0 0 16 11"><path d="M1 6l3 3 6-7M6.5 9l1 .8L14 2"/></svg>';
  const SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

  // ---------- data -----------------------------------------------------------
  const LABEL = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Storm', snow: 'Snow', fog: 'Fog' };
  const TEMP = { clear: 14, cloudy: 9, rain: 7, storm: 12, snow: -3, fog: 3 };
  const PLACES = {
    mine: { city: 'Tashkent', lat: 41.31, lon: 69.28, cond: 'clear', night: false, temp: 14 },
    peer: { city: 'Almaty', lat: 43.24, lon: 76.89, cond: 'snow', night: false, temp: -3 },
  };
  const state = { source: 'mine', preview: null, night: null };
  const fmtT = (t) => (t > 0 ? '+' : t < 0 ? '−' : '') + Math.abs(t) + '°';

  // ---------- weather engine -------------------------------------------------
  let W = screen.clientWidth, H = screen.clientHeight;
  function getBubbles() {
    const cr = bgC.getBoundingClientRect(), sc = cr.width / W || 1, out = [];
    for (const el of msgs.querySelectorAll('.bubble')) {
      const r = el.getBoundingClientRect(), y = (r.top - cr.top) / sc, h = r.height / sc;
      if (y > H + 40 || y + h < -40) continue;
      out.push({ el, x: (r.left - cr.left) / sc, y, w: r.width / sc, h, r: 18 });
    }
    return out;
  }
  const engine = new TW.WeatherLayer({
    background: bgC, foreground: fgC, getBubbles, width: W, height: H,
    dpr: RECORD ? +(Q.get('dpr') || 2) : Math.min(devicePixelRatio || 1, 2),
    onEvent: (type) => log(type),
    quality: RECORD ? 1 : ((navigator.hardwareConcurrency || 8) <= 4 ? 0.6 : 1),
    reducedMotion: !RECORD && matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  addEventListener('resize', () => {
    setMode();
    const w = screen.clientWidth, h = screen.clientHeight;
    if (w !== W || h !== H) { W = w; H = h; engine.resize(W, H); }
  });

  // ---------- theme (day/night) ---------------------------------------------
  let themeN = 0;
  function setTheme(night, instant) {
    const from = themeN, to = night ? 1 : 0;
    if (instant) { themeN = to; screen.style.setProperty('--n', to); return; }
    if (from === to) return;
    tween(700, (e) => { themeN = from + (to - from) * e; screen.style.setProperty('--n', themeN.toFixed(3)); }, { ease: easeInOut });
  }

  function effective() {
    if (state.source === 'off') return { cond: 'none', night: !!state.night };
    const p = PLACES[state.source];
    return { cond: state.preview || p.cond, night: state.night == null ? p.night : state.night, place: p };
  }

  function apply(instant) {
    const e = effective();
    engine.setWeather(e.cond, e.night, instant);
    log('weather', { cond: e.cond, night: e.night });
    setTheme(e.night, instant);
    // header
    if (e.cond === 'none') { pill.classList.remove('on'); $('#pillIco').innerHTML = ''; $('#pillText').textContent = 'online'; }
    else {
      const temp = state.preview ? TEMP[e.cond] : e.place.temp;
      pill.classList.add('on');
      $('#pillIco').innerHTML = icon(e.cond === 'clear' && e.night ? 'moon' : e.cond);
      $('#pillText').textContent = `${e.place.city} · ${fmtT(temp)}`;
    }
    // sheet state
    document.querySelectorAll('[data-source]').forEach((r) => r.classList.toggle('sel', r.dataset.source === state.source));
    document.querySelectorAll('[data-cond]').forEach((c) => c.classList.toggle('sel', c.dataset.cond === (state.source === 'off' ? '' : e.cond)));
    const sw = $('#nightSw'); sw.classList.toggle('on', e.night);
    tween(220, (v) => sw.style.setProperty('--sw', e.night ? v : 1 - v));
    for (const k of ['mine', 'peer']) {
      const p = PLACES[k];
      $(k === 'mine' ? '#icoMine' : '#icoPeer').innerHTML = icon(p.cond === 'clear' && p.night ? 'moon' : p.cond);
      $(k === 'mine' ? '#subMine' : '#subPeer').textContent = `${p.city} · ${LABEL[p.cond]}, ${fmtT(p.temp)}${k === 'peer' ? ' · shared by Mom' : ''}`;
    }
  }
  const setSource = (s) => { state.source = s; state.preview = null; apply(); };
  const setPreview = (c) => { if (state.source === 'off') state.source = 'mine'; state.preview = c; apply(); };
  const toggleNight = () => { state.night = !effective().night; apply(); };

  // chips
  $('#chips').innerHTML = Object.keys(LABEL).map((k) => `<button class="chip" data-cond="${k}">${icon(k)}${LABEL[k]}</button>`).join('');

  // ---------- messages -------------------------------------------------------
  let minute = 41;
  const time = () => `9:${String(minute).padStart(2, '0')}`;
  let lastTop = 0, ignoreScroll = false;
  function setScroll(v) {
    v = Math.max(0, Math.min(v, chat.scrollHeight - chat.clientHeight));
    if (Math.round(v) !== Math.round(chat.scrollTop)) ignoreScroll = true;
    chat.scrollTop = v; lastTop = chat.scrollTop;
  }
  chat.addEventListener('scroll', () => {
    const dy = chat.scrollTop - lastTop; lastTop = chat.scrollTop;
    if (ignoreScroll || RECORD) { ignoreScroll = false; return; }
    engine.onScroll(dy);
  }, { passive: true });

  function addMessage(text, out, animate = true) {
    const m = document.createElement('div');
    m.className = 'msg ' + (out ? 'out' : 'in');
    m.innerHTML = `<div class="bubble"><span class="txt"></span><span class="meta">${time()}${out ? CHECKS : ''}</span></div>`;
    m.querySelector('.txt').textContent = text;
    msgs.appendChild(m);
    if (!animate) return m;
    log(out ? 'send' : 'receive');
    const h = m.offsetHeight, bub = m.firstChild;
    setScroll(chat.scrollHeight);
    bub.style.transformOrigin = out ? '100% 100%' : '0% 100%';
    bub.style.opacity = 0;
    tween(360, (e) => (msgs.style.transform = `translateY(${((1 - e) * h).toFixed(2)}px)`));
    tween(440, (e) => { bub.style.transform = `scale(${(0.55 + 0.45 * e).toFixed(4)})`; bub.style.opacity = Math.min(1, e * 1.7); }, {
      ease: easeBack, done: () => { bub.style.transform = ''; },
    });
    after(200, () => { const b = getBubbles().find((x) => x.el === bub); if (b) engine.onMessageSent(b); });
    return m;
  }

  [
    ['Good morning, sweetheart', 0], ['Morning! How is Almaty?', 1], ['Cold, but sunny so far', 0],
    ['Here it is +14 and the trees are still green', 1], ['Lucky you. Did you have breakfast?', 0], ['Yes, mom', 1],
    ['Did you call grandma?', 0], ['Calling her tonight', 1], ['Good. Dress warmly, the evenings are cold now', 0],
    ['I will', 1], ['When are you coming to visit?', 0], ['Maybe in December', 1],
  ].forEach(([t, o]) => addMessage(t, !!o, false));

  function send() {
    const v = input.value.trim(); if (!v) return;
    minute = Math.min(59, minute + 1);
    addMessage(v, true); input.value = ''; updateSend();
  }
  function updateSend() { const r = !!input.value.trim(); sendBtn.classList.toggle('ready', r); sendBtn.innerHTML = r ? SEND : MIC; }
  input.addEventListener('input', updateSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  sendBtn.addEventListener('click', send);
  updateSend();

  // ---------- sheet ----------------------------------------------------------
  let sheetOpen = false;
  function openSheet() {
    if (sheetOpen) return; sheetOpen = true; backdrop.classList.add('open'); log('sheet-open');
    tween(420, (e) => { sheet.style.transform = `translateY(${(1 - e) * 105}%)`; backdrop.style.opacity = e; }, { ease: easeOut });
  }
  function closeSheet() {
    if (!sheetOpen) return; sheetOpen = false; backdrop.classList.remove('open'); log('sheet-close');
    tween(320, (e) => { sheet.style.transform = `translateY(${e * 105}%)`; backdrop.style.opacity = 1 - e; }, { ease: easeInOut });
  }
  pill.addEventListener('click', openSheet);
  backdrop.addEventListener('click', closeSheet);
  document.querySelectorAll('[data-source]').forEach((r) => r.addEventListener('click', () => setSource(r.dataset.source)));
  $('#chips').addEventListener('click', (e) => { const c = e.target.closest('[data-cond]'); if (c) setPreview(c.dataset.cond); });
  $('#nightSw').addEventListener('click', toggleNight);

  // ---------- scripted demo (used for the video and the ▶ button) ----------
  const local = (el) => {
    const sr = screen.getBoundingClientRect(), r = el.getBoundingClientRect(), sc = sr.width / W || 1;
    return [(r.left + r.width / 2 - sr.left) / sc, (r.top + r.height / 2 - sr.top) / sc];
  };
  function showTouch(x, y) { touch.style.left = x + 'px'; touch.style.top = y + 'px'; tween(140, (e) => { touch.style.opacity = e; touch.style.transform = `scale(${0.6 + 0.4 * e})`; }); }
  function hideTouch() { tween(260, (e) => { touch.style.opacity = 1 - e; touch.style.transform = `scale(${1 + 0.25 * e})`; }); }
  function tap(el, fn) { const [x, y] = local(el); showTouch(x, y); log('tap'); after(170, () => { fn && fn(); hideTouch(); }); }
  function typeAndSend(text, dur) {
    tap(input);
    tween(dur, (e, p) => { const v = text.slice(0, Math.round(p * text.length)); if (v.length > input.value.length) log('key'); input.value = v; updateSend(); }, { ease: (t) => t, delay: 250 });
    after(dur + 550, () => tap(sendBtn, send));
  }
  function scrollShake() {
    const start = chat.scrollTop, dist = 170;
    let prev = start;
    const [x, y] = [W * 0.58, H * 0.42];
    showTouch(x, y); log('scroll');
    const move = (to) => (e) => {
      const v = to(e); setScroll(v); engine.onScroll(v - prev); prev = v;
      touch.style.top = (y + (start - v)) + 'px';
    };
    tween(380, move((e) => start - dist * e), { ease: easeInOut, done: () => tween(320, move((e) => start - dist * (1 - e)), { ease: easeInOut, done: hideTouch }) });
  }
  function pick(cond, night) {
    tap(pill, openSheet);
    after(950, () => {
      const el = cond ? document.querySelector(`[data-cond="${cond}"]`) : $('#nightSw');
      tap(el, () => { if (cond) setPreview(cond); if (night != null) { state.night = night; apply(); } });
    });
    after(1600, closeSheet);
  }
  let demoRunning = false;
  function runDemo() {
    if (demoRunning) return; demoRunning = true;
    tweens.length = 0; timers.length = 0; closeSheet();
    Object.assign(PLACES.peer, { cond: 'snow', night: false, temp: -3 }); // the story of the demo
    state.source = 'off'; state.preview = null; state.night = false; apply(true);
    setScroll(chat.scrollHeight);
    const at = after;
    at(900, () => { minute++; addMessage('Wait… first snow just started!', false); });
    at(2400, () => tap(pill, openSheet));
    at(3500, () => tap(document.querySelector('[data-source="peer"]'), () => { state.night = null; setSource('peer'); after(500, closeSheet); }));
    at(6400, () => typeAndSend('Send me a photo!', 1000));
    at(9300, () => { minute++; addMessage('Everything is turning white', false); });
    at(11800, scrollShake);
    at(14000, () => pick('rain'));
    at(16400, () => typeAndSend('Here it is raining instead', 1200));
    at(19600, () => pick('storm'));
    at(25000, () => pick('fog'));
    at(28800, () => { pick('clear'); after(1700, () => pick(null, true)); });
    at(36500, () => pick('snow'));
    at(42500, () => { tap(pill, openSheet); after(950, () => tap(document.querySelector('[data-cond="clear"]'), () => { state.night = false; setPreview('clear'); })); after(1600, closeSheet); });
    at(48000, () => { demoRunning = false; });
  }
  $('#playBtn').addEventListener('click', runDemo);

  // ---------- real weather ---------------------------------------------------
  async function loadReal() {
    for (const k of ['mine', 'peer']) {
      try { Object.assign(PLACES[k], await TW.provider.fetchCurrent(PLACES[k].lat, PLACES[k].lon)); PLACES[k].cond = PLACES[k].condition; PLACES[k].night = PLACES[k].isNight; }
      catch (e) { /* offline or blocked: keep demo data */ }
    }
    if (!demoRunning) apply();
  }

  // ---------- run ------------------------------------------------------------
  function render(now) { clock.now = now; step(); engine.frame(now); }
  setScroll(chat.scrollHeight);
  if (RECORD) {
    window.__render = render;
    render(0); runDemo();
    window.__ready = true;
  } else {
    apply(true);
    loadReal();
    const loop = (ts) => { if (!document.hidden) render(ts); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
})();
