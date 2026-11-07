"""Procedural sound design for the demo video — every sound is synthesized here, no samples.

Reads demo/build/events.json (timeline logged by the demo in record mode) and writes
demo/build/soundtrack.wav (48 kHz stereo):
  • ambient music bed (pad + soft plucks, D major)
  • weather ambience that crossfades with the visuals: wind (snow), rain + drops,
    storm + thunder, fog air, crickets (clear night), birds (clear day)
  • UI sounds: taps, typing, send / receive, sheet open / close, weather-change shimmer,
    snow falling off, splash when sending in rain
usage: python3 tools/sound.py [--seconds 48]
"""
import argparse, json, pathlib, wave
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

ROOT = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser(); ap.add_argument('--seconds', type=float, default=48)
ap.add_argument('--lead', type=float, default=0, help='title card before the demo, s')
ap.add_argument('--tail', type=float, default=0, help='outro card after the demo, s')
ap.add_argument('--out', default='demo/build/soundtrack.wav')
a = ap.parse_args()
DEMO = a.seconds; a.seconds = a.lead + DEMO + a.tail
SR = 48000
N = int(a.seconds * SR)
rng = np.random.default_rng(7)
t = np.arange(N) / SR
db = lambda x: 10 ** (x / 20)

def bp(x, lo, hi, order=2): return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)
def env(n, att, dec):
    k = np.arange(n) / SR
    return np.minimum(1, k / max(att, 1e-4)) * np.exp(-k / dec)
def pink(n):
    w = rng.standard_normal(n); f = np.fft.rfft(w); s = np.arange(len(f)); s[0] = 1
    return np.fft.irfft(f / np.sqrt(s), n) * 30
def put(buf, start_s, x, gain=1.0, pan=0.0):
    i = int(start_s * SR)
    if i >= N: return
    x = x[: N - i]
    buf[0, i:i + len(x)] += x * gain * (1 - pan) ** .5 * 1.0
    buf[1, i:i + len(x)] += x * gain * (1 + pan) ** .5 * 1.0
def note(f, dur, decay, harm=(1, .35, .12), att=.005):
    n = int(dur * SR); k = np.arange(n) / SR
    s = sum(h * np.sin(2 * np.pi * f * (i + 1) * k) for i, h in enumerate(harm))
    return s * env(n, att, decay)
midi = lambda m: 440 * 2 ** ((m - 69) / 12)

events = json.loads((ROOT / 'demo/build/events.json').read_text())
for e in events: e['t'] += a.lead * 1000
music, amb, sfx = (np.zeros((2, N)) for _ in range(3))

# ---------------------------------------------------------------- music bed
BPM = 72; beat = 60 / BPM; bar = beat * 4
CHORDS = [[50, 62, 66, 69, 73, 76], [47, 59, 62, 66, 69, 73], [43, 55, 59, 62, 66, 69], [45, 57, 59, 64, 66, 71]]  # Dmaj9 Bm9 Gmaj9 A6/9sus
nbars = int(a.seconds / bar) + 2
for b in range(nbars):
    ch = CHORDS[b % 4]; st = b * bar
    for j, m in enumerate(ch):                                   # pad
        n = int((bar + 1.6) * SR); k = np.arange(n) / SR
        f = midi(m)
        tone = sum(np.sin(2 * np.pi * f * d * k + rng.uniform(0, 6)) for d in (0.997, 1.0, 1.003)) / 3
        tone += .18 * np.sin(2 * np.pi * 2 * f * k)
        shape = np.minimum(1, k / 1.3) * np.minimum(1, np.maximum(0, (bar + 1.6 - k) / 1.6))
        put(music, st, tone * shape, .028 if m > 52 else .05, pan=(j / len(ch) - .5) * .6)
    for i in range(8):                                           # soft plucks (8ths, sparse)
        if rng.random() < .55: continue
        m = ch[2 + (i * 3 + b) % (len(ch) - 2)] + 12
        put(music, st + i * beat / 2, note(midi(m), 1.6, .55, (1, .25, .06), .004), .05, pan=rng.uniform(-.5, .5))
music = lp(music, 5200)

# section dynamics: duck in storm, airy at night
gm = np.ones(N)
def seg(t0, t1, g, fade=1.2):
    x = np.clip((t - t0) / fade, 0, 1) * np.clip((t1 - t) / fade, 0, 1)
    return 1 + (g - 1) * x

# ---------------------------------------------------------------- weather timeline
wx = [(e['t'] / 1000, e['cond'], e.get('night', False)) for e in events if e['type'] == 'weather']
def key(c, n): return {'none': None, 'clear': 'night' if n else 'sun', 'cloudy': 'fog'}.get(c, c)
layers = {k: np.zeros(N) for k in ('snow', 'rain', 'storm', 'fog', 'sun', 'night')}
ctl = 100  # control rate
nc = int(a.seconds * ctl)
targets = {k: np.zeros(nc) for k in layers}
for i, (t0, c, n) in enumerate(wx):
    t1 = wx[i + 1][0] if i + 1 < len(wx) else a.seconds
    k = key(c, n)
    if k: targets[k][int(t0 * ctl):int(t1 * ctl)] = 1
    if k == 'storm': targets['rain'][int(t0 * ctl):int(t1 * ctl)] = 1
for k in layers:                                                  # smooth like the visuals (~1.3 s)
    g = np.zeros(nc); v = 0
    for i in range(nc): v += (targets[k][i] - v) * (1 - np.exp(-1.5 / ctl)); g[i] = v
    layers[k] = np.interp(t, np.arange(nc) / ctl, g)

storm_on = layers['storm']; night_on = layers['night'] + .6 * layers['snow'] * 0
gm *= 1 - .45 * storm_on
for c in range(2):
    # snow → wind
    w = bp(pink(N), 220, 1100); lfo = .55 + .45 * np.sin(2 * np.pi * .13 * t + c) * np.sin(2 * np.pi * .047 * t + 1)
    amb[c] += w * lfo * layers['snow'] * db(-31)
    # rain → hiss + drops
    r = bp(rng.standard_normal(N), 900, 9000) * db(-34) * (1 + .5 * storm_on)
    drops = np.zeros(N); idx = rng.integers(0, N, int(a.seconds * 55))
    drops[idx] = rng.uniform(.2, 1, len(idx)) * rng.choice([-1, 1], len(idx))
    drops = bp(drops, 2200, 7000) * db(-14)
    amb[c] += (r + drops) * layers['rain']
    # storm → low rumble bed
    amb[c] += lp(rng.standard_normal(N), 140, 4) * db(-22) * storm_on
    # fog → soft air
    amb[c] += lp(pink(N), 450) * (.6 + .4 * np.sin(2 * np.pi * .09 * t + c)) * db(-33) * layers['fog']
# clear night → crickets
cr = np.zeros(N); s0 = 0.0
while s0 < a.seconds:
    for p in range(3):
        n = int(.045 * SR); k = np.arange(n) / SR
        c = np.sin(2 * np.pi * 4700 * k) * np.sin(np.pi * k / .045) ** 2 * (.5 + .5 * np.sign(np.sin(2 * np.pi * 70 * k)))
        i = int((s0 + p * .07) * SR)
        if i + n < N: cr[i:i + n] += c
    s0 += rng.uniform(.75, 1.15)
for c, d in ((0, 0), (1, int(.23 * SR))):
    amb[c] += np.roll(cr, d) * db(-37) * layers['night']
# clear day → birds
bd = np.zeros((2, N)); s0 = 0.5
while s0 < a.seconds:
    pan = rng.uniform(-.7, .7); f0 = rng.uniform(2600, 3600)
    for p in range(rng.integers(2, 5)):
        n = int(.07 * SR); k = np.arange(n) / SR
        f = f0 + 1600 * np.sin(np.pi * k / .07) * rng.uniform(.6, 1)
        ch = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * k / .07) ** 2
        put(bd, s0 + p * .095, ch, 1, pan)
    s0 += rng.uniform(1.6, 3.2)
amb += bd * db(-33) * layers['sun']

# ---------------------------------------------------------------- UI sounds
def click():
    n = int(.03 * SR); k = np.arange(n) / SR
    return np.sin(2 * np.pi * 1900 * k) * np.exp(-k / .006) + hp(rng.standard_normal(n), 3000) * np.exp(-k / .0015) * .4
def keytick():
    n = int(.02 * SR); k = np.arange(n) / SR
    return bp(rng.standard_normal(n), 2500, rng.uniform(4500, 6500)) * np.exp(-k / .004)
def swoosh(f0, f1, dur, noise=.3):
    n = int(dur * SR); k = np.arange(n) / SR
    f = f0 * (f1 / f0) ** (k / dur)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * np.minimum(1, k / dur)) ** 1.5
    return s + bp(rng.standard_normal(n), 1500, 7000) * np.sin(np.pi * k / dur) * noise
def whoosh(up, dur):
    n = int(dur * SR); k = np.arange(n) / SR; x = rng.standard_normal(n); out = np.zeros(n)
    for j in range(8):
        a0, a1 = j * n // 8, (j + 1) * n // 8; frac = (j + .5) / 8; frac = frac if up else 1 - frac
        out[a0:a1] = bp(x, 300 + 1400 * frac, 900 + 2600 * frac)[a0:a1]
    return out * np.sin(np.pi * k / dur) ** 2
def shimmer(root, n=5, down=False, gap=.055):
    pent = [0, 2, 4, 7, 9, 12, 14, 16]
    out = np.zeros(int((n * gap + 2) * SR))
    seq = pent[:n][::-1] if down else pent[:n]
    for i, iv in enumerate(seq):
        x = note(midi(root + iv), 1.9, .7, (1, .5, .2, .08), .002)
        out[int(i * gap * SR):int(i * gap * SR) + len(x)] += x
    return out
def thunder():
    n = int(4.5 * SR); k = np.arange(n) / SR
    crack = hp(rng.standard_normal(n), 1200) * np.exp(-k / .05) * .6
    roll = lp(rng.standard_normal(n), 220, 4) * np.minimum(1, k / .25) * np.exp(-k / 1.4) * (1 + .6 * lp(rng.standard_normal(n), 3)) * 6
    return crack + roll
def poof():
    n = int(.9 * SR); k = np.arange(n) / SR
    x = lp(rng.standard_normal(n), 900) * np.exp(-k / .12) * 1.2
    sp = np.zeros(n); idx = rng.integers(int(.05 * SR), n, 45); sp[idx] = rng.uniform(.3, 1, 45)
    return x + bp(sp, 5000, 11000) * 4 * np.exp(-k / .4)
def splash():
    n = int(.4 * SR); k = np.arange(n) / SR
    return bp(rng.standard_normal(n), 1800, 9000) * np.minimum(1, k / .01) * np.exp(-k / .09)

cur = ('none', False)
for e in events:
    s, ty = e['t'] / 1000, e['type']
    if ty == 'tap': put(sfx, s, click(), db(-24))
    elif ty == 'key': put(sfx, s, keytick(), db(-27), rng.uniform(-.2, .2))
    elif ty == 'send':
        put(sfx, s, swoosh(520, 1050, .16), db(-21))
        if cur[0] in ('rain', 'storm'): put(sfx, s + .2, splash(), db(-21))
    elif ty == 'receive':
        put(sfx, s, note(1046.5, .35, .07, (1, .2), .002), db(-22)); put(sfx, s + .07, note(1568, .45, .1, (1, .2), .002), db(-24))
    elif ty == 'sheet-open': put(sfx, s, whoosh(True, .32), db(-28))
    elif ty == 'sheet-close': put(sfx, s, whoosh(False, .26), db(-30))
    elif ty == 'scroll': put(sfx, s + .25, poof(), db(-20)); put(sfx, s + .7, poof(), db(-25), .3)
    elif ty == 'lightning': put(sfx, s, thunder(), db(-11)); put(sfx, s + .13, hp(rng.standard_normal(int(.06 * SR)), 2500) * .5, db(-18))
    elif ty == 'weather':
        c, n = e['cond'], e.get('night', False)
        if (c, n) != cur and e['t'] > 0:
            root = {'snow': 81, 'rain': 74, 'storm': 62, 'fog': 69, 'clear': 79 if n else 74}.get(c, 74)
            put(sfx, s, shimmer(root, 5, down=(c in ('storm', 'fog') or n)), db(-27))
        cur = (c, n)

# ---------------------------------------------------------------- title + outro cards
if a.lead:
    put(sfx, 0.12, whoosh(True, .5), db(-24))
    put(sfx, 0.35, shimmer(74, 6, gap=.07), db(-22))
    put(sfx, 0.9, poof() * .5, db(-30))
    put(sfx, a.lead - 0.55, whoosh(True, .45), db(-26))
if a.tail:
    te = a.lead + DEMO
    put(sfx, te - 0.5, whoosh(False, .45), db(-26))
    for i, m in enumerate((62, 66, 69, 74, 78)):
        put(sfx, te + 0.15 + i * .02, note(midi(m), 2.6, 1.1, (1, .4, .15, .05), .003), db(-25))

# ---------------------------------------------------------------- mix
def reverb(x, secs=1.8, wet=.2):
    n = int(secs * SR); k = np.arange(n) / SR
    out = np.zeros_like(x)
    for c in range(2):
        ir = rng.standard_normal(n) * np.exp(-k / (secs / 5)); ir = lp(ir, 6000); ir /= np.sqrt((ir ** 2).sum())
        out[c] = x[c] * (1 - wet) + fftconvolve(x[c], ir)[:N] * wet * 2.2
    return out
mix = reverb(music * gm, 2.4, .32) + amb + reverb(sfx, 1.2, .15)
fade = np.minimum(1, t / .6) * np.minimum(1, (a.seconds - t) / 2.0)
mix *= fade
mix /= np.max(np.abs(mix)) / db(-1.5)
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
out = ROOT / a.out
with wave.open(str(out), 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('saved', out, f'{a.seconds}s', 'rms dB', round(20 * np.log10(np.sqrt((mix ** 2).mean())), 1))
