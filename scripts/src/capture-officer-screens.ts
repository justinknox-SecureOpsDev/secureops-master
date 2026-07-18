/**
 * One-off marketing-asset capture: drives the Expo web build of the Officer app
 * (dev server on :22706), proxies its same-origin `/api` calls to the local
 * api-server (:8080), and screenshots four officer screens at phone resolution
 * for the marketing site's Officer feature page.
 *
 * Auth + demo data are prepared out-of-band (a demo scenario is seeded into the
 * dev DB and a fresh officer JWT is written to `.local/state/officer-capture.json`);
 * this script only injects that token into localStorage and captures the screens.
 *
 * Not a CI gate — run on demand:
 *   pnpm --filter @workspace/scripts exec tsx src/capture-officer-screens.ts
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

// `window` is only referenced inside the Playwright addInitScript callback below,
// which is serialized and runs in the browser. This scripts package compiles with
// Node libs only (no DOM), so declare the minimal browser shape used here. This is
// type-only and erased at runtime.
declare const window: { localStorage: { setItem(key: string, value: string): void } };

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const EXPO = (process.env.EXPO_WEB_URL ?? "http://localhost:22706").replace(/\/$/, "");
const API_TARGET = (process.env.API_TARGET ?? "http://localhost:8080").replace(/\/$/, "");
const STATE = path.join(ROOT, ".local", "state", "officer-capture.json");
const OUT_DIR = path.join(ROOT, ".local", "state", "shots");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveChromium(): string {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return execSync("which chromium").toString().trim();
}

async function proxyApi(context: BrowserContext) {
  // The Expo web app talks to same-origin `/api` (window.location.origin + /api).
  // Metro has no API, so forward every /api call to the real api-server. Done
  // server-side (node fetch), so no CORS and the Authorization header passes
  // straight through.
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const orig = new URL(req.url());
    const target = `${API_TARGET}${orig.pathname}${orig.search}`;
    const method = req.method();
    const headers: Record<string, string> = { ...req.headers() };
    delete headers.host;
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const pd = req.postDataBuffer();
      if (pd) body = pd;
    }
    try {
      const resp = await fetch(target, { method, headers, body });
      const buf = Buffer.from(await resp.arrayBuffer());
      const h: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())) h[k] = v;
      });
      await route.fulfill({ status: resp.status, headers: h, body: buf });
    } catch (e) {
      await route.fulfill({ status: 502, contentType: "text/plain", body: `proxy error: ${String(e)}` });
    }
  });
}

async function main() {
  if (!fs.existsSync(STATE)) throw new Error(`Missing ${STATE} — seed the demo scenario first.`);
  const { token, user, roomId, roomName } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  if (!token || !user || !roomId) throw new Error("capture json missing token/user/roomId");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    timezoneId: "America/Chicago",
    colorScheme: "dark",
    // Mock a GPS fix at the seeded site so the Time Clock shows a located state
    // instead of "Location not available" (headless chromium has no geolocation).
    permissions: ["geolocation"],
    geolocation: { latitude: 32.7801, longitude: -96.8 },
  });

  // Boot authenticated: async-storage's web backend is plain localStorage with
  // raw keys, so these are exactly what AuthContext reads on startup. Also
  // pre-mark the first-run officer walkthrough as seen (TourContext key) so the
  // "Welcome to SecureOps" coach overlay never opens over the captured screens.
  await context.addInitScript(
    ([t, u, uid]) => {
      try {
        window.localStorage.setItem("auth_token", t as string);
        window.localStorage.setItem("auth_user", u as string);
        if (uid) window.localStorage.setItem(`wcsg.officer.tour.seen.${uid}`, "1");
      } catch { /* ignore */ }
    },
    [token, JSON.stringify(user), user.id as string] as const,
  );

  await proxyApi(context);
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("  [browser error]", m.text().slice(0, 160)); });

  const goHome = async () => {
    await page.goto(`${EXPO}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Good day", { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {});
  };

  const shots: Array<{ file: string; nav: () => Promise<void>; wait: string; label: string }> = [
    {
      file: "officer-emergency.png",
      nav: goHome,
      wait: "Good day",
      label: "Home / panic button",
    },
    {
      // /shifts collides with the admin Shifts route on cold deep-link, so reach
      // the employee "My Shifts" screen by tapping the tab (stays in the employee
      // navigator), then switch to the "Upcoming" filter (default is "Available").
      file: "officer-shifts.png",
      nav: async () => {
        await goHome();
        await page.getByText("My Shifts", { exact: true }).first().click();
        await page.getByRole("tab", { name: "Upcoming shifts" }).click({ timeout: 15_000 })
          .catch(async () => { await page.getByText("Upcoming", { exact: true }).first().click().catch(() => {}); });
      },
      wait: "Confirmed",
      label: "My Shifts (upcoming)",
    },
    {
      file: "officer-clockin.png",
      nav: async () => { await page.goto(`${EXPO}/clock`, { waitUntil: "domcontentloaded", timeout: 60_000 }); },
      wait: "Clock In",
      label: "Clock",
    },
    {
      file: "officer-chat.png",
      nav: async () => { await page.goto(`${EXPO}/chat/${roomId}?name=${encodeURIComponent(roomName)}`, { waitUntil: "domcontentloaded", timeout: 60_000 }); },
      wait: "lobby doors unlock",
      label: "Team chat",
    },
  ];

  for (const s of shots) {
    console.log(`\n→ ${s.label}`);
    await s.nav();
    try {
      await page.getByText(s.wait, { exact: false }).first().waitFor({ timeout: 20_000 });
    } catch {
      console.log(`  (wait text "${s.wait}" not found — capturing anyway)`);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(1500);
    const out = path.join(OUT_DIR, s.file);
    await page.screenshot({ path: out, type: "png" });
    console.log(`  saved ${out}`);
  }

  await browser.close();
  console.log("\nDone. Shots in", OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
