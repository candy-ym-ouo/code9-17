import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Card,
  Col,
  Descriptions,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  TIME_ANCHOR_LABEL,
  TIME_ANCHORS,
  type LightPreviewRequest,
  type TimingDto,
} from '@flil/shared';
import { useLightPreview } from '../api/hooks.js';
import { VERDICT_META, fmtTime, weekday } from '../lib/format.js';

interface Props {
  inspirationId: string;
  /** 已保存条件（作为试算基线）；没有时用内置默认 */
  baseTiming: TimingDto | null;
  /** 库内机位的真实朝向（旋钮初始值）；坐标永远不进前端请求体 */
  cameraBearing: number;
  /** 最近一次光位标注箭头（可选） */
  lightBearingHint?: number | null;
  tz: string;
}

const FALLBACK_TIMING: TimingDto = {
  timeAnchor: 'sunset_minus',
  anchorOffsetMin: 40,
  elevationRange: [-4, 10],
  azimuthRange: null,
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  weatherProfile: { precipProbPctMax: 20, hardRequirements: ['precipProbPctMax'] },
  seasonWindow: null,
  notes: null,
};

/**
 * 光线预演台：太阳事件 / 云量 / 能见度 / 机位朝向 四个旋钮，改动即重判。
 * 纯试算、不落库、不改分享、坐标只由服务端按卡片机位解析。
 */
export function LightPreviewConsole({ inspirationId, baseTiming, cameraBearing, lightBearingHint, tz }: Props) {
  const base = baseTiming ?? FALLBACK_TIMING;

  const [timeAnchor, setTimeAnchor] = useState<TimingDto['timeAnchor']>(base.timeAnchor);
  const [anchorOffsetMin, setAnchorOffsetMin] = useState(base.anchorOffsetMin);
  const [cloudMin, setCloudMin] = useState(base.weatherProfile.cloudCoverPct?.min ?? 0);
  const [cloudMax, setCloudMax] = useState(base.weatherProfile.cloudCoverPct?.max ?? 100);
  const [visibilityKmMin, setVisibilityKmMin] = useState(base.weatherProfile.visibilityKmMin ?? 8);
  const [bearing, setBearing] = useState(cameraBearing);
  const [useLightHint, setUseLightHint] = useState(lightBearingHint !== null && lightBearingHint !== undefined);

  // 基础条件或机位切换时把旋钮复位到新基线
  const resetKey = `${base.timeAnchor}|${base.anchorOffsetMin}|${cameraBearing}|${baseTiming ? 'saved' : 'empty'}`;
  const lastReset = useRef('');
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setTimeAnchor(base.timeAnchor);
    setAnchorOffsetMin(base.anchorOffsetMin);
    setCloudMin(base.weatherProfile.cloudCoverPct?.min ?? 0);
    setCloudMax(base.weatherProfile.cloudCoverPct?.max ?? 100);
    setVisibilityKmMin(base.weatherProfile.visibilityKmMin ?? 8);
    setBearing(cameraBearing);
    setUseLightHint(lightBearingHint !== null && lightBearingHint !== undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // 组装试算入参（旋钮值经 180ms 防抖后才进 queryKey，避免每个按键都打一发请求）
  const [debounced, setDebounced] = useState({ timeAnchor, anchorOffsetMin, cloudMin, cloudMax, visibilityKmMin, bearing, useLightHint });
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced({ timeAnchor, anchorOffsetMin, cloudMin, cloudMax, visibilityKmMin, bearing, useLightHint });
    }, 180);
    return () => clearTimeout(t);
  }, [timeAnchor, anchorOffsetMin, cloudMin, cloudMax, visibilityKmMin, bearing, useLightHint]);

  const request: LightPreviewRequest = useMemo(() => {
    const timing: TimingDto = {
      ...base,
      weatherProfile: { ...base.weatherProfile },
    };
    return {
      timing,
      days: 7,
      override: {
        timeAnchor: debounced.timeAnchor,
        anchorOffsetMin: debounced.anchorOffsetMin,
        cloudCoverPct: { min: debounced.cloudMin, max: debounced.cloudMax },
        visibilityKmMin: debounced.visibilityKmMin,
        cameraBearing: debounced.bearing,
        lightBearingHint: debounced.useLightHint ? (lightBearingHint ?? null) : null,
      },
    };
  }, [base, debounced, lightBearingHint]);

  const isFetchingKnob =
    timeAnchor !== debounced.timeAnchor ||
    anchorOffsetMin !== debounced.anchorOffsetMin ||
    cloudMin !== debounced.cloudMin ||
    cloudMax !== debounced.cloudMax ||
    visibilityKmMin !== debounced.visibilityKmMin ||
    bearing !== debounced.bearing ||
    useLightHint !== debounced.useLightHint;

  const preview = useLightPreview(inspirationId, request, true);
  const p = preview.data;
  const loading = preview.isFetching || isFetchingKnob;

  return (
    <Row gutter={16} data-testid="light-preview-console">
      <Col xs={24} lg={11}>
        <Card size="small" title="光线预演台 · 拧旋钮即时重判" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <Typography.Text type="secondary">太阳事件（时间锚）</Typography.Text>
              <Space style={{ marginTop: 4 }} wrap>
                <Select
                  style={{ width: 180 }}
                  value={timeAnchor}
                  onChange={(v: TimingDto['timeAnchor']) => setTimeAnchor(v)}
                  options={TIME_ANCHORS.map((a) => ({ value: a, label: TIME_ANCHOR_LABEL[a] }))}
                />
                {timeAnchor === 'sunset_minus' || timeAnchor === 'sunrise_plus' || timeAnchor === 'fixed_clock' ? (
                  <Space>
                    <Typography.Text type="secondary">
                      {timeAnchor === 'fixed_clock' ? '钟点（分钟）' : '偏移（分钟）'}
                    </Typography.Text>
                    <InputNumber
                      min={0}
                      max={timeAnchor === 'fixed_clock' ? 1439 : 240}
                      value={anchorOffsetMin}
                      onChange={(v) => setAnchorOffsetMin(Number(v ?? 0))}
                    />
                  </Space>
                ) : null}
              </Space>
            </div>

            <div>
              <Typography.Text type="secondary">云量目标区间 %</Typography.Text>
              <Space style={{ marginTop: 4 }}>
                <InputNumber min={0} max={100} value={cloudMin} onChange={(v) => setCloudMin(Number(v ?? 0))} />
                <Typography.Text>–</Typography.Text>
                <InputNumber min={0} max={100} value={cloudMax} onChange={(v) => setCloudMax(Number(v ?? 100))} />
              </Space>
            </div>

            <div>
              <Typography.Text type="secondary">能见度下限 km</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <InputNumber
                  min={0}
                  max={50}
                  value={visibilityKmMin}
                  onChange={(v) => setVisibilityKmMin(Number(v ?? 0))}
                />
              </div>
            </div>

            <div>
              <Typography.Text type="secondary">机位朝向 °（试算，不保存）</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <InputNumber min={0} max={360} value={bearing} onChange={(v) => setBearing(Number(v ?? 0))} />
              </div>
              {lightBearingHint !== null && lightBearingHint !== undefined ? (
                <Space style={{ marginTop: 6 }}>
                  <Switch size="small" checked={useLightHint} onChange={setUseLightHint} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    用光位箭头 {Math.round(lightBearingHint)}° 派生期望太阳方位角（机位朝向 + 光位角）
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  未画光位箭头时，沿用保存条件里的期望方位角。
                </Typography.Text>
              )}
            </div>

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {loading ? '正在按最新旋钮重判…' : '旋钮改动会自动重判，无需点按钮；全程只试算，不改动已保存条件。'}
            </Typography.Text>
          </Space>
        </Card>

        <Card size="small" title="结论溯源（每个量都能回推到输入）">
          {p ? (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="试算序号">#{p.evalId}</Descriptions.Item>
              <Descriptions.Item label="实际使用时间锚">
                {TIME_ANCHOR_LABEL[p.input.timeAnchor]}（偏移 {p.input.anchorOffsetMin} 分）
              </Descriptions.Item>
              <Descriptions.Item label="实际云量目标">
                {p.input.weatherProfile.cloudCoverPct?.min ?? 0}%–{p.input.weatherProfile.cloudCoverPct?.max ?? 100}%
              </Descriptions.Item>
              <Descriptions.Item label="实际能见度下限">
                {p.input.weatherProfile.visibilityKmMin ?? 0} km
              </Descriptions.Item>
              <Descriptions.Item label="实际机位朝向">{p.input.cameraBearing}°</Descriptions.Item>
              <Descriptions.Item label="期望太阳方位角">
                {p.input.azimuthRange
                  ? `${p.input.azimuthRange[0]}°±${p.input.azimuthTolerance}°（${
                      p.input.azimuthSource === 'camera_bearing_plus_light' ? '由机位朝向+光位角派生' : '沿用手填'
                    }）`
                  : '不约束'}
              </Descriptions.Item>
              {p.derivations.map((d) => (
                <Descriptions.Item key={d.key} label="派生公式">
                  <code style={{ fontSize: 12 }}>{d.formula}</code> = {String(d.result)}
                </Descriptions.Item>
              ))}
            </Descriptions>
          ) : (
            <Typography.Text type="secondary">调整任意旋钮后，这里会列出真正参与计算的输入。</Typography.Text>
          )}
          <Alert
            style={{ marginTop: 10 }}
            type="info"
            showIcon
            message={
              p
                ? `天气来源：${p.forecast.provider === 'off' ? '纯天文降级' : p.forecast.provider} · ${
                    p.forecast.cacheHit ? `命中缓存（抓取于 ${p.forecast.ageMin ?? '?'} 分钟前 / TTL ${p.forecast.ttlMin} 分钟）` : '实时抓取'
                  } · 样本 ${p.forecast.hours} 小时；本次结果未写入数据库、未改动分享链接。`
                : '试算只读天气缓存、不改写缓存，也不触碰分享。'
            }
          />
        </Card>
      </Col>

      <Col xs={24} lg={13}>
        <Card size="small" title="未来 7 天即时判定" extra={loading ? <Tag color="processing">重判中</Tag> : null}>
          {p ? (
            <>
              <Space size="large" style={{ marginBottom: 12 }}>
                <Statistic title="可拍" value={p.counts.good} valueStyle={{ color: VERDICT_META.good.color }} />
                <Statistic title="勉强" value={p.counts.marginal} valueStyle={{ color: VERDICT_META.marginal.color }} />
                <Statistic title="不可拍" value={p.counts.bad} valueStyle={{ color: VERDICT_META.bad.color }} />
              </Space>
              {p.forecast.degraded ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message="天气源不可用：以下判定未含天气，最高只能到「勉强」。"
                />
              ) : null}
              <Space direction="vertical" style={{ width: '100%' }}>
                {p.days.map((d) => {
                  const meta = VERDICT_META[d.verdict];
                  return (
                    <div
                      key={d.date}
                      style={{ border: `1px solid #eee`, borderLeft: `4px solid ${meta.color}`, borderRadius: 8, padding: '8px 10px', background: meta.bg }}
                    >
                      <Space wrap>
                        <Tag color={meta.color} style={{ color: '#fff' }}>{meta.label}</Tag>
                        <strong>{d.date}</strong>
                        <Typography.Text type="secondary">{weekday(d.startAt ?? d.date, tz)}</Typography.Text>
                        {d.startAt ? <span>{fmtTime(d.startAt, tz)} – {fmtTime(d.endAt, tz)}</span> : null}
                        {d.weather && !d.weather.degraded ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            云 {d.weather.avgCloudCoverPct?.toFixed(0) ?? '?'}% · 能见度{' '}
                            {d.weather.minVisibilityKm?.toFixed(1) ?? '?'} km
                          </Typography.Text>
                        ) : null}
                      </Space>
                      <div style={{ marginTop: 4 }}>
                        {d.reasons.slice(0, 4).map((r) => (
                          <div
                            key={`${r.code}-${r.text}`}
                            style={{ fontSize: 12, color: r.level === 'bad' ? '#a8071a' : '#555' }}
                          >
                            {r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : r.level === 'bad' ? '✗' : '·'} {r.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </Space>
            </>
          ) : (
            <Typography.Text type="secondary">拧动左侧旋钮，右侧立即给出逐日判定与逐项理由。</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}
