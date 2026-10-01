import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { distanceKm, type WeatherPhenomenon } from '@flil/shared';

export interface HourlyForecast {
  time: string; // ISO（UTC）
  cloudCoverPct: number | null;
  precipProbPct: number | null;
  precipMm: number | null;
  visibilityKm: number | null;
  windSpeedMs: number | null;
  tempC: number | null;
  humidityPct: number | null;
  snowfallCm: number | null;
}

export interface EpisodeWeather {
  degraded: boolean;
  provider: string;
  avgCloudCoverPct: number | null;
  maxPrecipProbPct: number | null;
  precipMmWindow: number | null;
  precipMmPrev6h: number | null;
  minVisibilityKm: number | null;
  maxWindSpeedMs: number | null;
  avgTempC: number | null;
  humidityPct: number | null;
  snowfallCm: number | null;
}

// ---------------------------------------------------------------- providers

async function fetchOpenMeteo(lat: number, lng: number, days: number): Promise<HourlyForecast[]> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lng.toFixed(4));
  url.searchParams.set(
    'hourly',
    'cloud_cover,precipitation_probability,precipitation,visibility,wind_speed_10m,temperature_2m,relative_humidity_2m,snowfall',
  );
  url.searchParams.set('forecast_days', String(Math.min(16, Math.max(2, days + 1))));
  url.searchParams.set('timezone', 'UTC');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`天气接口返回 ${res.status}`);
    const body = (await res.json()) as {
      hourly: Record<string, (number | null)[] | string[]>;
    };
    const h = body.hourly;
    const times = h.time as string[];
    const pick = (key: string, i: number) => {
      const arr = h[key] as (number | null)[] | undefined;
      return arr?.[i] ?? null;
    };
    return times.map((t, i) => ({
      time: new Date(`${t}:00Z`).toISOString(),
      cloudCoverPct: pick('cloud_cover', i),
      precipProbPct: pick('precipitation_probability', i),
      precipMm: pick('precipitation', i),
      visibilityKm: pick('visibility', i) === null ? null : (pick('visibility', i) as number) / 1000,
      windSpeedMs: pick('wind_speed_10m', i),
      tempC: pick('temperature_2m', i),
      humidityPct: pick('relative_humidity_2m', i),
      snowfallCm: pick('snowfall', i),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fixture 天气源：**只用于自动化测试**，按 (日期, 坐标) 做确定性伪随机，
 * 保证测试不依赖外网，且同一天气场景可复现。
 */
function fetchFixture(lat: number, lng: number, days: number): HourlyForecast[] {
  const out: HourlyForecast[] = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const seed = Math.abs(Math.round(lat * 100) * 7919 + Math.round(lng * 100) * 104729);
  for (let d = 0; d < days + 1; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const t = new Date(start.getTime() + (d * 24 + h) * 3600000);
      // 每 3 天一轮天气：晴 → 薄云 → 阴雨
      const cycle = (d + Math.floor(seed / 1000)) % 3;
      const wave = Math.sin(((h - 6) / 24) * Math.PI * 2);
      out.push({
        time: t.toISOString(),
        cloudCoverPct: cycle === 0 ? 15 + 5 * wave : cycle === 1 ? 45 + 10 * wave : 88,
        precipProbPct: cycle === 2 && h >= 12 ? 70 : cycle === 1 ? 20 : 5,
        precipMm: cycle === 2 && h >= 12 ? 1.4 : 0,
        visibilityKm: cycle === 2 ? 6 : 20,
        windSpeedMs: 2.5 + Math.abs(wave) * 2,
        tempC: 18 + 6 * wave,
        humidityPct: cycle === 2 ? 88 : cycle === 1 ? 65 : 45,
        snowfallCm: 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 对外接口

function cacheKey(lat: number, lng: number, days: number): string {
  return `${config.weatherProvider}:${lat.toFixed(2)}:${lng.toFixed(2)}:${days}`;
}

function readCacheEntry(key: string): { forecast: HourlyForecast[]; fetchedAt: string } | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT payload, fetched_at FROM weather_cache WHERE cache_key = ?').get(key) as
      | { payload: string; fetched_at: string }
      | undefined;
    if (!row) return null;
    const ageMin = (Date.now() - new Date(row.fetched_at).getTime()) / 60000;
    if (ageMin > config.weatherCacheTtlMin) return null;
    return { forecast: parseJson<HourlyForecast[]>(row.payload, []), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function readCache(key: string): HourlyForecast[] | null {
  return readCacheEntry(key)?.forecast ?? null;
}

function writeCache(key: string, forecast: HourlyForecast[]): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO weather_cache (id, cache_key, payload, fetched_at) VALUES (?,?,?,?)
         ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(newId(), key, toJson(forecast), nowIso());
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

export async function getForecast(lat: number, lng: number, days: number): Promise<HourlyForecast[]> {
  const { forecast } = await getForecastMeta(lat, lng, days);
  return forecast;
}

export interface ForecastMeta {
  forecast: HourlyForecast[];
  /** 本次是否直接命中未过期缓存（预演溯源用） */
  cacheHit: boolean;
  /** 实际使用数据的抓取时刻：命中缓存为缓存写入时刻，实时抓取为当前，降级为 null */
  fetchedAt: string | null;
}

/**
 * 取预报并附带缓存来源元数据。元数据**刻意不含坐标**，避免经预演接口反推机位。
 * 未命中时照常抓取并回填缓存（与正式窗口计算同一份数据）；
 * 命中时直接返回缓存、不延长其 fetched_at/TTL。
 */
export async function getForecastMeta(lat: number, lng: number, days: number): Promise<ForecastMeta> {
  if (config.weatherProvider === 'off') {
    return { forecast: [], cacheHit: false, fetchedAt: null };
  }
  const key = cacheKey(lat, lng, days);
  const cached = readCacheEntry(key);
  if (cached) return { forecast: cached.forecast, cacheHit: true, fetchedAt: cached.fetchedAt };

  try {
    const forecast =
      config.weatherProvider === 'fixture'
        ? fetchFixture(lat, lng, days)
        : await fetchOpenMeteo(lat, lng, days);
    if (forecast.length) {
      const fetchedAt = nowIso();
      writeCache(key, forecast);
      return { forecast, cacheHit: false, fetchedAt };
    }
    return { forecast, cacheHit: false, fetchedAt: null };
  } catch (err) {
    logger.warn('天气源不可用，进入降级模式', { error: String(err), provider: config.weatherProvider });
    return { forecast: [], cacheHit: false, fetchedAt: null };
  }
}

function nearest(forecast: HourlyForecast[], at: Date): HourlyForecast | null {
  if (!forecast.length) return null;
  let best = forecast[0];
  let bestDiff = Math.abs(new Date(best.time).getTime() - at.getTime());
  for (const f of forecast) {
    const diff = Math.abs(new Date(f.time).getTime() - at.getTime());
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return bestDiff <= 3 * 3600000 ? best : null;
}

function slice(forecast: HourlyForecast[], from: Date, to: Date): HourlyForecast[] {
  return forecast.filter((f) => {
    const t = new Date(f.time).getTime();
    return t >= from.getTime() && t <= to.getTime();
  });
}

/**
 * 取窗口内的预报样本。
 *
 * 关键点（实测踩到的坑）：很多窗口只有 20 分钟，可能**完全落在两个整点之间**
 * （例如 16:36–16:59）。若此时只按"窗口内整点"取值，会得到空数组，
 * 于是云量/降水概率/能见度全部判为"无数据"并被静默跳过——
 * 结果是一个雨天窗口被判成 good。因此这里退化为取**相邻两个整点**，
 * 且对"是否会下雨"这类硬性项取更保守的一侧（见 summarizeEpisode 的 max 聚合）。
 */
function windowSamples(forecast: HourlyForecast[], start: Date, end: Date): HourlyForecast[] {
  const inside = slice(forecast, start, end);
  if (inside.length) return inside;

  const before = [...forecast].reverse().find((f) => new Date(f.time).getTime() <= start.getTime());
  const after = forecast.find((f) => new Date(f.time).getTime() >= end.getTime());
  const out = [before, after].filter((f): f is HourlyForecast => Boolean(f));
  if (out.length) return out;

  const fallback = nearest(forecast, start);
  return fallback ? [fallback] : [];
}

/** 汇总窗口 [start, end] 的天气，并带上窗口前 6 小时的降水（判定湿地面/雨后需要） */
export function summarizeEpisode(
  forecast: HourlyForecast[],
  start: Date,
  end: Date,
): EpisodeWeather {
  const degraded = forecast.length === 0;
  if (degraded) {
    return {
      degraded: true,
      provider: config.weatherProvider,
      avgCloudCoverPct: null,
      maxPrecipProbPct: null,
      precipMmWindow: null,
      precipMmPrev6h: null,
      minVisibilityKm: null,
      maxWindSpeedMs: null,
      avgTempC: null,
      humidityPct: null,
      snowfallCm: null,
    };
  }

  const inWindow = windowSamples(forecast, start, end);
  const point = inWindow[0] ?? nearest(forecast, start);
  const prevRaw = slice(forecast, new Date(start.getTime() - 6 * 3600000), start);
  const prev = prevRaw.length ? prevRaw : [];
  const nums = (arr: HourlyForecast[], key: keyof HourlyForecast) =>
    arr.map((f) => f[key]).filter((v): v is number => typeof v === 'number');
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const sum = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) : null);

  const cloud = nums(inWindow, 'cloudCoverPct');
  const precipProb = nums(inWindow, 'precipProbPct');
  const vis = nums(inWindow, 'visibilityKm');
  const wind = nums(inWindow, 'windSpeedMs');
  const temp = nums(inWindow, 'tempC');
  const snow = nums(inWindow, 'snowfallCm');

  return {
    degraded: false,
    provider: config.weatherProvider,
    avgCloudCoverPct: avg(cloud),
    maxPrecipProbPct: precipProb.length ? Math.max(...precipProb) : null,
    precipMmWindow: sum(nums(inWindow, 'precipMm')),
    precipMmPrev6h: sum(nums(prev, 'precipMm')),
    minVisibilityKm: vis.length ? Math.min(...vis) : null,
    maxWindSpeedMs: wind.length ? Math.max(...wind) : null,
    avgTempC: avg(temp),
    humidityPct: point?.humidityPct ?? null,
    snowfallCm: snow.length ? Math.max(...snow) : null,
  };
}

/** 特殊现象判定（文档 12.4 第 3 步） */
export function phenomenonHolds(
  phenomenon: WeatherPhenomenon,
  episode: EpisodeWeather,
  isNight: boolean,
): boolean {
  switch (phenomenon) {
    case 'any':
      return true;
    case 'clear':
      return (episode.avgCloudCoverPct ?? 0) <= 20;
    case 'thin_cloud':
      return episode.avgCloudCoverPct !== null && episode.avgCloudCoverPct > 20 && episode.avgCloudCoverPct <= 60;
    case 'overcast':
      return (episode.avgCloudCoverPct ?? 0) > 80;
    case 'after_rain':
      return (episode.precipMmPrev6h ?? 0) > 0.2 || (episode.precipMmWindow ?? 0) > 0.2;
    case 'wet_ground':
      return (episode.precipMmPrev6h ?? 0) > 0.2 && (episode.maxPrecipProbPct ?? 100) <= 20;
    case 'fog':
      return (episode.minVisibilityKm ?? 99) <= 1 && (episode.humidityPct ?? 0) >= 92;
    case 'snow':
      return (episode.snowfallCm ?? 0) > 0;
    case 'neon_reflection':
      return isNight && (episode.precipMmPrev6h ?? 0) > 0.2;
    case 'strong_wind':
      return (episode.maxWindSpeedMs ?? 0) >= 8;
    default:
      return false;
  }
}

// ------------------------------------------------------- 气候基线（文档 12.5）

export interface ClimateStat {
  month: number;
  hour: number;
  meanCloudCoverPct: number;
  precipHourRatio: number;
  samples: number;
}

/**
 * 用 Open-Meteo 历史接口（过去 5 年同期）统计气候基线。
 * 这是**尽力而为**的能力：失败或未启用时返回空数组，年度日历退化为"仅理论天数"。
 */
export async function climateStats(lat: number, lng: number, month: number): Promise<ClimateStat[]> {
  if (!config.climateBaselineEnabled || config.weatherProvider === 'off') return [];
  const key = `climate:${lat.toFixed(1)}:${lng.toFixed(1)}:${month}`;
  try {
    const db = getDb();
    const row = db.prepare('SELECT payload, fetched_at FROM climate_cache WHERE cache_key = ?').get(key) as
      | { payload: string; fetched_at: string }
      | undefined;
    if (row) {
      const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
      if (ageDays < 30) return parseJson<ClimateStat[]>(row.payload, []);
    }
  } catch {
    /* 继续走网络请求 */
  }

  const year = new Date().getUTCFullYear();
  const startDate = `${year - 5}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year - 1}-${String(month).padStart(2, '0')}-28`;
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lng.toFixed(3));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('hourly', 'cloud_cover,precipitation');
  url.searchParams.set('timezone', 'UTC');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`archive 返回 ${res.status}`);
    const body = (await res.json()) as { hourly: { time: string[]; cloud_cover: number[]; precipitation: number[] } };
    const acc = new Map<string, { cloud: number; precipHours: number; n: number }>();
    body.hourly.time.forEach((t, i) => {
      const h = new Date(`${t}:00Z`).getUTCHours();
      const k = String(h);
      const e = acc.get(k) ?? { cloud: 0, precipHours: 0, n: 0 };
      e.cloud += body.hourly.cloud_cover[i] ?? 0;
      if ((body.hourly.precipitation[i] ?? 0) > 0.1) e.precipHours += 1;
      e.n += 1;
      acc.set(k, e);
    });
    const stats: ClimateStat[] = [...acc.entries()].map(([h, e]) => ({
      month,
      hour: Number(h),
      meanCloudCoverPct: e.n ? e.cloud / e.n : 0,
      precipHourRatio: e.n ? e.precipHours / e.n : 0,
      samples: e.n,
    }));
    try {
      getDb()
        .prepare(
          `INSERT INTO climate_cache (id, cache_key, payload, fetched_at) VALUES (?,?,?,?)
           ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        )
        .run(newId(), key, toJson(stats), nowIso());
    } catch {
      /* 忽略缓存写入失败 */
    }
    return stats;
  } catch (err) {
    logger.warn('气候基线获取失败（年度日历将退化为仅理论天数）', { error: String(err) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function climateAt(stats: ClimateStat[], hour: number): ClimateStat | null {
  if (!stats.length) return null;
  return stats.reduce((best, s) =>
    Math.abs(s.hour - hour) < Math.abs(best.hour - hour) ? s : best,
  );
}

export { distanceKm };
