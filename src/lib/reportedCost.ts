function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * USD a provider put on its own payload. Only an explicit cost field counts;
 * token counts and billed seconds are not dollars.
 */
export function reportedUsd(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const direct = numeric(rec.cost);
  if (direct !== undefined) return direct;
  const usage = rec.usage;
  if (usage && typeof usage === "object") return numeric((usage as { cost?: unknown }).cost);
  return undefined;
}
