/**
 * End-to-end check of every feature against a running dev server.
 *
 *   bun run dev            # in one terminal
 *   bun run e2e            # in another  (E2E_URL overrides http://localhost:5173)
 *
 * Drives a real Chromium with Playwright, prints PASS/FAIL per feature, and
 * saves screenshots to docs/screenshots/. Needs a Chromium: `npx playwright install chromium`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const ROOT = path.resolve(import.meta.dirname, "..");
const SHOTS = path.join(ROOT, "docs/screenshots");
const FIXTURES = path.join(ROOT, "scripts/fixtures");
mkdirSync(SHOTS, { recursive: true });

const only = process.argv.slice(2);
const results: { name: string; ok: boolean; detail: string }[] = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true }).catch(() =>
  chromium.launch({
    executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  })
);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
let page = await context.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
if (process.env.E2E_TRACE) {
  const t0 = Date.now();
  page.on("websocket", (ws) => {
    const tag = ws.url().split("?")[0].slice(-8);
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}] ws open ${tag}`);
    ws.on("close", () => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}] ws close ${tag}`));
    ws.on("framereceived", (f) => { const d = String(f.payload); if (!d.includes("text-delta") && !d.includes("app:log")) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}] < ${tag} ${d.slice(0, 160)}`); });
    ws.on("framesent", (f) => { const d = String(f.payload); if (!d.includes('"rpc"')) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}] > ${tag} ${d.slice(0, 90)}`); });
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function newChat(p: Page = page) {
  const before = await p.url();
  await p.getByTestId("new-chat").click();
  await p.waitForFunction((u) => location.href !== u, before);
  // Wait for the view bound to the NEW thread, not the previous (also empty) one.
  await p.waitForFunction(() => document.querySelector("[data-testid=chat]")?.getAttribute("data-thread") === new URL(location.href).searchParams.get("t"));
  await p.getByTestId("suggestion").first().waitFor();
}

async function send(text: string, files: string[] = [], p: Page = page) {
  if (files.length) await p.locator('input[type="file"]').setInputFiles(files);
  await p.getByTestId("prompt").fill(text);
  await p.getByTestId("prompt").press("Enter");
  // Attachments upload before the message appears; wait until it is on screen.
  await p.getByTestId("message-user").filter({ hasText: text.slice(0, 40) }).last().waitFor({ timeout: 30_000 });
}

async function waitIdle(p: Page = page, timeout = 120_000) {
  // Idle = the send button is back AND the newest message is a reply (or an error card).
  // The button alone can flicker to Submit right after a send, before the reply starts.
  await p.waitForFunction(
    () => {
      const idle = document.querySelector("[data-testid=send]")?.getAttribute("aria-label") === "Submit";
      const all = document.querySelectorAll("[data-testid^=message-]");
      const answered = all[all.length - 1]?.getAttribute("data-testid") === "message-assistant" || !!document.querySelector("[data-testid=chat-error]");
      return idle && answered;
    },
    null,
    { timeout }
  );
}

const lastAssistant = (p: Page = page) =>
  p.evaluate(() => {
    const all = document.querySelectorAll("[data-testid=message-assistant]");
    return (all[all.length - 1] as HTMLElement | undefined)?.innerText ?? "";
  });

const shot = (name: string, p: Page = page) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function check(name: string, fn: () => Promise<string>) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    const detail = await fn();
    // No feature may leave an error card behind, except the one that tests errors.
    if (!/error/i.test(name)) assert((await page.getByTestId("chat-error").count()) === 0, "unexpected error card");
    results.push({ name, ok: true, detail });
    console.log(`PASS (${((Date.now() - t) / 1000).toFixed(1)}s) ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL (${((Date.now() - t) / 1000).toFixed(1)}s) ${detail}`);
    await shot(`FAIL-${name.replace(/\W+/g, "-")}`).catch(() => {});
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ─── checks ───────────────────────────────────────────────────────────────────

await page.goto(BASE);
await page.getByTestId("thread-item").first().waitFor({ timeout: 30_000 });

await check("Empty state + new thread", async () => {
  await newChat();
  await shot("01-empty-state");
  return `${await page.getByTestId("suggestion").count()} suggestions`;
});

await check("Streaming + tool call (weather)", async () => {
  await send("What's the weather in London right now?");
  await page.getByTestId("tool-getWeather").waitFor({ timeout: 60_000 });
  await waitIdle();
  const text = await lastAssistant();
  assert(/°|degrees|celsius/i.test(text), `no temperature in reply: ${text.slice(0, 80)}`);
  await shot("02-tool-call");
  return text.split("\n").pop()!.slice(0, 70);
});

await check("Sub-agents in parallel (agent tool)", async () => {
  await newChat();
  await send(
    "Use two researcher sub-agents in parallel: one on Cloudflare Durable Objects, one on Vercel Workflow. Then compare them in three bullets."
  );
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=subagent-status]").length >= 2, null, { timeout: 90_000 });
  await shot("03-subagents-running");
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=subagent-status]")].every((e) => e.getAttribute("data-status") === "completed"),
    null,
    { timeout: 180_000 }
  );
  await waitIdle(page, 180_000);
  const tools = await page.getByTestId("subagent-tool").count();
  assert(tools >= 2, `sub-agents made ${tools} tool calls`);
  const sessions = await page.getByTestId("session-item").count();
  assert(sessions >= 2, `sidebar lists ${sessions} sessions`);
  await shot("03-subagents");
  return `2 runs, ${tools} tool calls, ${sessions} sessions in sidebar`;
});

await check("Open a sub-agent session and talk to it", async () => {
  const parentUrl = page.url();
  await page.getByTestId("open-session").first().click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("s"));
  await page.getByTestId("message-user").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=connection]")?.textContent?.includes("Live"), null, { timeout: 30_000 });
  await page.locator("[data-testid^=tool-wikipedia], [data-testid=tool-fetch_url]").first().waitFor({ timeout: 15_000 });
  const transcript = await page.locator("[data-testid=message-assistant]").count();
  assert(transcript > 0, "session has no assistant transcript");
  const childTools = await page.locator("[data-testid^=tool-wikipedia], [data-testid=tool-fetch_url]").count();
  assert(childTools > 0, "session transcript shows no tool calls");
  assert((await page.getByTestId("model-select").count()) === 0, "session shows the model picker");
  await page.waitForTimeout(800); // let the enter springs settle before the screenshot
  const sessionLogs = await page.locator("[data-testid=log-row]").count();
  assert(sessionLogs > 0, "session has no logs of its own");
  await shot("04-session");
  await send("In one sentence: what is the single most important fact you found?");
  await waitIdle();
  const reply = await lastAssistant();
  assert(reply.length > 20, "sub-agent did not reply");
  await page.getByTestId("session-parent").click();
  await page.waitForFunction((u) => location.href === u || !new URL(location.href).searchParams.has("s"), parentUrl);
  await page.getByTestId("subagent-runs").first().waitFor();
  return `${childTools} tool calls in child; follow-up: ${reply.slice(0, 50).replace(/\n/g, " ")}`;
});

await check("Background sub-agent notifies the parent", async () => {
  await send("In the background, have a writer sub-agent write a four-line poem about Durable Objects. Don't wait for it.");
  await waitIdle();
  await page.getByTestId("subagent-notice").waitFor({ timeout: 120_000 });
  await waitIdle(page, 120_000).catch(() => {});
  const bg = await page.locator("[data-testid=session-item][data-background=true]").count();
  return `notice delivered; ${bg} background session(s) in sidebar`;
});

await check("Human in the loop — approve", async () => {
  await newChat();
  await send("Email kai@example.com a two-line haiku about resumable streams. Subject: Haiku");
  await page.getByTestId("approve").waitFor({ timeout: 60_000 });
  await shot("04-approval");
  await page.getByTestId("approve").click();
  await page.getByText("Approved — email sent").waitFor({ timeout: 60_000 });
  // The turn must continue after the approval — and without an error card.
  await page.waitForFunction(() => /Sent|sent|email/i.test(([...document.querySelectorAll("[data-testid=message-assistant]")].pop() as HTMLElement | undefined)?.innerText.split("Approved — email sent")[1] ?? ""), null, { timeout: 60_000 });
  await waitIdle();
  assert((await page.getByTestId("chat-error").count()) === 0, "error card after approval");
  return (await lastAssistant()).split("Approved — email sent")[1].trim().slice(0, 50).replace(/\n/g, " ");
});

await check("Human in the loop — reject", async () => {
  await send("Now email bob@example.com the same haiku. Subject: Haiku");
  await page.getByTestId("reject").last().waitFor({ timeout: 60_000 });
  await page.getByTestId("reject").last().click();
  await page.getByText("Rejected — nothing was sent").waitFor({ timeout: 60_000 });
  await waitIdle();
  assert((await page.getByTestId("chat-error").count()) === 0, "error card after rejection");
  return "rejection recorded";
});

await check("Image attachment", async () => {
  await newChat();
  await send("What does this chart show? Which region is highest?", [path.join(FIXTURES, "edge-traffic-chart.png")]);
  await page.locator("[data-testid=message-user] img").first().waitFor({ timeout: 30_000 });
  await waitIdle();
  const text = await lastAssistant();
  assert(/asia/i.test(text), `model did not read the image: ${text.slice(0, 100)}`);
  await shot("05-image");
  return "model read the chart (Asia Pacific highest)";
});

await check("File attachment (markdown)", async () => {
  await send("Who owns the demo video and what is the budget?", [path.join(FIXTURES, "meeting-notes.md")]);
  await waitIdle();
  const text = await lastAssistant();
  assert(/priya/i.test(text) && /4,?200/.test(text), `file not read: ${text.slice(0, 120)}`);
  return "answered from the file";
});

await check("File attachment (PDF)", async () => {
  const pdfPage = await context.newPage();
  await pdfPage.setContent(
    "<h1>Invoice INV-2291</h1><p>Customer: Acme Robotics</p><p>Total due: $12,480.00</p><p>Due date: 31 October 2026</p>"
  );
  const pdfPath = path.join(ROOT, "scripts/fixtures/invoice.pdf");
  await pdfPage.pdf({ path: pdfPath, format: "A5" });
  await pdfPage.close();
  await send("What is the total due on this invoice, and for which customer?", [pdfPath]);
  await waitIdle();
  const text = await lastAssistant();
  assert(/12,?480/.test(text) && /acme/i.test(text), `PDF not read: ${text.slice(0, 120)}`);
  await shot("06-files");
  return "answered from the PDF";
});

await check("Error display + Retry", async () => {
  await newChat();
  await page.getByTestId("simulate-error").click();
  await send("Say hello in five words.");
  await page.getByTestId("chat-error").waitFor({ timeout: 60_000 });
  await shot("07-error");
  const message = await page.getByTestId("chat-error").innerText();
  await page.getByTestId("retry").click();
  await page.getByTestId("chat-error").waitFor({ state: "detached", timeout: 30_000 });
  await waitIdle();
  const text = await lastAssistant();
  assert(text.length > 3, "retry produced no answer");
  return `error "${message.split("\n")[1]?.slice(0, 50)}" → retried OK`;
});

await check("Logs panel", async () => {
  await page.getByTestId("tab-logs").click();
  await page.getByTestId("log-filter-errors").click();
  const errors = await page.getByTestId("log-row").count();
  await page.getByTestId("log-filter-app").click();
  const app = await page.getByTestId("log-row").count();
  assert(errors > 0 && app > 0, `logs missing (app ${app}, errors ${errors})`);
  await shot("08-logs");
  return `${app} app events, ${errors} error events`;
});

await check("Resume stream after reload", async () => {
  await newChat();
  await send("Write a 500-word story about a lighthouse keeper. Plain prose, no headings.");
  await page.waitForFunction(() => {
    const all = document.querySelectorAll("[data-testid=message-assistant]");
    return ((all[all.length - 1] as HTMLElement | undefined)?.innerText.length ?? 0) > 300;
  }, null, { timeout: 60_000 });
  const before = (await lastAssistant()).length;
  await page.reload();
  await page.getByTestId("message-assistant").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll("[data-testid=message-assistant]");
    return ((all[all.length - 1] as HTMLElement | undefined)?.innerText.length ?? 0) > n + 200;
  }, before, { timeout: 60_000 });
  await waitIdle();
  const after = (await lastAssistant()).length;
  assert(after > before + 600, `stream did not continue (${before} → ${after})`);
  await shot("09-resumed");
  return `${before} chars before reload → ${after} after`;
});

await check("Stop mid-stream", async () => {
  await send("Now write a 600-word sequel.");
  await page.waitForFunction(() => document.querySelector("[data-testid=send]")?.getAttribute("aria-label") === "Stop");
  await page.waitForTimeout(2500);
  await page.getByTestId("send").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=send]")?.getAttribute("aria-label") === "Submit", null, { timeout: 30_000 });
  const len = (await lastAssistant()).length;
  assert(len < 3000, `did not stop (${len} chars)`);
  return `stopped at ${len} chars`;
});

await check("Fork a chat", async () => {
  const parentTitle = await page.getByTestId("thread-title").innerText();
  const firstAssistant = page.getByTestId("message-assistant").first();
  await firstAssistant.hover();
  const before = page.url();
  await firstAssistant.getByTestId("branch").click();
  await page.waitForFunction((u) => location.href !== u, before, { timeout: 30_000 });
  await page.getByTestId("thread-title").filter({ hasText: "(Forked)" }).waitFor();
  const count = await page
    .waitForFunction(() => document.querySelectorAll("[data-testid^=message-]").length === 2, null, { timeout: 15_000 })
    .then(() => 2)
    .catch(() => page.locator("[data-testid^=message-]").count());
  assert(count === 2, `fork has ${count} messages, expected 2`);
  const top = page.getByTestId("thread-item").first();
  const topTitle = (await top.innerText()).replace(/\s+/g, " ").trim();
  assert(topTitle === `${parentTitle.replace(/ \(Forked\)$/, "")} (Forked)`, `fork is not the newest chat: ${topTitle}`);
  assert((await top.getAttribute("data-active")) === "true", "fork is not selected");
  await send("Give the story a one-line happy ending.");
  await waitIdle();
  await shot("10-branch");
  return `"(Forked)" chat with 2 copied messages, continues independently`;
});

await check("Model picker", async () => {
  await newChat();
  await page.getByTestId("model-select").click();
  await page.getByRole("option", { name: "Gemini 3.8 Flash" }).click();
  await page.getByTestId("model-select").filter({ hasText: "Gemini" }).waitFor({ timeout: 5_000 });
  await send("Reply with exactly one word: pong");
  await waitIdle();
  await page.getByTestId("tab-logs").click();
  await page.getByTestId("log-filter-app").click();
  const row = page.getByTestId("log-row").filter({ hasText: "turn:start" }).last();
  await row.locator("button").click();
  const data = await row.locator("pre").innerText();
  assert(data.includes("google/gemini-3.8-flash"), `turn ran on ${data.replace(/\s+/g, " ")} / picker: ${await page.getByTestId("model-select").innerText()}`);
  return "turn ran on google/gemini-3.8-flash";
});

await check("Durable background task survives a closed tab", async () => {
  await newChat();
  await send("Write me a report on edge computing");
  await page.getByTestId("task-card").first().waitFor({ timeout: 60_000 });
  await waitIdle();
  await shot("11-task-running");
  const url = page.url();
  await page.close(); // the tab is gone; the agent keeps working
  await new Promise((r) => setTimeout(r, 20_000));
  page = await context.newPage();
  await page.goto(url);
  await page.getByTestId("tab-tasks").click();
  await page.waitForSelector("[data-testid=task-card][data-status=completed]", { timeout: 150_000 });
  await page.getByText("Delivered by a background task").waitFor({ timeout: 30_000 });
  await shot("11-task-done");
  return "report finished while the tab was closed";
});

await check("Theme toggle", async () => {
  await page.getByTestId("theme-dark").click();
  assert(await page.evaluate(() => document.documentElement.classList.contains("dark")), "dark not applied");
  await shot("12-dark");
  await page.getByTestId("theme-light").click();
  assert(!(await page.evaluate(() => document.documentElement.classList.contains("dark"))), "light not applied");
  await page.getByTestId("theme-system").click();
  return "system / light / dark";
});

await check("Delete thread", async () => {
  const before = await page.getByTestId("thread-item").count();
  const row = page.getByTestId("thread-item").last();
  await row.hover();
  await page.locator('[aria-label="Delete chat"]').last().click();
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=thread-item]").length === n - 1, before, { timeout: 15_000 });
  return `${before} → ${before - 1} threads`;
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
