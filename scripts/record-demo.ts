/**
 * Records one crisp clip per feature for the demo video (dark theme, fresh workspace).
 *
 *   bun run dev
 *   bun scripts/record-demo.ts [clip-name ...]
 *
 * Frames come from the Chrome DevTools screencast (sharper than Playwright's
 * recordVideo), then ffmpeg turns each clip into a 60 fps MP4 in recordings/.
 * A drawn cursor follows the mouse so clicks are visible on screen.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CDPSession, chromium, type Locator, type Page } from "playwright-core";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "recordings");
const FIXTURES = path.join(ROOT, "scripts/fixtures");
const USER = `video-${Date.now().toString(36)}`;
const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "dark" });

// A drawn cursor + click ripple, since screencasts do not include the OS pointer.
await context.addInitScript(() => {
  const install = () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6L9.2 20z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-100px,-100px)", filter: "drop-shadow(0 2px 4px rgba(0,0,0,.5))" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      Object.assign(r.style, { position: "fixed", left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: "36px", height: "36px", borderRadius: "50%", border: "2px solid #f38020", zIndex: "2147483646", pointerEvents: "none", transition: "transform .45s cubic-bezier(.2,.8,.2,1), opacity .45s" });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => Object.assign(r.style, { transform: "scale(1.8)", opacity: "0" }));
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
  else install();
});

// ─── recorder ─────────────────────────────────────────────────────────────────

type Clip = { name: string; dir: string; frames: { file: string; t: number }[]; marks: Record<string, number>; t0: number };
let clip: Clip | null = null;
let cdp: CDPSession | null = null;

async function attach(page: Page) {
  cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!clip) return;
    const file = path.join(clip.dir, `${String(clip.frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    clip.frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
  });
  const startCast = () => cdp?.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2160, maxHeight: 1350, everyNthFrame: 1 }).catch(() => {});
  page.on("load", startCast); // a navigation stops the screencast
  await startCast();
}

function start(name: string) {
  const dir = path.join(OUT, `${name}.frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  clip = { name, dir, frames: [], marks: {}, t0: Date.now() / 1000 };
}

const mark = (label: string) => clip && (clip.marks[label] = Date.now() / 1000 - clip.t0);

async function stop(page: Page) {
  await page.mouse.move(1439, 899, { steps: 1 }).catch(() => {}); // nudge a final frame out
  await page.waitForTimeout(300);
  const c = clip!;
  clip = null;
  if (c.frames.length < 2) throw new Error(`${c.name}: no frames`);
  const end = Date.now() / 1000;
  const lines = c.frames.flatMap((f, i) => {
    const next = c.frames[i + 1]?.t ?? end;
    return [`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`];
  });
  lines.push(`file '${c.frames.at(-1)!.file}'`);
  const list = path.join(c.dir, "list.txt");
  writeFileSync(list, lines.join("\n"));
  const mp4 = path.join(OUT, `${c.name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=60,scale=2160:1350:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "14", "-preset", "slow", mp4]);
  const marks = { ...c.marks, start: 0, end: end - c.frames[0].t, offset: c.frames[0].t - c.t0 };
  writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify(marks, null, 2));
  rmSync(c.dir, { recursive: true, force: true });
  console.log(`✓ ${c.name}  ${(end - c.frames[0].t).toFixed(1)}s  ${c.frames.length} frames`, marks);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function moveTo(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
}

async function click(page: Page, target: Locator) {
  await moveTo(page, target);
  await page.waitForTimeout(180);
  await target.click();
}

async function type(page: Page, text: string) {
  await click(page, page.getByTestId("prompt"));
  await page.getByTestId("prompt").pressSequentially(text, { delay: 28 });
  await page.waitForTimeout(250);
  await page.getByTestId("prompt").press("Enter");
}

const idle = (page: Page, timeout = 180_000) =>
  page
    .waitForFunction(() => document.querySelector("[data-testid=send]")?.getAttribute("aria-label") === "Stop", null, { timeout: 30_000 })
    .catch(() => {})
    .then(() => page.waitForFunction(() => document.querySelector("[data-testid=send]")?.getAttribute("aria-label") === "Submit", null, { timeout }));

async function newChat(page: Page) {
  const before = page.url();
  await click(page, page.getByTestId("new-chat"));
  await page.waitForFunction((u) => location.href !== u, before);
  await page.waitForFunction(() => document.querySelector("[data-testid=chat]")?.getAttribute("data-thread") === new URL(location.href).searchParams.get("t"));
  await page.getByTestId("suggestion").first().waitFor();
}

const suggestion = (page: Page, text: string) => page.getByTestId("suggestion").filter({ hasText: text });

// ─── clips ────────────────────────────────────────────────────────────────────

let page = await context.newPage();
await page.goto(`${BASE}/?user=${USER}`);
await page.getByTestId("suggestion").first().waitFor({ timeout: 30_000 });
await attach(page);
await page.waitForTimeout(800);

const clips: Record<string, () => Promise<void>> = {
  async "01-empty"() {
    await page.mouse.move(700, 120);
    await page.waitForTimeout(600);
    for (const s of ["Call a tool", "Run sub-agents", "Ask for approval", "Run a background task"]) {
      await moveTo(page, suggestion(page, s));
      await page.waitForTimeout(420);
    }
  },
  async "02-tool"() {
    await click(page, suggestion(page, "Call a tool"));
    mark("sent");
    await page.getByTestId("tool-getWeather").waitFor({ timeout: 60_000 });
    mark("tool");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1200);
  },
  async "03-subagents"() {
    await newChat(page);
    await click(page, suggestion(page, "Run sub-agents"));
    mark("sent");
    await page.getByTestId("subagent-runs").first().waitFor({ timeout: 60_000 });
    mark("running");
    await page.waitForFunction(
      () => [...document.querySelectorAll("[data-testid=subagent-status]")].length >= 2 && [...document.querySelectorAll("[data-testid=subagent-status]")].every((e) => e.getAttribute("data-status") === "completed"),
      null,
      { timeout: 180_000 }
    );
    mark("subagents-done");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1500);
  },
  async "04-session"() {
    await click(page, page.getByTestId("session-item").first());
    await page.waitForFunction(() => document.querySelector("[data-testid=connection]")?.textContent?.includes("Live"));
    mark("opened");
    await page.waitForTimeout(1600);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(1200);
    await type(page, "In one sentence: the single most important fact you found?");
    mark("sent");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1200);
    await click(page, page.getByTestId("session-parent"));
    await page.waitForTimeout(1200);
  },
  async "05-approval"() {
    await newChat(page);
    await click(page, suggestion(page, "Ask for approval"));
    await page.getByTestId("approve").waitFor({ timeout: 90_000 });
    mark("card");
    await page.waitForTimeout(1300);
    await click(page, page.getByTestId("approve"));
    mark("approved");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1200);
  },
  async "06-attach"() {
    await newChat(page);
    await page.locator('input[type="file"]').setInputFiles([path.join(FIXTURES, "edge-traffic-chart.png")]);
    mark("attached");
    await page.waitForTimeout(900);
    await type(page, "Which region leads, and by how much?");
    mark("sent");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1400);
  },
  async "07-error"() {
    await newChat(page);
    await click(page, page.getByTestId("simulate-error"));
    await page.waitForTimeout(500);
    await type(page, "Say hello in five words.");
    await page.getByTestId("chat-error").waitFor({ timeout: 30_000 });
    mark("error");
    await page.waitForTimeout(1600);
    await click(page, page.getByTestId("retry"));
    mark("retry");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1200);
  },
  async "08-resume"() {
    await newChat(page);
    await click(page, suggestion(page, "Stream, then refresh"));
    await page.waitForFunction(() => ((document.querySelectorAll("[data-testid=message-assistant]")[0] as HTMLElement)?.innerText.length ?? 0) > 400, null, { timeout: 60_000 });
    mark("reload");
    await page.reload();
    await page.getByTestId("message-user").first().waitFor();
    mark("reloaded");
    await page.waitForTimeout(5000);
    mark("end");
  },
  async "09-task"() {
    await newChat(page);
    await click(page, suggestion(page, "Run a background task"));
    await click(page, page.getByTestId("tab-tasks"));
    await page.getByTestId("task-card").first().waitFor({ timeout: 60_000 });
    mark("progress");
    await page.waitForTimeout(5000);
    mark("close");
    const url = page.url();
    await page.goto("about:blank");
    await page.waitForTimeout(20_000);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("[data-testid=connection]")?.textContent?.includes("Live"));
    mark("reopened");
    await page.getByText("Delivered by a background task").first().waitFor({ timeout: 120_000 });
    mark("delivered");
    await page.getByText("Delivered by a background task").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
  },
  async "10-branch"() {
    const msg = page.getByTestId("message-assistant").first();
    await moveTo(page, msg);
    await page.waitForTimeout(400);
    await click(page, msg.getByTestId("branch"));
    await page.getByTestId("thread-title").filter({ hasText: "(Forked)" }).waitFor();
    mark("branched");
    await page.waitForTimeout(1200);
    await type(page, "Make it one paragraph for executives.");
    await idle(page);
    mark("done");
    await page.waitForTimeout(1200);
  },
  async "11-logs-theme"() {
    await click(page, page.getByTestId("tab-logs"));
    await click(page, page.getByTestId("log-filter-all"));
    await page.waitForTimeout(900);
    const row = page.getByTestId("log-row").filter({ hasText: "step:end" }).last();
    await click(page, row.locator("button"));
    await page.waitForTimeout(1600);
    mark("theme");
    await click(page, page.getByRole("radio", { name: "Light" }));
    await page.waitForTimeout(1500);
    await click(page, page.getByRole("radio", { name: "Dark" }));
    await page.waitForTimeout(1200);
  }
};

for (const [name, run] of Object.entries(clips)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  start(name);
  try {
    await run();
    await stop(page);
  } catch (error) {
    clip = null;
    console.log(`✗ ${name}`, error instanceof Error ? error.message.split("\n")[0] : error);
    await page.screenshot({ path: path.join(OUT, `FAIL-${name}.png`) });
  }
}
await browser.close();
