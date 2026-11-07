# Live Weather — full write-up

## 1. The idea in one paragraph

Telegram's gradient wallpapers already move when you send a message. Live Weather gives them a second reason to move: the place behind the conversation. The wallpaper shows the current weather at your city — or, if they agreed to share it, at the other person's city — and the weather physically interacts with the messages.

## 2. Architecture

| Part | File | Role |
|---|---|---|
| Weather source | `src/weather-provider.js` | Asks for the **current** weather at a city every 30 minutes (cached). Returns one of `clear · cloudy · rain · storm · snow · fog`, day/night and temperature. No forecasting. |
| Engine | `src/weather-layer.js` | Draws everything on two Canvas 2D layers. Knows nothing about Telegram except "here are the visible bubble rectangles". |
| Host | `src/app.js` | Chat UI, the *Live Weather* sheet, day/night theme, feeds bubble rects and events to the engine. |

### Two canvases

- **Background** (behind messages): the 4-point moving gradient, clouds, fog, sun glow and rays, stars and moon, shooting stars, rain streaks, drops on the glass, distant snowflakes, lightning.
- **Foreground** (above messages, `pointer-events: none`): snow caps on bubbles, rain splashes on bubble edges, near snowflakes, falling snow chunks, the sunlight sheen across bubbles, a faint fog veil at the screen edges.

Messages stay readable because nothing opaque is drawn on top of text: the foreground only touches bubble *edges* (caps, splashes) or adds light (sheen) at low opacity.

### Blending between states

Each condition is a set of effect weights (`sun`, `rain`, `snow`, `fog`, `stars`, `moon`, `storm`, `clouds`). Switching weather changes the *targets*; every frame the current weights and the four palette colours approach their targets exponentially (~1.5 s). So rain → storm → fog is a continuous transition, never a cut.

## 3. The effects

**Snow caps.** Every visible bubble owns a height map: one column per 3 px of its width. Flakes that cross a bubble's top edge add a small Gaussian bump; a slow base growth keeps the cap even. The cap's base follows the bubble's rounded corners (circle equation over the corner radius) and an envelope keeps the corners thin, so the snow looks like it is *sitting* on the bubble. A light diffusion pass each frame smooths the surface. When the user scrolls, part of every column turns into falling chunks with gravity. When the weather turns warm, caps melt (faster in rain).

**Drops on the glass.** Drops appear and grow; a big drop eventually starts sliding, wobbles, leaves a trail of tiny drops and absorbs the drops in its path. Each drop is drawn as a fake lens: a radial gradient (bright top-left, dark rim), a refracted bright crescent at the bottom and a specular dot. When a message is sent, drops near the new bubble get an outward velocity, so the rain visibly makes room for it.

**Rain streaks and splashes.** Three depth bands of streaks with wind slant. Streaks in the front band that hit a bubble's top edge turn into 2–4 splash particles on the foreground layer.

**Lightning.** In a storm, every 4–6 s: a jagged bolt with glow, a double flash (the second 130 ms later), and a faint flash on the foreground so the UI is lit for a moment too.

**Sun.** A warm glow from the top-right corner, nine slowly breathing rays drawn additively, floating motes, and every 7 s a diagonal sheen sweeping across the bubbles (clipped to each bubble's rounded rect).

**Night.** Twinkling stars, a soft moon, an occasional shooting star. The UI theme crossfades to dark through CSS `color-mix()` driven by one variable, so the switch is a smooth fade, not a jump.

## 4. Data and privacy

- **City only.** The demo sends coarse coordinates (two decimals) of a *city*; production would use the city from settings or a coarse IP guess. Never GPS.
- **Opt-in sharing.** A contact's weather appears only if that contact enabled it, e.g. *Privacy → Share my city's weather: Nobody / Contacts / Everybody*. The server would expose only condition, day/night and temperature.
- **One small request per 30 minutes**, cached per city.
- **Existing backend.** Telegram already resolves current weather for the weather widget in Stories, so no new weather provider is needed.

## 5. Performance

- Canvas 2D, no dependencies; the engine is ~28 KB unminified.
- `quality` (0.3–1) scales particle counts; the demo picks 0.6 on devices with ≤ 4 cores.
- The loop is paused while the page is hidden.
- `prefers-reduced-motion` (and Power Saving in the real app) → only the static gradient.
- Bubble rectangles are read once per frame for visible bubbles only.

## 6. What is real and what is mocked in the demo

| Real | Mocked |
|---|---|
| The whole engine and every effect | The chat (messages are local, nothing is sent) |
| Weather mapping and caching | "Mom's" sharing permission |
| Fetching real current weather (when opened locally) | In the published preview page, network requests are blocked, so it falls back to sample data |
| Day/night theme, settings sheet | iOS status bar |

## 7. How the video was produced

1. `tools/record.py` opens the demo with `?record`. In this mode every animation — engine, tweens, the scripted demo — runs on **one virtual clock**, and `Math.random` is seeded. The script steps the clock 1/60 s at a time and captures each frame at 3× (two browser workers in parallel). The result is perfectly smooth and reproducible on any machine.
2. The same run logs a timeline of events (taps, keystrokes, sends, sheet open/close, weather changes, lightning, shooting stars).
3. `tools/sound.py` synthesizes the soundtrack from that timeline — no samples: an ambient pad and plucks, wind for snow, rain hiss and drops, thunder on each lightning frame, crickets at night, birds in the sun, UI clicks, typing, send/receive sounds and a chime on every weather change.
4. `tools/present.py` builds the presentation: an animated title card (`tools/titlecard.html`), an iPhone frame drawn in code, sub-pixel camera moves into the details, and an outro — 60 fps.
