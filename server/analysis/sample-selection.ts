/** An explicit trial selects only the requested saved products; it never falls back to others. */
export function validateSampleSelection(sample: boolean, size: number, input?: unknown) {
  if (sample && (!Number.isInteger(size) || size < 1 || size > 3))
    throw new Error("试分析数量请选择 1 到 3 件");
  if (input === undefined) return undefined;
  if (
    !sample ||
    !Array.isArray(input) ||
    input.length !== size ||
    input.some(
      (key) => typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > 100,
    ) ||
    new Set(input).size !== input.length
  )
    throw new Error("指定试分析商品需为 1 到 3 个不同的商品 ID，且与试分析数量一致");
  return input as string[];
}
