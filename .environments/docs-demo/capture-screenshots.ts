/**
 * Screenshot capture script for NimbleBrain User Guide documentation.
 * Uses Chrome DevTools Protocol over WebSocket to navigate and capture.
 *
 * Usage: bun run .environments/docs-demo/capture-screenshots.ts
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - NimbleBrain demo server running on :27252
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CDP_HOST = "127.0.0.1:9222";
const BASE_URL = "http://localhost:27252";
const OUTPUT_DIR = join(import.meta.dir, "../../docs/src/assets/guide");

// ── CDP helpers ───────────────────────────────────────────────────

let msgId = 0;

function cdp(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.id === id) {
        ws.removeEventListener("message", handler);
        if (data.error) reject(new Error(`CDP error: ${data.error.message}`));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitForEvent(ws: WebSocket, eventName: string, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeout);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.method === eventName) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data.params);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function navigate(ws: WebSocket, url: string) {
  await cdp(ws, "Page.enable");
  const nav = cdp(ws, "Page.navigate", { url });
  const loaded = waitForEvent(ws, "Page.loadEventFired", 20000);
  await nav;
  await loaded;
  // Extra wait for React hydration and API calls
  await sleep(3000);
}

async function screenshot(ws: WebSocket, filename: string, opts: { clip?: any; fullPage?: boolean } = {}) {
  const params: Record<string, unknown> = {
    format: "png",
    captureBeyondViewport: false,
  };
  if (opts.clip) params.clip = opts.clip;

  const result = await cdp(ws, "Page.captureScreenshot", params);
  const buffer = Buffer.from(result.data, "base64");
  const path = join(OUTPUT_DIR, filename);
  await writeFile(path, buffer);
  console.log(`  ✓ ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
}

async function setViewport(ws: WebSocket, width: number, height: number) {
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
}

async function clickElement(ws: WebSocket, selector: string) {
  // Get element position
  const { result } = await cdp(ws, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('${selector}');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  if (!result.value) {
    console.log(`  ⚠ Element not found: ${selector}`);
    return false;
  }
  const { x, y } = result.value;
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return true;
}

async function pressKey(ws: WebSocket, key: string) {
  await cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    text: key,
    unmodifiedText: key,
  });
  await cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
  });
}

async function evaluateJS(ws: WebSocket, expression: string): Promise<any> {
  const { result } = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Get the page's WebSocket URL
  const response = await fetch(`http://${CDP_HOST}/json/list`);
  const pages = await response.json();
  const page = pages.find((p: any) => p.url.includes("localhost:27252")) ?? pages[0];
  if (!page) {
    console.error("No Chrome page found. Open http://localhost:27252 in Chrome first.");
    process.exit(1);
  }

  console.log(`Connecting to page: ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });

  console.log("Connected to Chrome DevTools Protocol\n");

  // Set viewport to 1440x900 at 2x for retina screenshots
  await setViewport(ws, 1440, 900);

  // ── Force light mode ──
  console.log("Navigating to Product workspace...");
  await navigate(ws, `${BASE_URL}/w/product/`);
  await sleep(2000);
  console.log("Forcing light mode...");
  await evaluateJS(ws, `
    localStorage.setItem('nb-theme', 'light');
    document.documentElement.classList.remove('dark');
  `);
  await sleep(500);

  // ── 1. Interface layout — full page with chat closed ──
  console.log("\n1. Interface layout (sidebar + home)");
  await screenshot(ws, "interface-layout.png");

  // ── 2. Chat messages — open a conversation ──
  console.log("\n2. Chat with messages and tool calls");
  // Click on Conversations in sidebar
  await clickElement(ws, '[data-route="@nimblebraininc/conversations"]');
  await sleep(2000);
  await screenshot(ws, "conversations-list.png");

  // ── 3. Try to open a conversation by navigating directly ──
  console.log("\n3. Opening conversation with tool calls");
  // Use the chat panel - try pressing Cmd+K to open chat
  await cdp(ws, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    text: "k",
    modifiers: 4, // meta (cmd)
  });
  await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", modifiers: 4 });
  await sleep(1500);
  await screenshot(ws, "chat-panel-open.png");

  // ── 4. Workspace selector dropdown ──
  console.log("\n4. Workspace selector dropdown");
  await navigate(ws, `${BASE_URL}/w/product/`);
  await sleep(2000);
  // Click the workspace selector button (top of sidebar)
  const clicked = await clickElement(ws, '[data-testid="workspace-selector"], button:has([data-slot="workspace-selector"]), .workspace-selector');
  if (!clicked) {
    // Try finding it by text content
    await evaluateJS(ws, `
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('Product') && btn.closest('aside,nav,[role="navigation"]')) {
          btn.click();
          break;
        }
      }
    `);
  }
  await sleep(1000);
  await screenshot(ws, "workspaces-selector.png");
  // Close dropdown by clicking elsewhere
  await clickElement(ws, "main");
  await sleep(500);

  // ── 5. Settings - Profile ──
  console.log("\n5. Settings pages");
  await navigate(ws, `${BASE_URL}/settings`);
  await sleep(2000);
  await screenshot(ws, "settings-profile.png");

  // ── 6. Settings - Usage ──
  console.log("  Usage tab");
  await navigate(ws, `${BASE_URL}/settings/usage`);
  await sleep(2000);
  await screenshot(ws, "settings-usage.png");

  // ── 7. Settings - Model ──
  console.log("  Model tab");
  await navigate(ws, `${BASE_URL}/settings/model`);
  await sleep(2000);
  await screenshot(ws, "settings-model.png");

  // ── 8. Settings - Users ──
  console.log("  Users tab");
  await navigate(ws, `${BASE_URL}/settings/users`);
  await sleep(2000);
  await screenshot(ws, "team-users.png");

  // ── 9. Settings - About ──
  console.log("  About tab");
  await navigate(ws, `${BASE_URL}/settings/about`);
  await sleep(2000);
  await screenshot(ws, "settings-about.png");

  // ── 10. Keyboard shortcuts modal ──
  console.log("\n6. Keyboard shortcuts modal");
  await navigate(ws, `${BASE_URL}/w/product/`);
  await sleep(2000);
  await pressKey(ws, "?");
  await sleep(1000);
  await screenshot(ws, "shortcuts-modal.png");

  // ── 11. Sidebar focused shot ──
  console.log("\n7. Sidebar detail");
  // Navigate back to main with chat open for a composite shot
  await navigate(ws, `${BASE_URL}/w/product/`);
  await sleep(2000);
  // Capture just the left portion (sidebar)
  await screenshot(ws, "apps-sidebar.png", {
    clip: { x: 0, y: 0, width: 280, height: 900, scale: 1 },
  });

  console.log("\n✅ All screenshots captured to:", OUTPUT_DIR);

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
