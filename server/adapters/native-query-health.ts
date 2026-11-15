import { withNativeWorkflow } from "./native-workflow";
import type { AccessContext, AccessGovernor, CrawlLease, OwnerFence } from "../access";
import type { CrawlSource, Listing, ListingPage } from "../crawler/types";
import {
  beginObservedQuery,
  bindQuerySubject,
  finishObservedQuery,
  moveObservedQuery,
  querySubjectContext,
} from "../query-health/runtime";
import {
  type NativeNavigationReceipt,
  type NativeNavigationDocument,
  type PageSnapshot,
  UnsupportedAdapterOperation,
} from "./contracts";
import type { ExtensionNativeRuntime } from "./extension-native";
import {
  createRoleListDiagnostic,
  type RoleDiagnosticSnapshot,
} from "../query-health/role-list-diagnostics";
import { queryIdentityHash, type QueryRecord } from "../query-health/store";

interface PendingListing {
  subject: object;
  query: QueryRecord | undefined;
  context: AccessContext;
  fromUrl: string;
  observationOnly: boolean;
}

/** The same health store and business fences are used by both transport adapters. */
export function bindNativeCrawlSource(
  adapter: ExtensionNativeRuntime,
  governor: AccessGovernor,
  owner: OwnerFence,
  signal: AbortSignal,
  crawlLease: CrawlLease,
  initialSnapshot: PageSnapshot,
) {
  const raw = adapter.createCrawlSource(signal);
  const subjects = new Map<string, object>();
  let current: AccessContext | undefined;
  let currentSubject: object | undefined;
  const subjectFor = (snapshot: PageSnapshot) => {
    let subject = subjects.get(snapshot.context.pageId);
    if (!subject) {
      subject = {};
      subjects.set(snapshot.context.pageId, subject);
    }
    const prior = querySubjectContext(subject);
    const context: AccessContext = {
      ...owner,
      ...snapshot.context,
      actionId: snapshot.context.actionId || undefined,
      sourceKind: "extension-native-crawl",
      crawlLease: { ...crawlLease },
    };
    if (
      !prior ||
      prior.pageGeneration !== context.pageGeneration ||
      prior.browserSessionEpoch !== context.browserSessionEpoch ||
      prior.runId !== context.runId ||
      prior.stopEpoch !== context.stopEpoch
    ) {
      governor.registerPage(context);
      bindQuerySubject(subject, governor, context);
    }
    return subject;
  };
  // Retry dispatch precedes list preparation. This is a live activity identity,
  // without claiming that the initial page query has already been accepted.
  currentSubject = subjectFor(initialSnapshot);
  current = querySubjectContext(currentSubject);
  let lastListingSnapshot = initialSnapshot.listing ? initialSnapshot : undefined;
  const listIdentity = (snapshot: PageSnapshot, page: number, sort: string) => {
    const queryArgs = snapshot.queryArgs;
    if (!queryArgs) throw new UnsupportedAdapterOperation("缺少官网实际条件身份的列表查询");
    return {
      category: "role",
      server: String(queryArgs.serverid || "all"),
      serverAge: String(queryArgs.server_type || ""),
      conditions: Object.fromEntries(
        Object.entries(queryArgs).filter(([key]) => !["page", "order_by"].includes(key)),
      ),
      page,
      sort,
    };
  };
  const beginListing = async (
    operation: "prepare" | "page" | "refresh",
    target?: string | number,
  ): Promise<PendingListing> => {
    const observed = await adapter.snapshot();
    const snapshot = observed.listing ? observed : lastListingSnapshot;
    if (!snapshot?.listing || !snapshot.queryArgs)
      throw new UnsupportedAdapterOperation("缺少官网实际条件身份的列表查询");
    if (
      Number(snapshot.queryArgs.page) !== snapshot.listing.page ||
      String(snapshot.queryArgs.order_by || "") !== snapshot.listing.order
    )
      throw new UnsupportedAdapterOperation("当前条件与角色列表页码或排序不一致");
    if (!observed.listing) {
      // Returning from an owned detail is a distinct observable list query. Its
      // identity is allocated before the return input, then checked before refresh/page.
      const subject = subjectFor(observed);
      const query = beginObservedQuery(
        subject,
        listIdentity(snapshot, snapshot.listing.page, snapshot.listing.order),
      );
      currentSubject = subject;
      current = querySubjectContext(subject);
      if (current) current.actionId = undefined;
      adapter.beginQuery(current?.runId, current?.queryId);
      const pending: PendingListing = {
        subject,
        query,
        context: { ...current! },
        fromUrl: observed.url,
        observationOnly: false,
      };
      const returned = await adapter.returnToList(signal);
      if (!returned.listing) throw new UnsupportedAdapterOperation("返回角色列表结果读取");
      await acceptListing(returned.listing, pending);
      return beginListing(operation, target);
    }
    const sort = typeof target === "string" ? target : snapshot.listing.order;
    const page =
      operation === "page"
        ? Number(target)
        : operation === "refresh" || sort !== snapshot.listing.order
          ? 1
          : snapshot.listing.page;
    const subject = subjectFor(snapshot);
    const query = beginObservedQuery(subject, listIdentity(snapshot, page, sort));
    currentSubject = subject;
    current = querySubjectContext(subject);
    if (current) current.actionId = undefined;
    adapter.beginQuery(current?.runId, current?.queryId);
    return {
      subject,
      query,
      context: { ...current! },
      fromUrl: snapshot.url,
      // A same-page read is an explicit fresh verification, with no dispatched action.
      observationOnly:
        observed === snapshot &&
        operation !== "refresh" &&
        page === snapshot.listing.page &&
        sort === snapshot.listing.order,
    };
  };
  const acceptListing = async (
    value: ListingPage,
    pending: PendingListing,
  ): Promise<ListingPage> => {
    const snapshot = await adapter.snapshot();
    const { subject, query, context, observationOnly } = pending;
    const sameDocument =
      snapshot.context.pageId === context.pageId &&
      snapshot.context.pageGeneration === context.pageGeneration &&
      snapshot.context.browserSessionEpoch === context.browserSessionEpoch &&
      snapshot.context.runId === context.runId &&
      snapshot.context.stopEpoch === context.stopEpoch;
    const exactIdentity = (record: QueryRecord) =>
      !!snapshot.queryArgs &&
      !!snapshot.listing &&
      Number(snapshot.queryArgs.page) === record.identity.page &&
      String(snapshot.queryArgs.order_by || "") === record.identity.sort &&
      snapshot.listing.page === record.identity.page &&
      snapshot.listing.order === record.identity.sort &&
      value.page === record.identity.page &&
      value.order === record.identity.sort &&
      queryIdentityHash({
        ...listIdentity(snapshot, snapshot.listing.page, snapshot.listing.order),
        schemaVersion: 1,
        browserSessionEpoch: snapshot.context.browserSessionEpoch,
      }) === queryIdentityHash(record.identity);
    const committed =
      snapshot.listingCommitted === true &&
      (value.items.length > 0 ||
        !!snapshot.business?.some((result) => result.success && result.count === 0));
    // A changed document is accepted only through the worker's verified Chrome binding
    // and the local completed execute receipt. Echoing an actionId in a page is insufficient.
    const sameNavigationDocument = (a: NativeNavigationDocument, b: NativeNavigationDocument) =>
      a.pageId === b.pageId &&
      a.pageGeneration === b.pageGeneration &&
      a.url === b.url &&
      a.tabId === b.tabId &&
      a.windowId === b.windowId &&
      a.bindingEpoch === b.bindingEpoch &&
      a.connectionEpoch === b.connectionEpoch;
    const ownedReturnAction = (receipt: NativeNavigationReceipt) => {
      const owned = receipt.ownedReturn;
      if (!owned || receipt.plan.target.kind !== "return-to-list") return undefined;
      const opening = adapter.navigationReceipt(owned.openedBy.queryId, owned.openedBy.actionId);
      const plan = owned.openedBy;
      if (
        !opening ||
        plan.target.kind !== "listing-detail" ||
        plan.expected.kind !== "detail" ||
        plan.target.serverId !== plan.expected.serverId ||
        plan.target.eid !== plan.expected.eid ||
        opening.plan.actionId !== plan.actionId ||
        opening.plan.queryId !== plan.queryId ||
        opening.plan.target.kind !== "listing-detail" ||
        opening.plan.target.serverId !== plan.target.serverId ||
        opening.plan.target.eid !== plan.target.eid ||
        plan.runId !== context.runId ||
        plan.stopEpoch !== context.stopEpoch ||
        plan.browserSessionEpoch !== context.browserSessionEpoch ||
        plan.pageId !== owned.parent.pageId ||
        plan.pageGeneration !== owned.parent.pageGeneration ||
        !sameNavigationDocument(opening.from, owned.parent) ||
        !sameNavigationDocument(opening.to, owned.child) ||
        !sameNavigationDocument(receipt.from, owned.child) ||
        !sameNavigationDocument(receipt.to, owned.parent) ||
        owned.child.tabId === owned.parent.tabId ||
        owned.child.windowId !== owned.parent.windowId ||
        opening.committedAt > receipt.dispatchedAt ||
        opening.inputConfirmedAt < opening.dispatchedAt ||
        opening.committedAt < opening.inputConfirmedAt
      )
        return undefined;
      return plan.actionId;
    };
    const validNavigation = (receipt: NativeNavigationReceipt | undefined) => {
      if (!query || !receipt || observationOnly || !snapshot.context.actionId) return false;
      const { plan, from, to } = receipt;
      if (plan.target.kind !== "refresh-list" && plan.target.kind !== "return-to-list")
        return false;
      return (
        plan.actionId === snapshot.context.actionId &&
        plan.runId === context.runId &&
        plan.queryId === query.queryId &&
        plan.stopEpoch === context.stopEpoch &&
        plan.browserSessionEpoch === context.browserSessionEpoch &&
        plan.pageId === context.pageId &&
        plan.pageGeneration === context.pageGeneration &&
        from.pageId === context.pageId &&
        from.pageGeneration === context.pageGeneration &&
        from.url === pending.fromUrl &&
        to.pageId === snapshot.context.pageId &&
        to.pageGeneration === snapshot.context.pageGeneration &&
        (to.pageId !== from.pageId || to.pageGeneration > from.pageGeneration) &&
        to.url === snapshot.url &&
        plan.target.url === to.url &&
        (plan.target.kind !== "refresh-list" || plan.target.url === from.url) &&
        Number.isSafeInteger(from.tabId) &&
        from.tabId >= 0 &&
        Number.isSafeInteger(from.windowId) &&
        from.windowId >= 0 &&
        from.windowId === to.windowId &&
        !!from.bindingEpoch &&
        !!to.bindingEpoch &&
        ((from.tabId === to.tabId && from.bindingEpoch === to.bindingEpoch) ||
          !!ownedReturnAction(receipt)) &&
        !!from.connectionEpoch &&
        from.connectionEpoch === to.connectionEpoch &&
        Number.isFinite(receipt.dispatchedAt) &&
        receipt.dispatchedAt >= query.observedAt &&
        receipt.inputConfirmedAt >= receipt.dispatchedAt &&
        receipt.committedAt >= receipt.inputConfirmedAt &&
        receipt.committedAt <= Date.now() &&
        Date.parse(snapshot.context.observedAt) >= receipt.inputConfirmedAt &&
        receipt.revision === snapshot.revision &&
        snapshot.context.runId === context.runId &&
        snapshot.context.queryId === query.queryId &&
        snapshot.context.stopEpoch === context.stopEpoch &&
        snapshot.context.browserSessionEpoch === context.browserSessionEpoch &&
        plan.expected.kind === "page" &&
        plan.expected.page === query.identity.page
      );
    };
    let linkedDocument = sameDocument;
    if (!sameDocument && query && committed && !snapshot.loading && exactIdentity(query)) {
      const receipt = adapter.navigationReceipt(
        query.queryId,
        snapshot.context.actionId || undefined,
      );
      if (validNavigation(receipt)) {
        const target = receipt!.plan.target;
        if (target.kind === "refresh-list" || target.kind === "return-to-list") {
          try {
            current = moveObservedQuery(subject, query, snapshot.context, receipt!.plan.actionId, {
              ...target,
              openingActionId: ownedReturnAction(receipt!),
            });
            if (subjects.get(context.pageId) === subject) subjects.delete(context.pageId);
            subjects.set(snapshot.context.pageId, subject);
            linkedDocument = true;
          } catch {
            // A newer stop, expired lease or unconfirmed local permit keeps this query unknown.
          }
        }
      }
    }
    await finishObservedQuery(
      subject,
      query,
      {
        count: value.items.length,
        loaded: !snapshot.loading,
        committed,
        emptyMarker: snapshot.empty,
        identityMatched:
          linkedDocument &&
          !!query &&
          exactIdentity(query) &&
          (observationOnly || snapshot.context.queryId === query.queryId),
        blocked: !["normal", "unknown"].includes(snapshot.access),
      },
      query
        ? createRoleListDiagnostic(
            {
              snapshot: async (): Promise<RoleDiagnosticSnapshot> => {
                const checked = await adapter.snapshot();
                if (!checked.queryArgs || !checked.listing)
                  throw new UnsupportedAdapterOperation("缺少真实条件或列表的角色诊断观察");
                return {
                  conditions: Object.fromEntries(
                    Object.entries(checked.queryArgs).filter(
                      ([key]) => !["page", "order_by"].includes(key),
                    ),
                  ),
                  fields: checked.formValues || {},
                  revision: checked.revision,
                  page: checked.listing.page,
                  sort: checked.listing.order,
                  evidence: {
                    count: checked.listing.items.length,
                    loaded: !checked.loading,
                    committed:
                      checked.listingCommitted === true &&
                      (checked.listing.items.length > 0 ||
                        !!checked.business?.some((result) => result.success && result.count === 0)),
                    emptyMarker: checked.empty,
                    identityMatched:
                      Number(checked.queryArgs.page) === checked.listing.page &&
                      String(checked.queryArgs.order_by || "") === checked.listing.order,
                    blocked: !["normal", "unknown"].includes(checked.access),
                  },
                };
              },
              field: async (field, value) => {
                current = querySubjectContext(subject);
                adapter.beginQuery(current?.runId, current?.queryId);
                await adapter.query(
                  { kind: "query-field", field, value },
                  { kind: "changed" },
                  signal,
                );
              },
              submit: async () => {
                current = querySubjectContext(subject);
                adapter.beginQuery(current?.runId, current?.queryId);
                await adapter.query({ kind: "query" }, { kind: "page", page: 1 }, signal);
              },
              sort: async (value) => {
                current = querySubjectContext(subject);
                adapter.beginQuery(current?.runId, current?.queryId);
                await adapter.query({ kind: "sort", value }, { kind: "page", page: 1 }, signal);
              },
              page: async (page) => {
                current = querySubjectContext(subject);
                adapter.beginQuery(current?.runId, current?.queryId);
                await adapter.query({ kind: "jump-page", page }, { kind: "page", page }, signal);
              },
            },
            query.identity,
          )
        : undefined,
      { page: value.page, order: value.order },
    );
    lastListingSnapshot = snapshot;
    current = querySubjectContext(subject);
    return value;
  };
  const detail = async (item: Listing) => {
    const result = await raw.detail(item);
    const snapshot = await adapter.snapshot();
    const subject = subjectFor(snapshot);
    const query = beginObservedQuery(subject, {
      category: "role-detail",
      server: item.serverId,
      serverAge: item.serverAge || "",
      conditions: { eid: item.eid, ordersn: item.ordersn },
      page: 1,
      sort: "detail",
    });
    await finishObservedQuery(subject, query, {
      count: 1,
      loaded: !snapshot.loading,
      committed: !!snapshot.revision,
      emptyMarker: false,
      identityMatched:
        snapshot.productIdentity?.serverId === item.serverId &&
        snapshot.productIdentity.eid === item.eid,
      blocked: !["normal", "unknown"].includes(snapshot.access),
    });
    result.accessContext = querySubjectContext(subject);
    return result;
  };
  const scope = {
    activity: adapter.activity,
    crawlLease,
    context: () => (currentSubject ? querySubjectContext(currentSubject) : current),
  };
  const source: CrawlSource = {
    ...raw,
    prepare: async (order) =>
      withNativeWorkflow(
        signal,
        async () => {
          const query = await beginListing("prepare", order);
          return acceptListing(await raw.prepare(order), query);
        },
        scope,
      ),
    page: async (number) =>
      withNativeWorkflow(
        signal,
        async () => {
          const query = await beginListing("page", number);
          return acceptListing(await raw.page(number), query);
        },
        scope,
      ),
    refresh: async (order) =>
      withNativeWorkflow(
        signal,
        async () => {
          if (!raw.refresh) throw new UnsupportedAdapterOperation("没有受控刷新入口的原生列表刷新");
          const query = await beginListing("refresh", order);
          return acceptListing(await raw.refresh(order), query);
        },
        scope,
      ),
    detail: (item) => withNativeWorkflow(signal, () => detail(item), scope),
    hover: (item) => withNativeWorkflow(signal, () => raw.hover(item), scope),
    onShelf: (item) => withNativeWorkflow(signal, () => raw.onShelf(item), scope),
  };
  return {
    source,
    context: () => (currentSubject ? querySubjectContext(currentSubject) : current),
  };
}
