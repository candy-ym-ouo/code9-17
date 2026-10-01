import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type { RehearsalResponse, TimingDto, TimeAnchor } from '@flil/shared';
import { useMeta, useRehearsal } from '../api/hooks.js';
import { VERDICT_META, fmtTime, weekday } from '../lib/format.js';

interface Props {
  inspirationId: string;
  /** 已保存的条件（预演从这里出发，改动不落库） */
  baseTiming: TimingDto;
  /** 机位当前朝向（度） */
  cameraBearing: number;
  tz: string;
}

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * 光线预演台：改动太阳事件 / 云量 / 能见度 / 机位朝向 → 防抖后即时重判。
 * 每条结论都可展开看逐项理由；溯源面板给出输入指纹，便于复算核对。
 * 纯只读：不保存条件、不改写窗口、不影响分享链接与提醒。
 */
export function RehearsalConsole({ inspirationId, baseTiming, cameraBearing, tz }: Props) {
  const { data: meta } = useMeta();
  const rehearsal = useRehearsal();

  const [timing, setTiming] = useState<TimingDto>(baseTiming);
  const [camera, setCamera] = useState<number>(cameraBearing);
  const [useLight, setUseLight] = useState<boolean>(Boolean(baseTiming.azimuthRange));
  const [lightBearing, setLightBearing] = useState<number>(() =>
    baseTiming.azimuthRange
      ? norm360((baseTiming.azimuthRange[0] + baseTiming.azimuthRange[1]) / 2 - cameraBearing)
      : 0,
  );
  const [simCloud, setSimCloud] = useState(false);
  const [cloudOverride, setCloudOverride] = useState(80);
  const [simVis, setSimVis] = useState(false);
  const [visOverride, setVisOverride] = useState(3);
  const [result, setResult] = useState<RehearsalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 已保存条件变化（例如刚保存了新条件）→ 预演台回到新基线
  useEffect(() => {
    setTiming(baseTiming);
    setCamera(cameraBearing);
    setUseLight(Boolean(baseTiming.azimuthRange));
    setLightBearing(
      baseTiming.azimuthRange
        ? norm360((baseTiming.azimuthRange[0] + baseTiming.azimuthRange[1]) / 2 - cameraBearing)
        : 0,
    );
  }, [baseTiming, cameraBearing]);

  const mutateRef = useRef(rehearsal.mutateAsync);
  mutateRef.current = rehearsal.mutateAsync;

  // 任何输入改动 → 400ms 防抖即时重判（含首次挂载）
  useEffect(() => {
    const timer = setTimeout(() => {
      const weatherOverride =
        simCloud || simVis
          ? {
              ...(simCloud ? { cloudCoverPct: cloudOverride } : {}),
              ...(simVis ? { visibilityKm: visOverride } : {}),
            }
          : null;
      mutateRef
        .current({
          id: inspirationId,
          // 关闭光位约束时显式清掉方位角；开启时由服务端按 机位朝向+光位角 重推
          timing: useLight ? { ...timing, azimuthRange: undefined } : { ...timing, azimuthRange: null },
          cameraBearing: camera,
          lightBearingDeg: useLight ? lightBearing : undefined,
          weatherOverride,
          days: 7,
        })
        .then((res) => {
          setResult(res);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    }, 400);
    return () => clearTimeout(timer);
  }, [inspirationId, timing, camera, useLight, lightBearing, simCloud, cloudOverride, simVis, visOverride]);

  const expectedAzimuth = useMemo(
    () => (useLight ? Math.round(norm360(camera + lightBearing)) : null),
    [useLight, camera, lightBearing],
  );

  function patchTiming(patch: Partial<TimingDto>) {
    setTiming((t) => ({ ...t, ...patch }));
  }

  function patchWeather(patch: Record<string, unknown>) {
    setTiming((t) => ({ ...t, weatherProfile: { ...t.weatherProfile, ...patch } }));
  }

  const p = result?.provenance;

  return (
    <Row gutter={16}>
      <Col xs={24} lg={10}>
        <Card size="small" title="① 太阳事件" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              style={{ width: '100%' }}
              value={timing.timeAnchor}
              onChange={(v: TimeAnchor) => patchTiming({ timeAnchor: v })}
              options={(meta?.timeAnchors ?? []).map((a) => ({ value: a.key, label: a.label }))}
            />
            {timing.timeAnchor === 'sunset_minus' ||
            timing.timeAnchor === 'sunrise_plus' ||
            timing.timeAnchor === 'fixed_clock' ? (
              <Space>
                <Typography.Text type="secondary">
                  {timing.timeAnchor === 'fixed_clock' ? '钟点（分钟数）' : '偏移（分钟）'}
                </Typography.Text>
                <InputNumber
                  min={0}
                  max={timing.timeAnchor === 'fixed_clock' ? 1439 : 240}
                  value={timing.anchorOffsetMin}
                  onChange={(v) => patchTiming({ anchorOffsetMin: Number(v ?? 0) })}
                />
              </Space>
            ) : null}
          </Space>
        </Card>

        <Card size="small" title="② 机位朝向与光位" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space style={{ width: '100%' }}>
              <Typography.Text type="secondary">机位朝向</Typography.Text>
              <Slider style={{ flex: 1, minWidth: 140 }} min={0} max={360} value={camera} onChange={setCamera} />
              <InputNumber min={0} max={360} value={camera} onChange={(v) => setCamera(Number(v ?? 0))} />
            </Space>
            <Space>
              <Switch checked={useLight} onChange={setUseLight} />
              <Typography.Text>约束光位（期望太阳方位角）</Typography.Text>
            </Space>
            {useLight ? (
              <>
                <Space>
                  <Typography.Text type="secondary">光位角（相对机位）</Typography.Text>
                  <InputNumber
                    min={-180}
                    max={180}
                    value={lightBearing}
                    onChange={(v) => setLightBearing(Number(v ?? 0))}
                  />
                  <Typography.Text type="secondary">容差 ±{timing.azimuthTolerance}°</Typography.Text>
                  <Slider
                    style={{ width: 120 }}
                    min={5}
                    max={45}
                    value={timing.azimuthTolerance}
                    onChange={(v) => patchTiming({ azimuthTolerance: v })}
                  />
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  期望太阳方位角 = {Math.round(camera)}° + {Math.round(lightBearing)}° = {expectedAzimuth}°
                </Typography.Text>
              </>
            ) : null}
          </Space>
        </Card>

        <Card size="small" title="③ 云量与能见度">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Typography.Text type="secondary">目标云量 %</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.min ?? 0}
                onChange={(v) =>
                  patchWeather({
                    cloudCoverPct: {
                      min: Number(v ?? 0),
                      max: timing.weatherProfile.cloudCoverPct?.max ?? 100,
                    },
                  })
                }
              />
              <Typography.Text>–</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.max ?? 100}
                onChange={(v) =>
                  patchWeather({
                    cloudCoverPct: {
                      min: timing.weatherProfile.cloudCoverPct?.min ?? 0,
                      max: Number(v ?? 100),
                    },
                  })
                }
              />
            </Space>
            <Space>
              <Typography.Text type="secondary">能见度下限 km</Typography.Text>
              <InputNumber
                min={0}
                max={50}
                value={timing.weatherProfile.visibilityKmMin ?? 8}
                onChange={(v) => patchWeather({ visibilityKmMin: Number(v ?? 8) })}
              />
            </Space>
            <Divider style={{ margin: '8px 0' }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              假设实际天气（只用于本次预演，不写入任何缓存）
            </Typography.Text>
            <Space>
              <Switch checked={simCloud} onChange={setSimCloud} />
              <Typography.Text type="secondary">假设云量</Typography.Text>
              <Slider
                style={{ width: 160 }}
                min={0}
                max={100}
                disabled={!simCloud}
                value={cloudOverride}
                onChange={setCloudOverride}
              />
              <Typography.Text>{simCloud ? `${cloudOverride}%` : '—'}</Typography.Text>
            </Space>
            <Space>
              <Switch checked={simVis} onChange={setSimVis} />
              <Typography.Text type="secondary">假设能见度</Typography.Text>
              <Slider
                style={{ width: 160 }}
                min={0}
                max={50}
                disabled={!simVis}
                value={visOverride}
                onChange={setVisOverride}
              />
              <Typography.Text>{simVis ? `${visOverride} km` : '—'}</Typography.Text>
            </Space>
          </Space>
        </Card>

        <Button
          style={{ marginTop: 12 }}
          onClick={() => {
            setTiming(baseTiming);
            setCamera(cameraBearing);
            setUseLight(Boolean(baseTiming.azimuthRange));
            setSimCloud(false);
            setSimVis(false);
          }}
        >
          回到已保存条件
        </Button>
      </Col>

      <Col xs={24} lg={14}>
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

        <Card size="small" title="预演结论（未来 7 天，逐项理由可溯源）" style={{ marginBottom: 12 }}>
          {!result ? (
            <Typography.Text type="secondary">正在按当前输入试算…</Typography.Text>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              {result.days.map((d) => {
                const metaV = VERDICT_META[d.verdict];
                return (
                  <div
                    key={d.date}
                    style={{
                      border: '1px solid #eee',
                      borderLeft: `4px solid ${metaV.color}`,
                      borderRadius: 8,
                      padding: '8px 12px',
                      background: metaV.bg,
                    }}
                  >
                    <Space wrap>
                      <Tag color={metaV.color} style={{ color: '#fff' }}>
                        {metaV.label}
                      </Tag>
                      <strong>{d.date}</strong>
                      <Typography.Text type="secondary">{weekday(d.startAt, tz)}</Typography.Text>
                      <span>
                        {fmtTime(d.startAt, tz)} – {fmtTime(d.endAt, tz)}
                      </span>
                      {d.weatherDegraded ? <Tag color="orange">未含天气</Tag> : null}
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      {d.reasons.map((r) => (
                        <div
                          key={`${r.code}-${r.text}`}
                          style={{ fontSize: 12, color: r.level === 'bad' ? '#a8071a' : '#555' }}
                        >
                          {r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : r.level === 'bad' ? '✗' : '·'}{' '}
                          {r.text}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </Space>
          )}
        </Card>

        <Card size="small" title="溯源（结论由什么推出）">
          {p ? (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text code>指纹 {p.inputHash}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  相同输入必得相同结论，可按指纹复算核对
                </Typography.Text>
              </Space>
              <Typography.Text style={{ fontSize: 12 }}>
                机位朝向 {Math.round(p.cameraBearing)}°
                {p.derivedAzimuth !== null
                  ? ` · 光位角 ${Math.round(p.lightBearingDeg ?? 0)}° → 期望方位角 ${p.derivedAzimuth}°`
                  : ' · 未约束光位'}
              </Typography.Text>
              <Space wrap>
                <Tag>天气源 {p.weather.provider}</Tag>
                {p.weather.degraded ? <Tag color="orange">天气降级</Tag> : null}
                {p.weather.override?.cloudCoverPct !== undefined ? (
                  <Tag color="purple">假设云量 {p.weather.override.cloudCoverPct}%</Tag>
                ) : null}
                {p.weather.override?.visibilityKm !== undefined ? (
                  <Tag color="purple">假设能见度 {p.weather.override.visibilityKm} km</Tag>
                ) : null}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                本次预演未落库：不影响已保存条件、已算窗口、提醒与已发出的分享链接。
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}
