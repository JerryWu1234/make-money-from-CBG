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
export interface ListingPage {
  page: number;
  totalPages: number;
  order: string;
  items: Listing[];
}
export interface CrawlSource {
  prepare: () => Promise<ListingPage>;
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
  location?: string;
  level?: string;
}
export interface ValuationCapture {
  version: 1;
  fields: { name: string; value: string; tab: string }[];
  issues: string[];
  source: Record<string, unknown>;
}
export interface RoleDetail {
  valuation?: ValuationCapture;
  equipmentCapture?: {
    version: 1;
    collectedAt: string;
    complete: boolean;
    issues: string[];
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

export interface SavedListingPage {
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
    valuationReady?: boolean;
    error: string | null;
  }[];
}
