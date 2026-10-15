import { describe, expect, it } from "vitest";
import { pickRate, shortRateName } from "../shared/rates.ts";
import { formatPhone, maskPhone, normalizePhone, normalizePlate, normalizePromo } from "../shared/validate.ts";

describe("normalizePlate", () => {
  it("uppercases and strips spaces and dashes", () => {
    expect(normalizePlate(" abc 12-34 ")).toEqual({ ok: true, value: "ABC1234" });
  });
  it.each([
    ["", "Enter a license plate."],
    ["A", "Plates need at least 2 characters."],
    ["ABCDEFGHIJKLM", "Plates can't be longer than 12 characters."],
    ["ABC.123", "Plates can only contain letters and numbers."],
  ])("rejects %j", (input, error) => {
    expect(normalizePlate(input)).toEqual({ ok: false, error });
  });
});

describe("normalizePhone", () => {
  it.each(["414-555-0199", "(414) 555-0199", "+1 414 555 0199", "14145550199", "414.555.0199"])("accepts %s", (input) => {
    expect(normalizePhone(input)).toEqual({ ok: true, value: "+14145550199" });
  });
  it("rejects short numbers", () => {
    expect(normalizePhone("555-0199")).toMatchObject({ ok: false });
  });
  it("rejects bad area codes", () => {
    expect(normalizePhone("014-555-0199")).toMatchObject({ ok: false });
  });
  it("requires a value", () => {
    expect(normalizePhone("  ")).toMatchObject({ ok: false });
  });
  it("formats and masks", () => {
    expect(formatPhone("+14145550199")).toBe("(414) 555-0199");
    expect(maskPhone("+14145550199")).toBe("(414) •••-0199");
  });
});

describe("normalizePromo", () => {
  it("is optional", () => expect(normalizePromo("")).toEqual({ ok: true, value: "" }));
  it("uppercases", () => expect(normalizePromo(" promo1 ")).toEqual({ ok: true, value: "PROMO1" }));
  it("rejects spaces inside", () => expect(normalizePromo("M3 513")).toMatchObject({ ok: false }));
});

describe("rates", () => {
  const rates = [{ name: "MAC Member - 3 Hours" }, { name: "MAC Member - All Day (Expires 7pm)" }];
  it("shortens names", () => {
    expect(shortRateName("MAC Member - 3 Hours")).toBe("3 Hours");
    expect(shortRateName("All Day")).toBe("All Day");
  });
  it("picks by exact name, case-insensitively", () => {
    expect(pickRate(rates, "mac member - all day (expires 7pm)")).toBe(rates[1]);
  });
  it("picks the first rate when there is no preference", () => {
    expect(pickRate(rates, "")).toBe(rates[0]);
  });
  it("returns null instead of guessing when the preference is gone", () => {
    expect(pickRate(rates, "MAC Member - 5 Hours")).toBeNull();
  });
});
