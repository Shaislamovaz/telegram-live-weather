# Integrating Live Weather into Telegram Web A (telegram-tt)

The engine (`src/weather-layer.js`) has no dependencies and no framework assumptions, so it can be ported into
[Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt) as a TypeScript module with minimal changes.

## 1. Mount point

`src/components/common/Wallpaper.tsx` already wraps the chat content and renders the wallpaper layer
(the animated gradient canvas) behind it. That is where the weather layer belongs:

```tsx
<div className={buildClassName(background.backgroundClassNames, bgClassName)} style={background.backgroundStyle}>
  {background.hasGradient && <canvas ref={background.gradientCanvasRef} ... />}
  {isWeatherOn && <canvas ref={weatherBgRef} className={styles.weatherBg} />}   {/* new: behind messages */}
</div>
{children}
{isWeatherOn && <canvas ref={weatherFgRef} className={styles.weatherFg} />}     {/* new: above messages, pointer-events: none */}
```

The weather layer draws its own 4-point gradient, so when it is on, it replaces the gradient canvas
rather than stacking on top of it.

## 2. Hook

```ts
// src/hooks/useLiveWeather.ts
export default function useLiveWeather({ bgRef, fgRef, messagesRef, condition, isNight, isEnabled }) {
  useLayoutEffect(() => {
    if (!isEnabled) return undefined;
    const layer = new WeatherLayer({
      background: bgRef.current!, foreground: fgRef.current!,
      getBubbles: () => collectVisibleBubbles(messagesRef.current!), // .message-content rects, layer-local
      width, height, quality: IS_LOW_END ? 0.6 : 1,
    });
    let raf = requestAnimationFrame(function loop(t) { layer.frame(t); raf = requestAnimationFrame(loop); });
    return () => cancelAnimationFrame(raf);
  }, [isEnabled]);
  useEffect(() => layer?.setWeather(condition, isNight), [condition, isNight]);
}
```

- `onMessageSent(rect)` — call it from the existing message-sending animation (the same place that already moves the gradient).
- `onScroll(dy)` — from `MessageList`'s scroll handler.

## 3. Settings & performance

- Gate it behind the existing performance settings (`selectPerformanceSettingsValue(global, 'messageSendingAnimations')`
  or a new `liveWeather` key) so it switches off together with other heavy animations and in Power Saving.
- Respect `prefers-reduced-motion`: pass `reducedMotion: true` → static gradient only.
- Pause when the tab is hidden (`document.hidden`).

## 4. Data

- **My weather**: city from the user's settings or a coarse IP-based guess; never precise GPS.
- **Contact's weather**: an opt-in privacy setting ("Share my city's weather in chats: Nobody / Contacts / …"),
  exposed by the server as a condition + day/night + temperature — never coordinates.
- Same backend as the Stories weather widget; refresh every 30 minutes, cached per city.

## 5. Native apps

The effects are simple particle systems and gradients — they map 1:1 to `CAEmitterLayer` / Metal on iOS and
to `Canvas`/`RenderNode` on Android. The snow-cap model (a height-map per bubble that follows its corner radius
and sheds on scroll velocity) is the same on every platform.
