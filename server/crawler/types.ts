export const DEFAULT_CRAWL_CONCURRENCY = 10;
export type CrawlLane = "new" | "old";
export interface HeadCheckpoint {
  time: string;
  keys: string[];
}

export interface Listing {
  key: string;
  serverId: string;
  serverName?: string;
  serverAge?: "one" | "three" | "older";
  highlights?: string[];
  eid: string;
  ordersn: string;
  url: string;
  sellingTime: string | null;
  createdTime: string | null;
  orderTime: string | null;
  name: string;
  price: string;
  attrs: Record<string, string>;
  summary: unknown;
}
export class ListingChangedError extends Error {
  constructor() {
    super("列表在采集中发生变化，正在按当前列表继续匹配");
    this.name = "ListingChangedError";
  }
}
export class ListingDisappearedError extends ListingChangedError {
  constructor() {
    super();
    this.name = "ListingDisappearedError";
  }
}
export class SellingOrderUnavailableError extends Error {
  constructor() {
    super("网站未提供上架时间倒序，无法持续检查新上架角色");
    this.name = "SellingOrderUnavailableError";
  }
}
export interface ListingPage {
  page: number;
  totalPages: number;
  order: string;
  items: Listing[];
}
export interface CrawlSource {
  prepare: (order?: string) => Promise<ListingPage>;
  page: (number: number) => Promise<ListingPage>;
  onShelf: (item: Listing) => Promise<boolean>;
  hover: (item: Listing) => Promise<Listing>;
  detail: (item: Listing) => Promise<RoleDetail>;
}
export interface TabSnapshot {
  collectedAt?: string;
  itemsCollectedAt?: string;
  name: string;
  text: string;
  fields: { name: string; value: string }[];
  tables: string[][][];
  elements: Record<string, string>[];
  tooltips: string[];
  items?: DetailItem[];
  pets?: PetSnapshot[];
  petCount?: number;
  equipmentEmptyProof?: "official-containers";
  equipmentContainers?: Array<{
    id: string;
    present: boolean;
    visible: boolean;
    icons: Array<{ name: string; modelId: string }>;
  }>;
}
export interface PetSnapshot {
  index: number;
  name: string;
  fields: { name: string; value: string }[];
  skills: DetailItem[];
  equipment: DetailItem[];
  innerSkills: DetailItem[];
}
export interface DetailItem {
  index: number;
  name: string;
  description?: string;
  attributes?: Record<string, string>;
  tooltip?: string;
  kind?: "skill" | "equipment" | "innerSkill";
  category?: string;
  kindId?: string;
  /** Original official data_equip_type model number, not a search category ID. */
  modelId?: string;
  categoryConfirmation?: {
    source: "user";
    category: string;
    confirmedAt: string;
  };
  categoryEvidence?: {
    version: 1;
    modelId: string;
    name: string;
    category: string;
    roleKey: string;
    location: string;
    collectedAt: string;
  };
  location?: string;
  level?: string;
  skillObservation?: {
    rawName: string;
    id?: string;
    type: string;
    section?: string;
    state: "current" | "future" | "conditional" | "unknown";
  };
}
export interface ValuationCapture {
  version: 1;
  fields: { name: string; value: string; tab: string }[];
  issues: string[];
  source: Record<string, unknown>;
}
export interface RoleDetail {
  /** Legacy body-only captures require full recapture before reuse. */
  captureMode?: "body" | "all";
  valuation?: ValuationCapture;
  equipmentCapture?: {
    version: 1;
    collectedAt: string;
    complete: boolean;
    issues: string[];
    emptyProof?: "official-containers" | "explicit-text";
  };
  petCapture?: {
    version: 1;
    collectedAt: string;
    complete: boolean;
    issues: string[];
  };

  formatVersion?: number;
  captureVersion?: number;
  url: string;
  collectedAt: string;
  tabs: TabSnapshot[];
  raw: Record<string, unknown>;
}
export interface SavedRoleRecord {
  listing: Listing;
  detail: RoleDetail | null;
  status: "pending" | "complete" | "failed";
  error: string | null;
}
export interface Checkpoint {
  key: string;
  time: string | null;
  order: string;
  page: number;
  savedAt: string;
}
export interface CrawlStatus {
  roleLimit?: number;
  totalRoles?: number;
  concurrency?: number;
  newRunning?: number;
  oldRunning?: number;
  newQueued?: number;
  oldQueued?: number;
  newLimit?: number;
  oldLimit?: number;
  headCheckedAt?: string;
  nextHeadCheckAt?: string;
  headPage?: number;
  historyPage?: number;
  includeAssets?: boolean;
  running: boolean;
  phase: "idle" | "locating" | "retrying" | "collecting" | "paused" | "completed" | "error";
  message: string;
  page: number;
  totalPages: number;
  saved: number;
  skipped: number;
  failed?: number;
  retryTotal?: number;
  retryCompleted?: number;
  lastItemError?: string;
  totalSaved: number;
  current?: string;
  itemIndex?: number;
  itemsOnPage?: number;
  detailProgress?: string;
  checkpoint?: Checkpoint;
  strategy?: string;
  error?: string;
  database: string;
}

export type SavedListingScope = "all" | "complete" | "tasks";

export interface SavedListingPage {
  scope?: SavedListingScope;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: {
    key: string;
    name: string;
    price: string;
    url: string;
    serverId: string;
    serverName: string;
    highlights: string[];
    sellingTime: string | null;
    collectedAt: string | null;
    lastSeenAt: string;
    lastAttemptAt: string | null;
    attemptCount: number;
    status: string;
    published?: boolean;
    valuationReady?: boolean;
    captureMode?: "body" | "all";
    error: string | null;
  }[];
}
