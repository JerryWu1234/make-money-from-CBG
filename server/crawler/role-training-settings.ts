import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class RoleTrainingSettingsError extends Error {}
export type RoleTrainingSettings = { minTotal: number | null };
export function validateRoleTrainingMinimum(value: unknown): number | null {
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RoleTrainingSettingsError("四修总和下限必须为空或非负安全整数");
  return value;
}

export class RoleTrainingSettingsStore {
  private settings?: RoleTrainingSettings;
  constructor(private readonly file: string) {}
  get(): RoleTrainingSettings {
    if (!this.settings) {
      let minTotal: number | null = null;
      try {
        const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || !("minTotal" in value))
          throw new RoleTrainingSettingsError("四修过滤配置缺少合法 minTotal，请重新保存设置");
        minTotal = validateRoleTrainingMinimum(value.minTotal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error instanceof RoleTrainingSettingsError
            ? error
            : new RoleTrainingSettingsError("四修过滤配置无法读取，请检查并重新保存设置", {
                cause: error,
              });
      }
      this.settings = { minTotal };
    }
    return { ...this.settings };
  }
  save(value: unknown): RoleTrainingSettings {
    const next = { minTotal: validateRoleTrainingMinimum(value) };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the persistence error. */
      }
      throw error;
    }
    this.settings = next;
    return { ...next };
  }
}
const store = new RoleTrainingSettingsStore(path.resolve("data/role-training-settings.json"));
export const roleTrainingSettings = () => store.get();
export const saveRoleTrainingSettings = (value: unknown) => store.save(value);
