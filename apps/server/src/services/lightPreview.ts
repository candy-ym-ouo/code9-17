import {
  addDaysToKey,
  localDateKey,
  type LightPreviewDay,
  type LightPreviewDerivation,
  type LightPreviewForecastMeta,
  type LightPreviewInputSnapshot,
  type LightPreviewResponse,
  type LightPreviewWeather,
  type LightPreviewRequest,
  type TimingDto,
} from '@flil/shared';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import { computeDay, loadSpotGeom, type SpotGeom } from './windowEngine.js';
import { getForecastMeta, type HourlyForecast } from './weather.js';

/**
 * 光线预演台：对"未落库"的临时条件做即时重判。
 *
 * 三条不可破坏的边界：
 *  1. 坐标只来自库内已授权机位（由路由按 inspirationId 解析），本服务**不接受**任何经纬度入参；
 *  2. 只读天气缓存、只读窗口判定，**不写** repro_window / weather_cache / share 任何表；
 *  3. 响应回显"实际使用的输入快照 + 派生公式 + 天气来源"，每条结论可人工复算，且不含精确坐标。
 */

/** 把四个旋钮叠加到待试算 timing 上，产出真正参与计算的 timing、溯源快照与派生关系 */
export function applyOverrides(
  base: TimingDto,
  override: LightPreviewRequest['override'],
): { timing: TimingDto; snapshot: LightPreviewInputSnapshot; derivations: LightPreviewDerivation[] } {
  const derivations: LightPreviewDerivation[] = [];

  // ① 太阳事件（时间锚）+ 云量 + 能见度直接落到天气画像
  const timing: TimingDto = {
    ...base,
    timeAnchor: override.timeAnchor,
    anchorOffsetMin: override.anchorOffsetMin,
    weatherProfile: {
      ...base.weatherProfile,
      cloudCoverPct: { min: override.cloudCoverPct.min, max: override.cloudCoverPct.max },
      visibilityKmMin: override.visibilityKmMin,
    },
  };

  // ② 机位朝向 + 光位角 → 期望太阳方位角（仅当用户画了光位箭头时才派生，否则尊重手填方位角）
  let azimuthRange = base.azimuthRange;
  let azimuthSource: LightPreviewInputSnapshot['azimuthSource'] = 'manual';
  if (override.lightBearingHint !== null) {
    const expected =
      Math.round(((((override.cameraBearing + override.lightBearingHint) % 360) + 360) % 360) * 10) / 10;
    azimuthRange = [expected, expected];
    azimuthSource = 'camera_bearing_plus_light';
    derivations.push({
      key: 'expected_sun_azimuth',
      formula: 'expectedAzimuth = (cameraBearing + lightBearingHint) mod 360',
      inputs: { cameraBearing: override.cameraBearing, lightBearingHint: override.lightBearingHint },
      result: expected,
    });
  }
  timing.azimuthRange = azimuthRange;
  timing.azimuthTolerance = base.azimuthTolerance;

  const snapshot: LightPreviewInputSnapshot = {
    timeAnchor: timing.timeAnchor,
    anchorOffsetMin: timing.anchorOffsetMin,
    weatherProfile: timing.weatherProfile,
    cameraBearing: override.cameraBearing,
    lightBearingHint: override.lightBearingHint,
    azimuthRange: timing.azimuthRange,
    azimuthTolerance: timing.azimuthTolerance,
    azimuthSource,
  };

  return { timing, snapshot, derivations };
}

function toWeatherMeta(
  forecast: HourlyForecast[],
  meta: { cacheHit: boolean; fetchedAt: string | null },
): LightPreviewForecastMeta {
  return {
    provider: config.weatherProvider,
    cached: meta.cacheHit,
    cacheHit: meta.cacheHit,
    fetchedAt: meta.fetchedAt,
    ageMin:
      meta.fetchedAt !== null
        ? Math.max(0, Math.round((Date.now() - new Date(meta.fetchedAt).getTime()) / 60000))
        : null,
    ttlMin: config.weatherCacheTtlMin,
    degraded: forecast.length === 0,
    hours: forecast.length,
  };
}

function toWeatherView(day: ReturnType<typeof computeDay>): LightPreviewWeather | null {
  const e = day.episode;
  if (!e) return null;
  return {
    degraded: e.degraded,
    provider: e.provider,
    avgCloudCoverPct: e.avgCloudCoverPct,
    maxPrecipProbPct: e.maxPrecipProbPct,
    minVisibilityKm: e.minVisibilityKm,
    maxWindSpeedMs: e.maxWindSpeedMs,
    avgTempC: e.avgTempC,
  };
}

/**
 * 执行一次预演。`evalId` 由调用方按库单调递增，前端用它丢弃乱序到达的旧结果。
 * cameraBearing 只是试算旋钮：用库内机位的几何坐标，但临时覆盖朝向，绝不改库。
 */
export async function evaluateLightPreview(
  spot: SpotGeom,
  request: LightPreviewRequest,
  evalId: number,
): Promise<LightPreviewResponse> {
  const { timing, snapshot, derivations } = applyOverrides(request.timing, request.override);
  const days = Math.min(16, Math.max(1, request.days ?? 7));

  // 坐标/时区仍取自库内已授权机位；camera_bearing 用旋钮临时值（computeDay 不读它，派生已在上面完成）
  const geom: SpotGeom = loadSpotGeom(spot.id) ?? {
    ...spot,
    camera_bearing: request.override.cameraBearing,
  };

  const { forecast, cacheHit, fetchedAt } = await getForecastMeta(spot.lat, spot.lng, days);
  const todayKey = localDateKey(new Date(), spot.tz);

  const resultDays: LightPreviewDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(todayKey, i);
    const day = computeDay(geom, timing, key, forecast);
    resultDays.push({
      date: day.date,
      verdict: day.verdict,
      startAt: day.startAt.toISOString(),
      endAt: day.endAt.toISOString(),
      anchorAt: day.anchorAt ? day.anchorAt.toISOString() : null,
      sunElevation: day.sunElevation,
      sunAzimuth: day.sunAzimuth,
      reasons: day.reasons,
      weather: toWeatherView(day),
    });
  }

  return {
    evalId,
    evaluatedAt: nowIso(),
    input: snapshot,
    derivations,
    days: resultDays,
    counts: {
      good: resultDays.filter((d) => d.verdict === 'good').length,
      marginal: resultDays.filter((d) => d.verdict === 'marginal').length,
      bad: resultDays.filter((d) => d.verdict === 'bad').length,
    },
    forecast: toWeatherMeta(forecast, { cacheHit, fetchedAt }),
    persisted: false,
  };
}
