import type { QueryDiagnostic } from "./runtime";
import type { QueryEvidence, QueryIdentity } from "./store";

export const ROLE_DIAGNOSTIC_FIELDS = ["price_min", "price_max", "level_min", "level_max"] as const;
export type RoleDiagnosticField = (typeof ROLE_DIAGNOSTIC_FIELDS)[number];
export type RoleDiagnosticSnapshot = {
  conditions: QueryIdentity["conditions"];
  page: number;
  sort: string;
  /** Actual form values and committed page revision, never an intended query. */
  fields: Partial<Record<RoleDiagnosticField, string>>;
  revision: string;
  evidence: QueryEvidence;
};
export type RoleDiagnosticDriver = {
  snapshot(): Promise<RoleDiagnosticSnapshot>;
  field(field: RoleDiagnosticField, value: string): Promise<void>;
  submit(): Promise<void>;
  sort(value: string): Promise<void>;
  page(value: number): Promise<void>;
};

const text = (value: string | number | undefined) => String(value ?? "").trim();
const valueFor = (key: string, value: string | number | undefined) =>
  key === "server_type" ? text(value).split(",").sort().join(",") : text(value);
const filters = (conditions: QueryIdentity["conditions"]) =>
  Object.fromEntries(Object.entries(conditions).filter(([, value]) => text(value) !== ""));
const known = new Set<string>(["server_type", "serverid", ...ROLE_DIAGNOSTIC_FIELDS]);

export function roleConditionsMatch(
  actual: QueryIdentity["conditions"],
  expected: QueryIdentity["conditions"],
): boolean {
  const keys = new Set([...Object.keys(filters(actual)), ...Object.keys(filters(expected))]);
  return [...keys].every((key) => valueFor(key, actual[key]) === valueFor(key, expected[key]));
}

/** A finite UI plan. Its outputs are evidence only; the runtime owns persistent claims and budgets. */
export function createRoleListDiagnostic(
  driver: RoleDiagnosticDriver,
  original: QueryIdentity,
): QueryDiagnostic {
  const saved = structuredClone(original);
  let originalRevision: string | undefined;
  let captured: RoleDiagnosticSnapshot | undefined;
  let restored = false;
  const validate = (identity: QueryIdentity) => {
    if (
      identity.category !== "role" ||
      identity.schemaVersion !== saved.schemaVersion ||
      identity.server !== saved.server ||
      identity.serverAge !== saved.serverAge ||
      identity.browserSessionEpoch !== saved.browserSessionEpoch ||
      !["selling_time DESC", "expire_time DESC"].includes(identity.sort) ||
      Object.keys(filters(identity.conditions)).some((key) => !known.has(key)) ||
      ["server_type", "serverid"].some(
        (key) => valueFor(key, identity.conditions[key]) !== valueFor(key, saved.conditions[key]),
      ) ||
      ROLE_DIAGNOSTIC_FIELDS.some((key) => !/^\d{0,8}$/.test(text(identity.conditions[key])))
    )
      throw new Error("角色诊断缺少可核验的公开条件或排序入口，已暂停保留原查询");
  };
  const matches = (snapshot: RoleDiagnosticSnapshot, identity: QueryIdentity) =>
    snapshot.page === identity.page &&
    snapshot.sort === identity.sort &&
    roleConditionsMatch(snapshot.conditions, identity.conditions) &&
    ROLE_DIAGNOSTIC_FIELDS.every(
      (key) => text(snapshot.fields[key]) === text(identity.conditions[key]),
    );
  const read = async () => {
    const snapshot = await driver.snapshot();
    if (snapshot.evidence.blocked) throw new Error("角色诊断发现明确访问限制，停止诊断及恢复动作");
    if (!snapshot.revision || !snapshot.evidence.loaded)
      throw new Error("角色诊断页面版本或加载状态未确认");
    return snapshot;
  };
  const evidence = (snapshot: RoleDiagnosticSnapshot, identity: QueryIdentity) => ({
    ...snapshot.evidence,
    identityMatched: snapshot.evidence.identityMatched && matches(snapshot, identity),
  });
  const capture = async () => {
    if (captured) return structuredClone(captured);
    validate(saved);
    const snapshot = await read();
    if (
      !matches(snapshot, saved) ||
      !snapshot.evidence.committed ||
      !snapshot.evidence.identityMatched
    )
      throw new Error("原角色条件、表单、排序、页码或提交证据已变化，拒绝诊断");
    originalRevision = snapshot.revision;
    captured = structuredClone(snapshot);
    return snapshot;
  };
  const execute = async (identity: QueryIdentity): Promise<QueryEvidence> => {
    validate(identity);
    if (originalRevision === undefined) await capture();
    let snapshot = await read();
    // Preflight every required field before changing any control. Missing controls never
    // become an excuse to inject QueryArgs or silently broaden another condition.
    for (const key of ROLE_DIAGNOSTIC_FIELDS) {
      const wanted = text(identity.conditions[key]);
      if (snapshot.fields[key] === undefined && wanted !== text(snapshot.fields[key]))
        throw new Error(`角色诊断缺少可见表单字段 ${key}`);
    }
    for (const key of ROLE_DIAGNOSTIC_FIELDS) {
      const wanted = text(identity.conditions[key]);
      if (text(snapshot.fields[key]) === wanted) continue;
      await driver.field(key, wanted);
      snapshot = await read();
      if (snapshot.fields[key] !== wanted) throw new Error(`角色诊断字段 ${key} 未确认`);
    }
    const before = snapshot.revision;
    await driver.submit();
    snapshot = await read();
    if (snapshot.page !== 1 || snapshot.revision === before || !snapshot.evidence.committed)
      throw new Error("角色诊断查询提交未确认，不自动重试");
    if (snapshot.sort !== identity.sort) {
      await driver.sort(identity.sort);
      snapshot = await read();
      if (snapshot.sort !== identity.sort) throw new Error("角色诊断排序未确认，不自动重试");
    }
    if (snapshot.page !== identity.page) {
      await driver.page(identity.page);
      snapshot = await read();
    }
    const result = evidence(snapshot, identity);
    if (!result.identityMatched) throw new Error("角色诊断实际条件、排序或页码未确认");
    return result;
  };
  const diagnostic: QueryDiagnostic = (identity) => execute(identity);
  diagnostic.prepare = async () => {
    const { revision, conditions, page, sort, fields } = await capture();
    return { revision, conditions, page, sort, fields };
  };
  diagnostic.restore = async (identity) => {
    if (restored) throw new Error("角色诊断恢复已使用，拒绝重复动作");
    restored = true;
    if (
      !roleConditionsMatch(identity.conditions, saved.conditions) ||
      identity.page !== saved.page ||
      identity.sort !== saved.sort
    )
      throw new Error("角色诊断恢复身份与保存的原查询不一致");
    const snapshot = await read();
    // Same-condition target review can already leave the original query restored.
    if (matches(snapshot, saved)) return evidence(snapshot, saved);
    return execute(saved);
  };
  return diagnostic;
}
