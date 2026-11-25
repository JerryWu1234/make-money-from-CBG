const TRAINING_KEYS = ["攻修", "防修", "法修", "抗法"] as const;

/** Only complete, explicit current levels may rule out a role. Missing is never zero. */
export function trainingTotal(attrs: Record<string, string>): number | null {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
  let total = 0;
  for (const key of TRAINING_KEYS) {
    if (!Object.hasOwn(attrs, key)) return null;
    const value = attrs[key];
    if (typeof value !== "string" || !/^\d+(?:\s*\/\s*\d+)?$/.test(value.trim())) return null;
    const parts = value
      .trim()
      .split("/")
      .map((part) => Number(part.trim()));
    if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
    if (parts.length === 2 && parts[0] > parts[1]) return null;
    total += parts[0];
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function roleTrainingDecision(
  attrs: Record<string, string>,
  minTotal: number | null,
  currentListing = true,
) {
  const total = minTotal !== null && currentListing ? trainingTotal(attrs) : null;
  return {
    total,
    skip: minTotal !== null && total !== null && total < minTotal,
    reason:
      minTotal === null
        ? "disabled"
        : !currentListing
          ? "saved-listing-not-current"
          : total === null
            ? "missing-or-invalid-training"
            : total < minTotal
              ? "below-minimum"
              : "meets-minimum",
  };
}
