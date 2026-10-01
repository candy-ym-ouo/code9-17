import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 光线预演台（POST /api/inspirations/:id/rehearsal）：
 * ① 改动太阳事件 / 云量 / 能见度 / 机位朝向 → 即时重判；
 * ② 派生结论可溯源（完整生效输入 + 输入指纹，指纹同则结论可复算）；
 * ③ 旧分享、缓存、未授权坐标不外泄（不落库、no-store、响应无坐标、越权拦截）。
 */

let app: Express;
let token = '';
let cardId = '';
let spotId = '';
let tmpDir = '';
/** 日落前 40 分钟的真实太阳方位角（按 fixture 坐标动态算，避免季节漂移） */
let azCenter = 0;
/** 已保存条件隐含的光位角 = 方位角中心 − 机位朝向 */
let impliedLight = 0;

const SPOT = { lat: 31.2471, lng: 121.4462, cameraBearing: 265 };
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;
const TIMING = {
  timeAnchor: 'sunset_minus',
  anchorOffsetMin: 40,
  elevationRange: [-10, 20],
  azimuthRange: [0, 0] as number[], // beforeAll 中按真实太阳位置填入
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 0, max: 30 }, visibilityKmMin: 10 },
  seasonWindow: null,
  notes: null,
};

function call(method: 'get' | 'post' | 'put', url: string, body?: unknown, authToken?: string) {
  let req = request(app)[method](url);
  const t = authToken === undefined ? token : authToken;
  if (t) req = req.set('authorization', `Bearer ${t}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

const rehearse = (body: unknown, authToken?: string) =>
  call('post', `/api/inspirations/${cardId}/rehearsal`, body ?? {}, authToken);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-rehearsal-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  // 用共享天文库算出"日落前 40 分钟"的真实太阳方位角，让方位角约束可命中
  const { sunEvents, resolveAnchor, solarPosition, localDateKey } = await import('@flil/shared');
  const tz = 'Asia/Shanghai';
  const events = sunEvents(SPOT.lat, SPOT.lng, tz, localDateKey(new Date(), tz));
  const resolved = resolveAnchor(events, { timeAnchor: 'sunset_minus', anchorOffsetMin: 40 });
  if (!resolved) throw new Error('测试环境无法解析锚点');
  azCenter = Math.round(solarPosition(resolved.anchorAt, SPOT.lat, SPOT.lng).azimuthDeg);
  impliedLight = norm360(azCenter - SPOT.cameraBearing);
  TIMING.azimuthRange = [azCenter, azCenter];

  const reg = await call('post', '/api/auth/register', {
    email: 'rehearsal@test.local',
    password: 'password123',
    displayName: '预演测试',
  });
  token = reg.body.token;

  const place = await call('post', '/api/places', { name: '预演机位点', city: '上海' });
  const spot = await call('post', '/api/spots', { placeId: place.body.id, ...SPOT });
  spotId = spot.body.id;

  const card = await call('post', '/api/inspirations', { title: '预演测试卡' });
  cardId = card.body.id;
  await call('post', `/api/inspirations/${cardId}/spot`, { spotId });
  const saved = await call('put', `/api/inspirations/${cardId}/timing`, TIMING);
  expect(saved.status).toBe(200);
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('① 即时重判：改动太阳事件 / 云量 / 能见度 / 机位朝向', () => {
  it('默认预演：7 天逐日判定，每天带逐项理由与天气剧集', async () => {
    const res = await rehearse({});
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(7);
    for (const d of res.body.days) {
      expect(['good', 'marginal', 'bad']).toContain(d.verdict);
      expect(d.reasons.length).toBeGreaterThan(2);
      expect(d.reasons.some((r: { code: string }) => r.code === 'ANCHOR_RESOLVED')).toBe(true);
      expect(d.episode).toBeTruthy();
      expect(typeof d.episode.avgCloudCoverPct).toBe('number');
    }
    // 响应禁止缓存：派生结论不得被任何共享/浏览器缓存留存
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('改机位朝向 → 期望方位角同步重推，结论即时变化', async () => {
    const base = await rehearse({});
    const turned = await rehearse({ cameraBearing: 90 });
    expect(turned.status).toBe(200);
    // 光位角保持不变：期望方位角 = 新机位朝向 + 隐含光位角
    expect(base.body.provenance.derivedAzimuth).toBe(azCenter);
    expect(turned.body.provenance.cameraBearing).toBe(90);
    expect(turned.body.provenance.derivedAzimuth).toBe(Math.round(norm360(90 + impliedLight)));
    expect(turned.body.provenance.inputHash).not.toBe(base.body.provenance.inputHash);
    // 机位原值不被预演改动
    const detail = await call('get', `/api/inspirations/${cardId}`);
    expect(detail.body.item.spot.cameraBearing).toBe(265);
  });

  it('改太阳事件 → 锚点重解析，指纹变化', async () => {
    const base = await rehearse({});
    const sunrise = await rehearse({ timing: { timeAnchor: 'sunrise', anchorOffsetMin: 0 } });
    expect(sunrise.status).toBe(200);
    expect(sunrise.body.provenance.effectiveTiming.timeAnchor).toBe('sunrise');
    expect(sunrise.body.provenance.inputHash).not.toBe(base.body.provenance.inputHash);
    expect(sunrise.body.days[0].anchorAt).not.toBe(base.body.days[0].anchorAt);
  });

  it('假设云量 → 只作用于本次演算（云量 100% 进入理由）', async () => {
    const res = await rehearse({ weatherOverride: { cloudCoverPct: 100 } });
    expect(res.status).toBe(200);
    for (const d of res.body.days) {
      expect(d.episode.avgCloudCoverPct).toBe(100);
      expect(d.reasons.some((r: { text: string }) => r.text.includes('云量 100%'))).toBe(true);
    }
    expect(res.body.provenance.weather.override).toEqual({ cloudCoverPct: 100 });
  });

  it('假设能见度 → 能见度下限判定使用假设值', async () => {
    const res = await rehearse({ weatherOverride: { visibilityKm: 0.5 } });
    expect(res.status).toBe(200);
    for (const d of res.body.days) {
      expect(d.episode.minVisibilityKm).toBe(0.5);
      expect(d.reasons.some((r: { text: string }) => r.text.includes('能见度 0.5 km'))).toBe(true);
    }
  });

  it('显式清除光位约束（azimuthRange: null）→ 不再约束方位角', async () => {
    const res = await rehearse({ timing: { azimuthRange: null } });
    expect(res.status).toBe(200);
    expect(res.body.provenance.derivedAzimuth).toBeNull();
    expect(res.body.provenance.effectiveTiming.azimuthRange).toBeNull();
  });
});

describe('② 派生结论可溯源', () => {
  it('溯源块包含完整生效输入与指纹', async () => {
    const res = await rehearse({ cameraBearing: 300 });
    const p = res.body.provenance;
    expect(p.persisted).toBe(false);
    expect(p.spotId).toBe(spotId);
    expect(p.cameraBearing).toBe(300);
    expect(p.lightBearingDeg).toBeCloseTo(impliedLight, 5);
    expect(p.derivedAzimuth).toBe(Math.round(norm360(300 + impliedLight)));
    expect(p.weather.provider).toBe('fixture');
    expect(typeof p.inputHash).toBe('string');
    expect(p.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p.effectiveTiming.timeAnchor).toBe('sunset_minus');
  });

  it('相同输入 ⇒ 相同指纹（结论可复算）；不同输入 ⇒ 不同指纹', async () => {
    const a1 = await rehearse({ weatherOverride: { cloudCoverPct: 55 } });
    const a2 = await rehearse({ weatherOverride: { cloudCoverPct: 55 } });
    const b = await rehearse({ weatherOverride: { cloudCoverPct: 56 } });
    expect(a1.body.provenance.inputHash).toBe(a2.body.provenance.inputHash);
    expect(b.body.provenance.inputHash).not.toBe(a1.body.provenance.inputHash);
  });

  it('每条理由都是"实际值 vs 目标值"，可人工复算', async () => {
    const res = await rehearse({});
    const texts = res.body.days.flatMap((d: { reasons: { text: string }[] }) =>
      d.reasons.map((r) => r.text),
    );
    expect(texts.some((t: string) => /云量 \d+(\.\d+)?%（目标 0%–30%）/.test(t))).toBe(true);
    expect(texts.some((t: string) => /能见度 \d+(\.\d+)? km（下限 10）/.test(t))).toBe(true);
  });
});

describe('③ 旧分享 / 缓存 / 未授权坐标不外泄', () => {
  it('预演不落库：已算窗口与已保存条件原样不动', async () => {
    await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    const before = await call('get', `/api/inspirations/${cardId}/windows?days=7`);
    expect(before.body.items.length).toBeGreaterThan(0);

    // 一顿猛烈的预演操作
    await rehearse({ cameraBearing: 10, weatherOverride: { cloudCoverPct: 100, visibilityKm: 0.1 } });
    await rehearse({ timing: { timeAnchor: 'night' } });

    const after = await call('get', `/api/inspirations/${cardId}/windows?days=7`);
    expect(after.body.items).toEqual(before.body.items);

    const timing = await call('get', `/api/inspirations/${cardId}/timing`);
    expect(timing.body.item.timeAnchor).toBe('sunset_minus');
    expect(timing.body.item.azimuthRange).toEqual([azCenter, azCenter]);
  });

  it('响应不含任何坐标（精确/模糊都没有），即使 owner 调用', async () => {
    const res = await rehearse({ cameraBearing: 90 });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(String(SPOT.lat));
    expect(raw).not.toContain(String(SPOT.lng));
    expect(raw).not.toContain('"lat"');
    expect(raw).not.toContain('"lng"');
    expect(raw).not.toContain('geohash');
    expect(raw).not.toContain('precise');
  });

  it('未登录 401；他库用户 403', async () => {
    const anon = await rehearse({}, '');
    expect(anon.status).toBe(401);

    const other = await call('post', '/api/auth/register', {
      email: 'outsider@test.local',
      password: 'password123',
      displayName: '外人',
    });
    const forbidden = await rehearse({}, other.body.token);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('LIBRARY_SCOPE_DENIED');
  });

  it('旧分享内容不受预演影响（撤销前快照语义不变）', async () => {
    const link = await call('post', '/api/share-links', {
      scope: 'inspiration',
      scopeId: cardId,
      fuzzLevel: 'g500',
      expiresInDays: 7,
    });
    expect(link.status).toBe(201);
    const shareUrl = `/api/share/${link.body.token}`;

    const before = await request(app).get(shareUrl);
    expect(before.status).toBe(200);

    await rehearse({ cameraBearing: 45, weatherOverride: { cloudCoverPct: 0 } });
    await rehearse({ timing: { timeAnchor: 'solar_noon' } });

    const after = await request(app).get(shareUrl);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    // 分享视图本身也不含坐标精度字段
    expect(JSON.stringify(after.body)).not.toContain('precise');
  });

  it('天气缓存不被假设天气污染：预演假设云量后，正式窗口仍用真实预报', async () => {
    await rehearse({ weatherOverride: { cloudCoverPct: 100 } });
    const res = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    expect(res.status).toBe(200);
    // fixture 预报的云量不可能是 100（晴/薄云/阴雨三态峰值为 88）
    for (const w of res.body.items) {
      const cloudReason = w.reasons.find((r: { code: string }) => r.code.startsWith('CLOUD'));
      if (cloudReason) expect(cloudReason.text).not.toContain('云量 100%');
    }
  });
});
