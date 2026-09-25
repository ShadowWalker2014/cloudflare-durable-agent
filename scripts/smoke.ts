// Headless smoke check: loads the app, prints console errors and a screenshot path.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "/tmp/smoke.png";
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: (process.env.SCHEME as "light" | "dark") ?? "light" });
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 500)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.stack?.slice(0, 1500)));
await page.goto(url);
await page.waitForTimeout(Number(process.env.WAIT ?? 6000));
console.log("TEXT", (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n/g, " | "));
await page.screenshot({ path: out });
console.log("SHOT", out);
await browser.close();
