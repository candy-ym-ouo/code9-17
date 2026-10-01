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

// ------------------------------------------------------------ 光线预演台
// 预演 = 只读试算：改动太阳事件 / 云量 / 能见度 / 机位朝向后即时重判，
// 不落库、不改写窗口、不影响分享与提醒；结论携带完整溯源信息。

/** 假设天气：把"实际云量/能见度"替换为假设值（仅内存演算，绝不写入缓存） */
export interface RehearsalWeatherOverride {
  cloudCoverPct?: number;
  visibilityKm?: number;
}

export interface RehearsalRequest {
  /** 条件覆盖（在已保存条件上合并）；缺省字段沿用已保存值 */
  timing?: Partial<TimingDto>;
  /** 机位朝向覆盖（度）；缺省用机位原值 */
  cameraBearing?: number;
  /** 光位角（相对机位朝向，度）；与机位朝向一起推出期望太阳方位角 */
  lightBearingDeg?: number | null;
  /** 假设实际天气（预演"如果那天云量是 X"） */
  weatherOverride?: RehearsalWeatherOverride | null;
  days?: number;
}

export interface RehearsalDayDto {
  date: string;
  startAt: string;
  endAt: string;
  anchorAt: string;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  episode: Record<string, unknown> | null;
  weatherDegraded: boolean;
}

/** 溯源信息：结论由哪些输入推出。inputHash 相同 ⇒ 输入相同 ⇒ 结论可复算 */
export interface RehearsalProvenance {
  inspirationId: string;
  spotId: string;
  tz: string;
  /** 合并后的完整生效条件 */
  effectiveTiming: TimingDto;
  cameraBearing: number;
  lightBearingDeg: number | null;
  /** 由机位朝向 + 光位角推出的期望太阳方位角（无约束时为 null） */
  derivedAzimuth: number | null;
  weather: {
    provider: string;
    degraded: boolean;
    override: RehearsalWeatherOverride | null;
  };
  /** 输入指纹（sha256 截断）：覆盖条件 + 机位朝向 + 假设天气 + 逐日天气剧集 */
  inputHash: string;
  computedAt: string;
  /** 恒为 false：预演绝不落库 */
  persisted: false;
}

export interface RehearsalResponse {
  days: RehearsalDayDto[];
  provenance: RehearsalProvenance;
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
