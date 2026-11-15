import type { QueryDiagnostic } from "./runtime";
import type { QueryEvidence, QueryIdentity } from "./store";
import { QueryDiagnosticError } from "./diagnostic-state";

export const ROLE_DIAGNOSTIC_FIELDS = ["price_min", "price_max", "level_min", "level_max"] as const;
export type RoleDiagnosticField = (typeof ROLE_DIAGNOSTIC_FIELDS)[number];
export type RoleDiagnosticControl = {
  value: string;
  min?: string;
  max?: string;
  step?: string;
};
export type RoleDiagnosticSnapshot = {
  conditions: QueryIdentity["conditions"];
  page: number;
  sort: string;
  /** Actual form values and committed page revision, never an intended query. */
  fields: Partial<Record<RoleDiagnosticField, string>>;
  controls?: Partial<Record<RoleDiagnosticField, RoleDiagnosticControl>>;
  /** When the fixed server controls are exposed, they must also match before submission. */
  dimensions?: Partial<Record<"server_type" | "serverid", string>>;
  revision: string;
  evidence: QueryEvidence;
};
export type RoleDiagnosticDriver = {
  suspend?: () => Promise<void>;
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

/** Local input bounds plus any stricter constraints read from the actual public control. */
export function validRoleDiagnosticValue(
  field: RoleDiagnosticField,
  value: string,
  control?: RoleDiagnosticControl,
): boolean {
  if (value === "") return true;
  if (!(field.startsWith("price_") ? /^\d{1,8}(?:\.\d{1,2})?$/ : /^\d{1,8}$/).test(value))
    return false;
  const number = Number(value);
  const bound = (text: string | undefined) =>
    text !== undefined && text !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined;
  const min = bound(control?.min),
    max = bound(control?.max),
    step = bound(control?.step);
  return (
    (min === undefined || number >= min) &&
    (max === undefined || number <= max) &&
    (step === undefined ||
      step <= 0 ||
      Math.abs((number - (min ?? 0)) / step - Math.round((number - (min ?? 0)) / step)) < 1e-8)
  );
}

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
  const unsupported = (fields: string[], message: string): never => {
    throw new QueryDiagnosticError("unsupported_condition", fields, message);
  };
  const validate = (identity: QueryIdentity) => {
    const unknown = Object.keys(identity.conditions).filter((key) => !known.has(key));
    if (unknown.length) unsupported(unknown, "角色诊断存在未支持的公开条件，已暂停保留原查询");
    const invalid = ROLE_DIAGNOSTIC_FIELDS.filter(
      (key) => !validRoleDiagnosticValue(key, text(identity.conditions[key])),
    );
    for (const prefix of ["price", "level"]) {
      const lower = text(identity.conditions[`${prefix}_min`]),
        upper = text(identity.conditions[`${prefix}_max`]);
      if (lower && upper && Number(lower) > Number(upper))
        invalid.push(
          `${prefix}_min` as RoleDiagnosticField,
          `${prefix}_max` as RoleDiagnosticField,
        );
    }
    if (invalid.length) unsupported([...new Set(invalid)], "角色诊断条件不是合法的数值范围");
    const serverTypes = text(identity.conditions.server_type).split(",");
    if (
      serverTypes.some((value) => !["1", "2", "3"].includes(value)) ||
      new Set(serverTypes).size !== serverTypes.length ||
      !/^\d{0,8}$/.test(text(identity.conditions.serverid))
    )
      unsupported(["server_type", "serverid"], "角色诊断服龄或服务器条件无效");
    if (
      identity.category !== "role" ||
      identity.schemaVersion !== saved.schemaVersion ||
      identity.server !== saved.server ||
      identity.serverAge !== saved.serverAge ||
      identity.browserSessionEpoch !== saved.browserSessionEpoch ||
      !Number.isSafeInteger(identity.page) ||
      identity.page < 1 ||
      !["selling_time DESC", "expire_time DESC"].includes(identity.sort) ||
      ["server_type", "serverid"].some(
        (key) => valueFor(key, identity.conditions[key]) !== valueFor(key, saved.conditions[key]),
      )
    )
      unsupported(
        ["order_by", "page", "server_type", "serverid"],
        "角色诊断缺少可核验的公开条件或排序入口，已暂停保留原查询",
      );
  };
  const matches = (snapshot: RoleDiagnosticSnapshot, identity: QueryIdentity) =>
    snapshot.page === identity.page &&
    snapshot.sort === identity.sort &&
    roleConditionsMatch(snapshot.conditions, identity.conditions) &&
    Object.entries(snapshot.dimensions || {}).every(
      ([key, value]) => valueFor(key, value) === valueFor(key, identity.conditions[key]),
    ) &&
    ROLE_DIAGNOSTIC_FIELDS.every(
      (key) => text(snapshot.fields[key]) === text(identity.conditions[key]),
    );
  const preflight = (snapshot: RoleDiagnosticSnapshot, identity: QueryIdentity) => {
    const dimensions = Object.entries(snapshot.dimensions || {})
      .filter(([key, value]) => valueFor(key, value) !== valueFor(key, identity.conditions[key]))
      .map(([key]) => key);
    if (dimensions.length)
      unsupported(dimensions, "角色诊断的可见服务器或服龄表单与原提交条件不一致");
    const invalid = ROLE_DIAGNOSTIC_FIELDS.filter((key) => {
      const wanted = text(identity.conditions[key]);
      return (
        (snapshot.fields[key] === undefined &&
          (wanted !== "" ||
            text(snapshot.conditions[key]) !== "" ||
            text(captured?.fields[key]) !== "")) ||
        !validRoleDiagnosticValue(key, wanted, snapshot.controls?.[key])
      );
    });
    if (invalid.length) unsupported(invalid, "角色诊断缺少唯一可见可编辑的合法表单字段");
  };
  const read = async () => {
    const snapshot = await driver.snapshot();
    if (snapshot.evidence.blocked) throw new Error("角色诊断发现明确访问限制，停止诊断及恢复动作");
    if (!snapshot.revision || !snapshot.evidence.loaded)
      throw new Error("角色诊断页面版本或加载状态未确认");
    validate({
      ...saved,
      conditions: snapshot.conditions,
      sort: snapshot.sort,
      page: snapshot.page,
    });
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
    preflight(snapshot, saved);
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
    preflight(snapshot, identity);
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
  diagnostic.suspend = driver.suspend;
  diagnostic.prepare = async () => {
    const { revision, conditions, page, sort, fields, controls, dimensions } = await capture();
    return { revision, conditions, page, sort, fields, controls, dimensions };
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
