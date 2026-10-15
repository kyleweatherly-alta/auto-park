// Read-only health check: is TapNPark still shaped the way Auto-Park expects?
// Sends no plate, phone or promo code and buys nothing.
//   npm run check:tapnpark
import { ApiEngine } from "../server/src/engines/api.ts";

const lot = process.env.LOT_CODE || "Q60x6xih";
let failed = false;

try {
  const t0 = Date.now();
  const rates = await new ApiEngine().listRates(lot, AbortSignal.timeout(15_000));
  console.log(`✓ API: ${rates.length} rates in ${Date.now() - t0} ms — ${rates.map((r) => `${r.shortName} $${r.amount.toFixed(2)}`).join(", ")}`);
} catch (err) {
  failed = true;
  console.log(`✗ API: ${(err as Error).message}`);
}

try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, locale: "en-US" });
    const t0 = Date.now();
    await page.goto(`https://app.tapnpark.com/?qr=${encodeURIComponent(lot)}`, { waitUntil: "domcontentloaded" });
    const buy = page.getByRole("button", { name: "Buy Parking", exact: true });
    await buy.waitFor({ timeout: 25_000 });
    await buy.click();
    await page.getByPlaceholder("ABC123").waitFor({ timeout: 25_000 });
    const checks = {
      "phone field": await page.locator('input[type="tel"]').count(),
      "Agree and Continue": await page.getByRole("button", { name: "Agree and Continue", exact: true }).count(),
    };
    const missing = Object.entries(checks).filter(([, n]) => n === 0).map(([k]) => k);
    if (missing.length) throw new Error(`missing on the plate screen: ${missing.join(", ")}`);
    console.log(`✓ Browser: lot page and plate form look as expected (${Date.now() - t0} ms)`);
  } finally {
    await browser.close();
  }
} catch (err) {
  failed = true;
  console.log(`✗ Browser: ${(err as Error).message.split("\n")[0]}`);
}

process.exit(failed ? 1 : 0);
