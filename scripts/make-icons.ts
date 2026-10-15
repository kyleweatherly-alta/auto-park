// Renders web/public/icon.svg to the PNG sizes phones want. Run: npx tsx scripts/make-icons.ts
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const svg = await readFile("web/public/icon.svg", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, file, pad] of [
  [180, "apple-touch-icon.png", 0],
  [192, "icon-192.png", 0],
  [512, "icon-512.png", 0.1],
] as const) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons need the artwork inside a safe zone on a full-bleed background.
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(
    `<body style="margin:0;background:#3730a3;display:grid;place-items:center;height:${size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace("<svg", `<svg width="${inner}" height="${inner}"`)}</div></body>`,
  );
  await page.screenshot({ path: `web/public/${file}` });
  console.log(`wrote web/public/${file}`);
}
await browser.close();
