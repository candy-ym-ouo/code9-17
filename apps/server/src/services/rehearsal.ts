import crypto from 'node:crypto';
import {
  addDaysToKey,
  localDateKey,
  type RehearsalDayDto,
  type RehearsalRequest,
  type RehearsalResponse,
  type RehearsalWeatherOverride,
  type TimingDto,
} from '@flil/shared';
import { errors } from '../http/errors.js';
import { config } from '../config.js';
import type { InspirationRow } from './serialization.js';
import { computeDay, loadSpotGeom, loadTiming, timingRowToDto } from './windowEngine.js';
import { getForecast, type HourlyForecast } from './weather.js';

/**
 * 光线预演台（只读试算）。
 *
 * 三条硬约束：
 * 1. 即时重判 —— 同步算完 N 天，直接复用 windowEngine.computeDay 的逐项理由；
 * 2. 结论可溯源 —— 返回完整生效输入 + 输入指纹（inputHash），指纹相同则结论可复算；
 * 3. 不外泄 —— 不写 repro_window / 不发事件 / 不动分享快照与天气缓存；
 *    响应里不含任何坐标（精确或模糊都不需要），并配合路由层的 Cache-Control: no-store。
 */

/** 深合并条件覆盖：weatherProfile 按键合并，azimuthRange 显式给 null 表示清除约束 */
export function mergeTiming(base: TimingDto, patch: Partial<TimingDto> | undefined): TimingDto {
  if (!patch) return base;
  const merged: TimingDto = { ...base, ...patch };
  merged.elevationRange = patch.elevationRange ?? base.elevationRange;
  merged.azimuthRange = patch.azimuthRange === undefined ? base.azimuthRange : patch.azimuthRange;
  merged.seasonWindow = patch.seasonWindow === undefined ? base.seasonWindow : patch.seasonWindow;
  merged.weatherProfile = { ...base.weatherProfile, ...(patch.weatherProfile ?? {}) };
  merged.notes = patch.notes === undefined ? base.notes : patch.notes;
  return merged;
}

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * 机位朝向改动后重推光位约束：
 * 光位角（相对机位）保持不变，期望太阳方位角 = 机位朝向 + 光位角。
 * 若调用方显式覆盖了 azimuthRange（含 null），以显式值为准。
 */
export function deriveAzimuth(
  patch: Partial<TimingDto> | undefined,
  saved: TimingDto,
  origCameraBearing: number,
  effCameraBearing: number,
  lightBearingInput: number | null | undefined,
): { azimuthRange: number[] | null; lightBearingDeg: number | null; derivedAzimuth: number | null } {
  if (patch && patch.azimuthRange !== undefined) {
    const range = patch.azimuthRange;
    return {
      azimuthRange: range,
      lightBearingDeg: range ? norm360((range[0] + range[1]) / 2 - effCameraBearing) : null,
      derivedAzimuth: range ? norm360((range[0] + range[1]) / 2) : null,
    };
  }
  const savedCenter = saved.azimuthRange ? (saved.azimuthRange[0] + saved.azimuthRange[1]) / 2 : null;
  const light =
    lightBearingInput !== undefined && lightBearingInput !== null
      ? lightBearingInput
      : savedCenter !== null
        ? norm360(savedCenter - origCameraBearing)
        : null;
  if (light === null) return { azimuthRange: null, lightBearingDeg: null, derivedAzimuth: null };
  const derived = Math.round(norm360(effCameraBearing + light));
  return { azimuthRange: [derived, derived], lightBearingDeg: norm360(light), derivedAzimuth: derived };
}

/** 假设天气只作用于内存副本：替换逐小时云量/能见度，绝不写回 weather_cache */
export function applyWeatherOverride(
  forecast: HourlyForecast[],
  override: RehearsalWeatherOverride | null | undefined,
): HourlyForecast[] {
  if (!override) return forecast;
  return forecast.map((h) => ({
    ...h,
    cloudCoverPct: override.cloudCoverPct !== undefined ? override.cloudCoverPct : h.cloudCoverPct,
    visibilityKm: override.visibilityKm !== undefined ? override.visibilityKm : h.visibilityKm,
  }));
}

/** 稳定序列化（键排序），让 inputHash 与字段顺序无关、可跨进程复算 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function rehearsalHash(payload: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex').slice(0, 16);
}

export async function runRehearsal(
  inspiration: InspirationRow,
  input: RehearsalRequest,
): Promise<RehearsalResponse> {
  const timingRow = loadTiming(inspiration.id);
  if (!timingRow) throw errors.timingIncomplete('该卡片还没有设置拍摄条件，先保存一次条件再预演');
  if (!inspiration.spot_id) throw errors.badRequest('该卡片还没有机位，先把机位定下来');
  const spot = loadSpotGeom(inspiration.spot_id);
  if (!spot) throw errors.badRequest('机位不存在');

  const saved = timingRowToDto(timingRow);
  const effCamera = input.cameraBearing ?? spot.camera_bearing;

  // 先合并条件覆盖，再按"新机位朝向 + 光位角"重推方位角约束
  let effective = mergeTiming(saved, input.timing);
  const az = deriveAzimuth(input.timing, saved, spot.camera_bearing, effCamera, input.lightBearingDeg);
  effective = { ...effective, azimuthRange: az.azimuthRange };

  const days = Math.min(16, Math.max(1, input.days ?? 7));
  const now = new Date();
  const todayKey = localDateKey(now, spot.tz);

  // 天气：读共享缓存（服务端内部），假设天气只作用于内存副本
  const realForecast = await getForecast(spot.lat, spot.lng, days);
  const forecast = applyWeatherOverride(realForecast, input.weatherOverride);
  const degraded = forecast.length === 0;

  const results: RehearsalDayDto[] = [];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(todayKey, i);
    // 机位朝向覆盖只影响本次演算用的几何副本，数据库里的机位不动
    const r = computeDay({ ...spot, camera_bearing: effCamera }, effective, key, forecast);
    results.push({
      date: r.date,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      anchorAt: r.anchorAt.toISOString(),
      sunElevation: r.sunElevation,
      sunAzimuth: r.sunAzimuth,
      verdict: r.verdict,
      reasons: r.reasons,
      episode: r.episode ? (r.episode as unknown as Record<string, unknown>) : null,
      weatherDegraded: r.episode?.degraded ?? true,
    });
  }

  // 溯源指纹：把"结论"绑定到全部输入（生效条件 + 机位朝向 + 假设天气 + 逐日天气剧集）。
  // 指纹相同 ⇒ 输入相同 ⇒ 任何人重算都应得到相同结论。
  const inputHash = rehearsalHash({
    effectiveTiming: effective,
    cameraBearing: effCamera,
    lightBearingDeg: az.lightBearingDeg,
    weatherOverride: input.weatherOverride ?? null,
    weatherProvider: config.weatherProvider,
    dates: results.map((r) => r.date),
    episodes: results.map((r) => r.episode),
  });

  return {
    days: results,
    provenance: {
      inspirationId: inspiration.id,
      spotId: spot.id,
      tz: spot.tz,
      effectiveTiming: effective,
      cameraBearing: effCamera,
      lightBearingDeg: az.lightBearingDeg,
      derivedAzimuth: az.derivedAzimuth,
      weather: {
        provider: config.weatherProvider,
        degraded,
        override: input.weatherOverride ?? null,
      },
      inputHash,
      computedAt: now.toISOString(),
      persisted: false,
    },
  };
}
