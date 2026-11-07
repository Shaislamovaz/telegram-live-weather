# Decision log

Short notes on the choices made while building Live Weather — newest last.

**2026-11-07 · Weather should touch the messages, not just sit behind them.**
Animated weather wallpapers alone feel like a theme pack. The feature becomes Telegram-like only when the weather reacts to the chat: snow settling on bubbles, drops moving aside for a new message. Those two interactions were built first.

**2026-11-07 · "The other person's weather" is the core story.**
Your own weather you can see through the window. Seeing the weather of someone far away is new information with emotional value. Because it reveals location, it is strictly opt-in and city-level.

**2026-11-07 · Web first.**
No Mac was available for an iOS build, and Telegram Web A is open source and runs anywhere. The engine is framework-agnostic so the same model can be ported to Swift / Kotlin.

**2026-11-07 · Canvas 2D instead of WebGL.**
Telegram Web A already spends a WebGL context on the animated gradient (and falls back to 2D when animations are off). Canvas 2D keeps the layer cheap, works everywhere, and is fast enough for a few hundred particles.

**2026-11-07 · Two canvases around the message list.**
One layer can't be both behind the text and on top of the bubble edges. A background canvas holds the scene; a non-interactive foreground canvas only draws on bubble edges (caps, splashes) or adds light.

**2026-11-07 · Snow as a height map per bubble.**
Particles that stick to bubbles would be expensive and hard to shape. A column height map (3 px per column) is cheap, easy to smooth, follows the corner radius, and can be "shed" on scroll by turning part of each column into falling chunks.

**2026-11-07 · Weights and palettes approach their targets; no hard switches.**
Every effect has a weight and the palette has four colours; both approach their targets exponentially. Any change — rain → storm, day → night — becomes a crossfade for free.

**2026-11-07 · Six conditions only.**
Weather APIs return dozens of codes. Users can't tell "moderate drizzle" from "light rain" on a wallpaper, so WMO codes collapse into clear, cloudy, rain, storm, snow and fog, plus day/night.

**2026-11-07 · Snow palette made deeper.**
On the first light-blue palette the white snow caps disappeared against white incoming bubbles. The day-snow palette was darkened, and the caps got a soft shadow and a thin outline.

**2026-11-07 · One virtual clock for everything.**
Screen-recording a browser drops frames. With all animations on one clock, the demo is rendered frame-by-frame — the video is exact, and the same run produces the event timeline for the sound.

**2026-11-07 · Procedural sound, silent cut for the channel.**
The featured videos in @designers have no sound, so the submission uses the silent cut. A version with synthesized sound (no third-party samples) exists for social media and presentations.

**2026-11-07 · Presentation format follows the channel.**
Square video, a title card with an icon, the phone shown whole, camera moves into the details, a white ring as the touch indicator.

**2026-11-07 · Snow caps follow the bubble's final size.**
A message that pops in starts small; its snow cap used to keep that first, narrower width, so new messages got "half" caps. The height map is now resampled whenever the bubble's width changes, and the cap's outline is drawn only on its top surface.

**2026-11-07 · 60 fps and a sub-pixel camera.**
At 30 fps with whole-pixel cropping the camera moves looked jittery. The demo is now rendered at 60 fps and the presentation maps every output pixel to an exact fractional source position.
