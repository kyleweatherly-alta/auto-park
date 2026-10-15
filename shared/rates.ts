import type { Rate } from "./types.ts";

/** "MAC Member - 3 Hours" → "3 Hours". */
export function shortRateName(name: string): string {
  const parts = name.split(/\s+[-–—]\s+/);
  return (parts.length > 1 ? parts.slice(1).join(" - ") : name).trim();
}

/**
 * Pick the rate to buy. An exact (case-insensitive) name match wins; a blank
 * preference means "first listed", which is what tapping through by hand
 * would usually do. A preference that no longer exists returns null so the
 * caller can stop rather than silently buy something else.
 */
export function pickRate<T extends Pick<Rate, "name">>(rates: T[], preferred: string): T | null {
  const want = preferred.trim().toLowerCase();
  if (!want) return rates[0] ?? null;
  return rates.find((r) => r.name.trim().toLowerCase() === want) ?? null;
}
