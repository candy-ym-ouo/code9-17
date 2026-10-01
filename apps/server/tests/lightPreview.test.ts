import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import type { LightPreviewRequest, TimingDto } from '@flil/shared';

let app: Express;
let tmpDir = '';
let ownerToken = '';
let otherToken = '';
let cardId = '';
let otherCardId = '';
let shareToken = '';

const TIMING: TimingDto = {
  timeAnchor: 'sunset_minus',
  anchorOffsetMin: 40,
  elevationRange: [-4, 10],
  azimuthRange: [265, 265],
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 20, max: 60 }, visibilityKmMin: 8 },
  seasonWindow: null,
  notes: null,
};

function callFor(token: string) {
  return (method: 'get' | 'post', url: string, body?: unknown) => {
    let req = request(app)[method](url).set('authorization', `Bearer ${token}`);
    if (body !== undefined) req = req.send(body as object);
    return req;
  };
}
const call = (method: 'get' | 'post', url: string, body?: unknown) => callFor(ownerToken)(method, url, body);

function previewBody(over: Partial<LightPreviewRequest['override']> = {}): LightPreviewRequest {
  return {
    timing: TIMING,
    days: 7,
    override: {
      timeAnchor: 'sunset_minus',
      anchorOffsetMin: 40,
      cloudCoverPct: { min: 20, max: 60 },
      visibilityKmMin: 8,
      cameraBearing: 265,
      lightBearingHint: null,
      ...over,
    },
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-preview-'));
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

  // owner 库：卡片 + 机位
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'owner@preview.local', password: 'password123', displayName: '所有者' });
  ownerToken = reg.body.token;

  const place = await call('post', '/api/places', { name: '预演地点', city: '上海' });
  const spot = await call('post', '/api/spots', {
    placeId: place.body.id,
    lat: 31.2471,
    lng: 121.4462,
    cameraBearing: 265,
  });
  const card = await call('post', '/api/inspirations', { title: '预演卡片' });
  cardId = card.body.id;
  await call('post', `/api/inspirations/${cardId}/spot`, { spotId: spot.body.id });

  // 另一个库：不同账号 + 卡片 + 机位，用于越权验证
  const reg2 = await request(app)
    .post('/api/auth/register')
    .send({ email: 'other@preview.local', password: 'password123', displayName: '别人' });
  otherToken = reg2.body.token;
  const place2 = await callFor(otherToken)('post', '/api/places', { name: '别处', city: '北京' });
  const spot2 = await callFor(otherToken)('post', '/api/spots', {
    placeId: place2.body.id,
    lat: 39.9,
    lng: 116.4,
    cameraBearing: 90,
  });
  const card2 = await callFor(otherToken)('post', '/api/inspirations', { title: '别人的卡片' });
  otherCardId = card2.body.id;
  await callFor(otherToken)('post', `/api/inspirations/${otherCardId}/spot`, { spotId: spot2.body.id });

  // 一条分享链接，用于验证预演不影响分享的撤销/过期校验
  const link = await call('post', '/api/share-links', {
    scope: 'inspiration',
    scopeId: cardId,
    fuzzLevel: 'g500',
    expiresInDays: 7,
  });
  shareToken = link.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('光线预演台：即时重判 + 溯源', () => {
  it('返回逐日重判、计数与输入快照，且声明未落库', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.days).toHaveLength(7);
    expect(b.counts.good + b.counts.marginal + b.counts.bad).toBe(7);
    expect(b.persisted).toBe(false);
    expect(b.input.timeAnchor).toBe('sunset_minus');
    expect(b.input.weatherProfile.cloudCoverPct).toEqual({ min: 20, max: 60 });
    expect(b.input.weatherProfile.visibilityKmMin).toBe(8);
    expect(b.input.cameraBearing).toBe(265);
    // 每天都有可复算理由
    for (const d of b.days) expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('改云量/能见度即时改变判定，输入快照同步更新（即时重判）', async () => {
    const loose = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ cloudCoverPct: { min: 0, max: 100 }, visibilityKmMin: 0 }),
    );
    const strict = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ cloudCoverPct: { min: 95, max: 96 }, visibilityKmMin: 40 }),
    );
    expect(strict.body.input.weatherProfile.cloudCoverPct).toEqual({ min: 95, max: 96 });
    expect(strict.body.input.weatherProfile.visibilityKmMin).toBe(40);
    // 极严条件下不可能比宽松条件有更多 good
    expect(strict.body.counts.good).toBeLessThanOrEqual(loose.body.counts.good);
    // 严格条件里应能看到云量/能见度相关的实际值理由（实际值 vs 目标值）
    const texts = strict.body.days.flatMap((d: { reasons: { text: string }[] }) => d.reasons.map((r) => r.text));
    expect(texts.some((t: string) => t.includes('云量'))).toBe(true);
  });

  it('改太阳事件即时重锚，快照反映新锚点', async () => {
    const res = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ timeAnchor: 'sunrise', anchorOffsetMin: 0 }),
    );
    expect(res.body.input.timeAnchor).toBe('sunrise');
    const anchorTexts = res.body.days
      .flatMap((d: { reasons: { code: string }[] }) => d.reasons)
      .some((r: { code: string }) => r.code === 'ANCHOR_RESOLVED');
    expect(anchorTexts).toBe(true);
  });

  it('机位朝向 + 光位角派生期望太阳方位角，给出公式可溯源', async () => {
    const res = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ cameraBearing: 200, lightBearingHint: 90 }),
    );
    expect(res.body.input.azimuthSource).toBe('camera_bearing_plus_light');
    expect(res.body.input.azimuthRange[0]).toBe(290);
    const der = res.body.derivations.find((d: { key: string }) => d.key === 'expected_sun_azimuth');
    expect(der).toBeTruthy();
    expect(der.result).toBe(290);
    expect(der.formula).toContain('cameraBearing');
  });

  it('试算序号按库单调递增（乱序防护依据）', async () => {
    const a = await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    const b = await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    expect(b.body.evalId).toBeGreaterThan(a.body.evalId);
  });

  it('天气来源可溯源：首取实时，再取命中缓存（不延长 TTL）', async () => {
    const fresh = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ visibilityKmMin: 7 }),
    );
    const cached = await call(
      'post',
      `/api/inspirations/${cardId}/light-preview`,
      previewBody({ visibilityKmMin: 6 }),
    );
    // 同坐标同天数（fixture 确定性），第二次命中缓存
    expect(cached.body.forecast.cacheHit).toBe(true);
    expect(cached.body.forecast.ttlMin).toBeGreaterThan(0);
    expect(cached.body.forecast.fetchedAt).toBe(fresh.body.forecast.fetchedAt);
    expect(cached.body.forecast).not.toHaveProperty('lat');
    expect(cached.body.forecast).not.toHaveProperty('lng');
  });
});

describe('光线预演台：不泄露', () => {
  it('响应与错误中不含精确坐标', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('31.2471');
    expect(json).not.toContain('121.4462');
    expect(json).not.toContain('"lat"');
    expect(json).not.toContain('"lng"');
  });

  it('请求体伪造 lat/lng 被整体拒绝（坐标只能由服务端按机位解析）', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/light-preview`, {
      ...previewBody(),
      lat: 1.23,
      lng: 4.56,
    });
    expect(res.status).toBe(400);
  });

  it('未登录被拒（401）', async () => {
    const res = await request(app)
      .post(`/api/inspirations/${cardId}/light-preview`)
      .send(previewBody());
    expect(res.status).toBe(401);
  });

  it('跨库卡片拒绝（不能拿别人的机位算天象）', async () => {
    const res = await callFor(otherToken)('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    expect(res.status).toBe(403);
  });

  it('没有机位的卡片返回 400', async () => {
    const naked = await call('post', '/api/inspirations', { title: '无机位卡' });
    const res = await call('post', `/api/inspirations/${naked.body.id}/light-preview`, previewBody());
    expect(res.status).toBe(400);
  });

  it('预演不落库：不新增窗口、不改已保存条件', async () => {
    const before = await call('get', `/api/inspirations/${cardId}/windows?days=7`);
    await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody({ visibilityKmMin: 3 }));
    const after = await call('get', `/api/inspirations/${cardId}/windows?days=7`);
    expect(after.body.items.length).toBe(before.body.items.length);
    const detail = await call('get', `/api/inspirations/${cardId}`);
    // 卡片未保存过 timing，预演不应凭空创建
    expect(detail.body.item.timing).toBeNull();
  });

  it('预演不触碰分享：分享链接依旧可访问；撤销后即时失效', async () => {
    await call('post', `/api/inspirations/${cardId}/light-preview`, previewBody());
    const okView = await request(app).get(`/api/share/${shareToken}`);
    expect(okView.status).toBe(200);
    // 公开分享视图里只有模糊坐标（geohash 网格中心），精确机位坐标不出现
    const fuzz = okView.body.item.fuzz;
    expect(fuzz.lat).not.toBe(31.2471);
    expect(fuzz.lng).not.toBe(121.4462);
    expect(fuzz.fuzzLevel).toBe('g500');

    const links = await call('get', '/api/share-links');
    const linkId = links.body.items.find((l: { token: string }) => l.token === shareToken).id;
    await call('post', `/api/share-links/${linkId}/revoke`, {});
    const revoked = await request(app).get(`/api/share/${shareToken}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('SHARE_REVOKED');
  });
});
