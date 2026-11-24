import type { WornEquipmentSource } from "../crawler/compact";
import type { NativeActivityLease } from "./native-activity";
import { MAIN_TABS } from "../crawler/detail-tabs";
import type { Listing, ListingPage, RoleDetail } from "../crawler/types";
import { captureIssues, IncompleteCaptureError } from "../crawler/capture-readiness";
import type {
  RoleDiagnosticControl,
  RoleDiagnosticField,
} from "../query-health/role-list-diagnostics";

export const ADAPTER_SCHEMA_VERSION = 1 as const;
export type AccessAdapterMode = "playwright" | "extension-native";
export interface ObservationContext {
  schemaVersion: 1;
  runId: string;
  queryId: string;
  actionId: string | null;
  pageId: string;
  pageGeneration: number;
  browserSessionEpoch: string;
  stopEpoch: number;
  observedAt: string;
  receivedAt: string;
  sourceKind: AccessAdapterMode;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type MarketCategory = "equipment" | "pet" | "pet-gear" | "jewelry" | "yuanshen" | "jade";
export type SemanticTarget =
  | NativeSemanticTarget
  | { kind: "scroll"; deltaY: number; toward?: NativeSemanticTarget };
export type NativeSemanticTarget =
  | { kind: "next-page"; currentPage: number }
  | { kind: "jump-page"; page: number }
  | { kind: "listing-detail"; serverId: string; eid: string }
  | { kind: "return-to-list"; url: string }
  | { kind: "refresh-list"; url: string }
  | { kind: "detail-tab"; name: string }
  | { kind: "detail-subtab"; parent: string; name: string }
  | { kind: "detail-entry"; section: "pet" | "mount" | "child"; index: number; name: string }
  | { kind: "inspect-item"; index: number; name: string; modelId: string; location: string }
  | { kind: "market-entry"; category: MarketCategory }
  | { kind: "market-field"; field: string; value: string }
  | { kind: "market-reset" }
  | { kind: "market-reset-server" }
  | { kind: "market-expand"; panel: "pet-skills" | "equipment-special-skills" }
  | { kind: "market-choice"; panel: string; values: string[] }
  | { kind: "market-submit"; category: MarketCategory }
  | { kind: "market-page"; page: number }
  | { kind: "market-level"; minimum: number; maximum: number; category: MarketCategory }
  | {
      kind: "market-level-handle";
      handle: "minimum" | "maximum";
      value: number;
      category: MarketCategory;
    }
  | { kind: "query" }
  | {
      kind: "query-field";
      field: "price_min" | "price_max" | "level_min" | "level_max";
      value: string;
    }
  | { kind: "sort"; value: string };
export interface ActionPlan extends Pick<
  ObservationContext,
  "runId" | "queryId" | "pageId" | "pageGeneration" | "browserSessionEpoch" | "stopEpoch"
> {
  activity?: NativeActivityLease;
  actionId: string;
  target: SemanticTarget;
  expected:
    | { kind: "page"; page: number }
    | { kind: "detail"; serverId: string; eid: string }
    | { kind: "changed" };
}
/** Chrome binding identities are supplied by the extension worker, never page scripts. */
export interface NativeNavigationDocument {
  pageId: string;
  pageGeneration: number;
  url: string;
  tabId: number;
  windowId: number;
  bindingEpoch: string;
  connectionEpoch: string;
}
/** A local, completed execute receipt; a page's echoed actionId is not this authority. */
export interface NativeNavigationReceipt {
  plan: ActionPlan;
  dispatchedAt: number;
  inputConfirmedAt: number;
  committedAt: number;
  from: NativeNavigationDocument;
  to: NativeNavigationDocument;
  revision: string;
  /** The extension worker's locally owned parent/child relation, checked against the opening receipt. */
  ownedReturn?: {
    openedBy: ActionPlan;
    parent: NativeNavigationDocument;
    child: NativeNavigationDocument;
  };
}
export interface TargetProof {
  actionId: string;
  pageId: string;
  pageGeneration: number;
  targetVersion: string;
  sampledAt: number;
  rect: Rect;
  viewport: {
    width: number;
    height: number;
    dpr: number;
    scrollX: number;
    scrollY: number;
    scale: number;
  };
  semantic: SemanticTarget;
  hit: boolean;
  url: string;
  title: string;
}
export interface NativeMarketForm {
  url: string;
  controls: {
    id: string;
    name: string;
    tag: string;
    type: string;
    label: string;
    value: string;
    visible: boolean;
    options?: { value: string; label: string }[];
  }[];
  menus: {
    id: string;
    tag: string;
    label: string;
    visible: boolean;
    choices: { value: string; label: string; selected: boolean; visible: boolean }[];
  }[];
  buttons: {
    id: string;
    name: string;
    tag: string;
    type: string;
    label: string;
    visible: boolean;
  }[];
  hiddenControls?: { id: string; name: string; value: string }[];
  scripts: string[];
  sliders: {
    id: string;
    label: string;
    start: string;
    end: string;
    grid: number | null;
    step: number | null;
    range: number[] | null;
  }[];
}
export interface PageSnapshot {
  context: ObservationContext;
  url: string;
  title: string;
  revision: string;
  visible: boolean;
  authenticated?: boolean;
  loading: boolean;
  targetObservation?: { actionId: string; rect: Rect };
  viewport?: { width: number; height: number; scrollX: number; scrollY: number; dpr: number };
  access: "normal" | "login" | "verification" | "busy" | "unknown";
  listing?: ListingPage;
  listingCommitted?: boolean;
  listingCommit?: { actionId: string | null; sequence: number };
  detail?: RoleDetail;
  productIdentity?: { serverId: string; eid: string };
  queryArgs?: Record<string, string | number>;
  market?: {
    category: MarketCategory;
    page: number;
    totalPages: number;
    order: string;
    requestOrder?: string;
    expanded?: Record<string, boolean>;
    form?: NativeMarketForm;
    conditions: Record<string, string | number>;
    rows: {
      url: string;
      name: string;
      kindId?: string;
      modelId?: string;
      level?: string;
      description?: string;
    }[];
    committed: boolean;
    commit?: {
      actionId: string;
      queryId: string;
      requestId: string;
      eventId: string;
      startedAt: string;
      completedAt: string;
    };
    empty: boolean;
    config?: Record<string, unknown>;
    menus?: { id: string; choices: { value: string; label: string; selected: boolean }[] }[];
  };
  controls?: {
    tabs: string[];
    subtabs: string[];
    pets: { index: number; name: string }[];
    mounts: { index: number; name: string }[];
    children: { index: number; name: string }[];
    petCount: number | null;
    selectedPet: number | null;
    selectedMount: number | null;
    selectedChild: number | null;
    items: { index: number; name: string; modelId: string; location: string }[];
  };
  valuationSource?: Record<string, unknown>;
  wornEquipment?: WornEquipmentSource;
  productRevision?: string;
  productState?: "selling" | "unavailable" | "unknown";
  marketProduct?: {
    kind: "equipment" | "pet-gear" | "pet";
    observation: Record<string, unknown>;
    directPanel?: boolean;
  };
  petProof?: {
    text: string;
    elements: Record<string, string>[];
    counts: { skills: number; equipment: number; innerSkills: number };
    sections: { skills: boolean; equipment: boolean; innerSkills: boolean };
    declared: { skills: number | null; equipment: number | null; innerSkills: number | null };
    loading: boolean;
  };
  formValues?: Record<string, string>;
  roleQueryControls?: Partial<Record<RoleDiagnosticField, RoleDiagnosticControl>>;
  roleQueryDimensions?: Partial<Record<"server_type" | "serverid", string>>;
  empty: boolean;
  business?: {
    kind: "fetch" | "xhr" | "jsonp";
    endpoint: string;
    status: number;
    success?: boolean;
    count?: number;
    page?: number;
    orderBy?: string;
    observedAt?: string;
    eventId?: string;
    requestId?: string;
    startedAt?: string;
    actionId?: string;
    queryId?: string;
    resultRows?: { eid?: string; serverId?: string; ordersn?: string }[];
    conditions?: Record<string, string | number>;
    denial?: { status: number; msg: string };
    act?: string;
    searchType?: string;
  }[];
}
export interface PageObserver {
  readonly mode: AccessAdapterMode;
  snapshot(pageId?: string): Promise<PageSnapshot>;
  waitFor(
    predicate: (value: PageSnapshot) => boolean,
    options: { pageId: string; after: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<PageSnapshot>;
  evidence(
    pageId: string,
  ): Promise<{ context: ObservationContext; revision: string; snapshot: PageSnapshot }>;
  close(): Promise<void>;
}
export interface UiDriver {
  readonly mode: AccessAdapterMode;
  execute(plan: ActionPlan, signal?: AbortSignal): Promise<PageSnapshot>;
  stop(reason: string): Promise<void>;
}
export class UnsupportedAdapterOperation extends Error {
  readonly code = "UNSUPPORTED_ADAPTER_OPERATION";
  constructor(operation: string) {
    super(`当前访问方式不支持${operation}，已保留进度；请人工定位到相应官网入口`);
    this.name = "UnsupportedAdapterOperation";
  }
}
/** Both transports must call the same pure validator before the ordinary store transaction. */
export function validateObservedCapture(snapshot: PageSnapshot, listing: Listing): RoleDetail {
  if (snapshot.access !== "normal" || !snapshot.detail)
    throw new UnsupportedAdapterOperation("当前详情读取");
  const detail = snapshot.detail;
  const issues = captureIssues(detail, true, true, listing);
  for (const name of MAIN_TABS)
    if (!detail.tabs.some((tab) => tab.name === name)) issues.push(`缺少角色主标签：${name}`);
  if (
    snapshot.productIdentity?.serverId !== listing.serverId ||
    snapshot.productIdentity.eid !== listing.eid
  )
    issues.push("详情商品身份与列表不一致");
  if (issues.length)
    throw new IncompleteCaptureError(issues.join("；"), detail, new Error(issues.join("；")));
  return detail;
}
