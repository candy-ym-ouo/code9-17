import type {
  AlbumStatus,
  AnnotationKind,
  AssetRole,
  FuzzLevel,
  GapStatus,
  HitLevel,
  InspirationStatus,
  MissReason,
  PlanStatus,
  ReminderActionKind,
  ReminderStatus,
  TagDomain,
  TagSource,
  TimeAnchor,
  WeatherPhenomenon,
  WindowVerdict,
} from './enums.js';
import type { PaletteColor } from './palette.js';

export interface WeatherProfile {
  cloudCoverPct?: { min: number; max: number };
  precipProbPctMax?: number;
  visibilityKmMin?: number;
  windSpeedMax?: number;
  tempC?: { min: number; max: number };
  phenomena?: WeatherPhenomenon[];
  hardRequirements?: string[];
}

export interface TimingDto {
  timeAnchor: TimeAnchor;
  anchorOffsetMin: number;
  elevationRange: number[];
  azimuthRange: number[] | null;
  azimuthTolerance: number;
  windowToleranceMin: number;
  weatherProfile: WeatherProfile;
  seasonWindow: { fromMonth: number; toMonth: number } | null;
  notes: string | null;
}

export interface WindowReasonDto {
  code: string;
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

export interface ReproWindowDto {
  id: string | null;
  inspirationId: string;
  date: string;
  startAt: string;
  endAt: string;
  anchorAt: string;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  weatherDegraded: boolean;
  stale: boolean;
  computedAt: string | null;
}

// ------------------------------------------------------- 光线预演台（不落库）

/** 预演台允许临时覆盖的输入：只含四类旋钮（太阳事件 / 云量 / 能见度 / 机位朝向）+ 光位角 */
export interface LightPreviewOverride {
  timeAnchor: TimeAnchor;
  anchorOffsetMin: number;
  cloudCoverPct: { min: number; max: number };
  visibilityKmMin: number;
  cameraBearing: number;
  /** 最近一次光位箭头（可选）；给定时期望太阳方位角由机位朝向派生 */
  lightBearingHint: number | null;
}

/** 预演台请求：timing 为待试算条件（不写库），override 是四个旋钮的临时取值 */
export interface LightPreviewRequest {
  timing: TimingDto;
  days?: number;
  override: LightPreviewOverride;
}

/** 预演真正用于计算的输入快照（派生结论的溯源依据，原样回显） */
export interface LightPreviewInputSnapshot {
  timeAnchor: TimeAnchor;
  anchorOffsetMin: number;
  weatherProfile: WeatherProfile;
  cameraBearing: number;
  lightBearingHint: number | null;
  azimuthRange: number[] | null;
  azimuthTolerance: number;
  /** 期望方位角是手写还是由"机位朝向 + 光位角"派生 */
  azimuthSource: 'manual' | 'camera_bearing_plus_light';
}

/** 一条派生关系（结论如何从输入算出来） */
export interface LightPreviewDerivation {
  key: string;
  formula: string;
  inputs: Record<string, number | string | null>;
  result: number | string | null;
}

/** 预演用到的天气数据来源（不含任何坐标，避免经此泄露机位） */
export interface LightPreviewForecastMeta {
  provider: string;
  cached: boolean;
  cacheHit: boolean;
  fetchedAt: string | null;
  ageMin: number | null;
  ttlMin: number;
  degraded: boolean;
  hours: number;
}

export interface LightPreviewDay {
  date: string;
  verdict: WindowVerdict;
  startAt: string | null;
  endAt: string | null;
  anchorAt: string | null;
  sunElevation: number | null;
  sunAzimuth: number | null;
  reasons: WindowReasonDto[];
  /** 该日窗口天气实测摘要（云量/能见度等实际值，供与目标值人工复算） */
  weather: LightPreviewWeather | null;
}

export interface LightPreviewWeather {
  degraded: boolean;
  provider: string;
  avgCloudCoverPct: number | null;
  maxPrecipProbPct: number | null;
  minVisibilityKm: number | null;
  maxWindSpeedMs: number | null;
  avgTempC: number | null;
}

export interface LightPreviewResponse {
  /** 单调序号：与请求入参一一对应，前端据此丢弃乱序到达的旧响应 */
  evalId: number;
  evaluatedAt: string;
  /** 本次计算实际使用的输入（回显，可溯源） */
  input: LightPreviewInputSnapshot;
  /** 派生过程：期望方位角等"算出来的量" */
  derivations: LightPreviewDerivation[];
  days: LightPreviewDay[];
  counts: { good: number; marginal: number; bad: number };
  forecast: LightPreviewForecastMeta;
  /** 本次只试算、不落库，且不触碰分享/缓存的声明 */
  persisted: false;
}

export interface TagDto {
  id: string;
  domain: TagDomain;
  parentId: string | null;
  name: string;
  slug: string;
  isBuiltin: boolean;
  disabled: boolean;
  sortOrder: number;
  usageCount: number;
  children?: TagDto[];
}

export interface PaletteDto extends PaletteColor {}

export interface AssetDto {
  id: string;
  inspirationId: string;
  role: AssetRole;
  width: number;
  height: number;
  shotAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  hasGpsExif: boolean;
  palette: PaletteColor[];
  sunElevation: number | null;
  sunAzimuth: number | null;
  weatherSnapshot: Record<string, unknown> | null;
  fileUrl: string;
  thumbUrl: string;
  createdAt: string;
}

export interface AnnotationDto {
  id: string;
  assetId: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  label: string | null;
}

export interface FuzzResult {
  fuzzLevel: FuzzLevel;
  lat: number | null;
  lng: number | null;
  geohash: string;
  label: string;
}

export interface SpotDto {
  id: string;
  placeId: string;
  placeName: string;
  city: string | null;
  district: string | null;
  tz: string;
  cameraBearing: number;
  elevationM: number | null;
  accessNote: string | null;
  bestTimeNote: string | null;
  visibility: 'private' | 'fuzzy_shared';
  /** 精确坐标：仅 owner 且仅在编辑场景返回 */
  precise: { lat: number; lng: number } | null;
  fuzz: FuzzResult;
}

export interface InspirationDto {
  id: string;
  title: string;
  note: string | null;
  status: InspirationStatus;
  seasonTags: number[];
  hitCount: number;
  partialCount: number;
  missCount: number;
  hitRate: number;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  tags: { id: string; domain: TagDomain; name: string; slug: string; source: TagSource }[];
  assets: AssetDto[];
  spot: SpotDto | null;
  timing: TimingDto | null;
  windowSummary: { nextGoodAt: string | null; goodIn30d: number } | null;
}

export interface ReminderDto {
  id: string;
  subjectType: string;
  subjectId: string;
  ruleCode: string | null;
  title: string;
  body: string | null;
  actionKind: ReminderActionKind;
  actionPayload: Record<string, unknown> | null;
  status: ReminderStatus;
  dueAt: string;
  expireAt: string | null;
  createdAt: string;
}

export interface PlanDto {
  id: string;
  inspirationId: string;
  inspirationTitle: string;
  windowId: string | null;
  plannedAt: string;
  leaveAt: string | null;
  commuteMin: number;
  companions: string | null;
  gearNote: string | null;
  status: PlanStatus;
  cancelReason: string | null;
  result: {
    id: string;
    hitLevel: HitLevel;
    missReasons: MissReason[];
    note: string | null;
    filledAt: string;
  } | null;
}

export interface AlbumGapDto {
  id: string;
  kind: 'tag' | 'anchor' | 'weather' | 'count' | 'result';
  requirement: Record<string, unknown>;
  currentCount: number;
  requiredCount: number;
  isRequired: boolean;
  status: GapStatus;
  waiveReason: string | null;
  actionLabel: string;
  actionHref: string;
}

export interface AlbumDto {
  id: string;
  title: string;
  themeNote: string | null;
  status: AlbumStatus;
  rules: Record<string, unknown>;
  itemCount: number;
  openRequiredGaps: number;
  coverThumbUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface SearchRelaxation {
  field: string;
  from: string;
  to: string;
  note: string;
}

export interface SearchResult {
  items: InspirationDto[];
  total: number;
  relaxed: SearchRelaxation[];
  suggestions?: { tagIds: string[]; tagNames: string[]; message: string } | null;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  libraryId: string;
  role: 'owner' | 'member';
}
