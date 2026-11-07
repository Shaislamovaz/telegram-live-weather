/*!
 * Telegram Live Weather — weather provider
 * Demo source: Open-Meteo (free, no API key). In the real app this would be the
 * same backend that already powers the weather widget in Stories.
 * MIT License
 */
(function (global) {
  'use strict';
  const TW = (global.TgWeather = global.TgWeather || {});

  /** WMO weather interpretation codes -> one of 6 visual conditions. */
  function mapWmo(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2 || code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloudy';
  }

  const TTL = 30 * 60 * 1000; // refresh at most every 30 minutes
  const cache = new Map();

  /**
   * @returns {Promise<{condition:string,isNight:boolean,temp:number,code:number}>}
   * Only coarse coordinates are needed (city level) — never precise location.
   */
  async function fetchCurrent(lat, lon, { signal } = {}) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
      '&current=temperature_2m,weather_code,is_day&timezone=auto';
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('weather ' + res.status);
    const c = (await res.json()).current;
    const value = { condition: mapWmo(c.weather_code), isNight: c.is_day === 0, temp: Math.round(c.temperature_2m), code: c.weather_code };
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  TW.provider = { fetchCurrent, mapWmo };
})(typeof window !== 'undefined' ? window : globalThis);
