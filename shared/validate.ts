// Input normalization and validation shared by the UI and the server.
// Rules mirror TapNPark's own checks so we fail fast with a clear message
// instead of halfway through a purchase.

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** Plates: 2–12 letters/digits. Spaces and dashes are dropped ("abc 1234" → "ABC1234"). */
export function normalizePlate(input: string): Validation<string> {
  const value = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!value) return { ok: false, error: "Enter a license plate." };
  if (!/^[A-Z0-9]+$/.test(value)) return { ok: false, error: "Plates can only contain letters and numbers." };
  if (value.length < 2) return { ok: false, error: "Plates need at least 2 characters." };
  if (value.length > 12) return { ok: false, error: "Plates can't be longer than 12 characters." };
  return { ok: true, value };
}

/** US phone numbers in any common format → E.164 ("+14145551234"). */
export function normalizePhone(input: string): Validation<string> {
  let digits = input.replace(/\D/g, "");
  if (!digits) return { ok: false, error: "Enter the phone number for the receipt text." };
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return { ok: false, error: "Enter a 10-digit US phone number." };
  if (/^[01]/.test(digits)) return { ok: false, error: "That area code doesn't look right." };
  return { ok: true, value: `+1${digits}` };
}

/** Promo / validation codes are optional; letters, digits and dashes only. */
export function normalizePromo(input: string): Validation<string> {
  const value = input.trim().toUpperCase();
  if (!value) return { ok: true, value: "" };
  if (!/^[A-Z0-9-]{1,40}$/.test(value)) return { ok: false, error: "Promo codes can only contain letters, numbers and dashes." };
  return { ok: true, value };
}

export function normalizeNickname(input: string): Validation<string> {
  const value = input.trim().replace(/\s+/g, " ");
  if (value.length > 30) return { ok: false, error: "Keep nicknames under 30 characters." };
  return { ok: true, value };
}

/** "+14145551234" → "(414) 555-1234". Leaves anything else untouched. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** "+14145551234" → "(414) •••-1234" for places where the full number isn't needed. */
export function maskPhone(e164: string): string {
  const m = /^\+1(\d{3})\d{3}(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) •••-${m[2]}` : "•••";
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
