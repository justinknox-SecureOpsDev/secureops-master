// Deterministic video capture via an injected virtual clock + normal screenshots.
//
// Why not CDP virtual time? In new-headless Chromium 138, Page.captureScreenshot
// deadlocks after the *second* Emulation.setVirtualTimePolicy 'advance' — the
// compositor won't produce a frame while the virtual clock is paused (only the
// first capture succeeds). Normal screenshots, however, work reliably and
// repeatedly. So instead of controlling the browser clock, we control the
// *animation* clock in JS: before any app code runs we override rAF,
// performance.now, Date.now, setTimeout and setInterval, then step that clock by
// exactly 1000/FPS per frame. framer-motion & GSAP (rAF + performance.now) and
// the scene timers (setTimeout, see lib/video/hooks.ts) are all driven by it, so
// slow screenshots no longer speed up playback.
//
// React's scheduler uses MessageChannel (not the faked setTimeout), so faking
// timers doesn't stall it; after each clock step we yield one real macrotask via
// MessageChannel so scene-change re-renders flush before we screenshot.
//
// Because the result is deterministic, a long capture can be split across
// processes: --from/--count capture a slice (fast-forwarding the clock with no
// screenshots to reach --from), and --encode=1 encodes the whole frame dir.
//
// CLI: --url --dur(ms) --fps --out --from --count --encode(0|1) --settle --quality
import puppeteer from 'puppeteer-core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [[m[1], m[2]]] : [];
  }),
);

const CHROMIUM =
  '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';
const URL = args.url || 'http://localhost:8082/permission-video/?v=training';
const FPS = Number(args.fps || 30);
const DURATION_MS = Number(args.dur || 41000);
const TOTAL_FRAMES = Math.ceil((DURATION_MS / 1000) * FPS);
const FRAME_MS = 1000 / FPS;
const FROM = Number(args.from || 0);
const COUNT = args.count != null ? Number(args.count) : TOTAL_FRAMES - FROM;
const DO_ENCODE = String(args.encode ?? '1') !== '0';
const SETTLE_MS = Number(args.settle || 800);
const QUALITY = Number(args.quality || 92);
const FRAMES_DIR = args.framesDir || '/tmp/pv-frames-vt';
const OUTPUT = args.out || 'attached_assets/training-video.mp4';

// Runs INSIDE the page, before any app code, on every navigation.
function installClock() {
  let vnow = 0;
  let rafs = [];
  let rafId = 1;
  let timers = [];
  let timerId = 1;
  const realDateNow = Date.now();

  window.performance.now = () => vnow;
  Date.now = () => realDateNow + vnow;

  window.requestAnimationFrame = (cb) => {
    const id = rafId++;
    rafs.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafs = rafs.filter((r) => r.id !== id);
  };
  window.setTimeout = (cb, delay = 0, ...a) => {
    const id = timerId++;
    timers.push({ id, cb, time: vnow + Math.max(0, delay || 0), args: a, interval: 0 });
    return id;
  };
  window.clearTimeout = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };
  window.setInterval = (cb, delay = 0, ...a) => {
    const id = timerId++;
    const d = Math.max(1, delay || 1);
    timers.push({ id, cb, time: vnow + d, args: a, interval: d });
    return id;
  };
  window.clearInterval = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };

  window.__vnow = () => vnow;
  window.__advance = async (ms) => {
    const target = vnow + ms;
    const SUB = 1000 / 60; // ~60fps rAF cadence for smooth spring integration
    while (vnow < target) {
      const frameBoundary = Math.min(vnow + SUB, target);
      // Fire timers due within this sub-frame, in chronological order.
      for (;;) {
        const due = timers
          .filter((t) => t.time <= frameBoundary)
          .sort((a, b) => a.time - b.time)[0];
        if (!due) break;
        vnow = Math.max(vnow, due.time);
        if (due.interval > 0) due.time += due.interval;
        else timers = timers.filter((t) => t !== due);
        try { due.cb(...due.args); } catch (e) {}
      }
      vnow = frameBoundary;
      const batch = rafs;
      rafs = [];
      for (const r of batch) {
        try { r.cb(vnow); } catch (e) {}
      }
      // Flush microtasks (framer-motion batches renders on microtasks).
      await Promise.resolve();
      await Promise.resolve();
    }
    vnow = target;
  };

  // Real macrotask yield so React (MessageChannel scheduler) flushes state
  // updates such as scene changes before the next screenshot.
  window.__flush = () =>
    new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    });

  // The app calls these recording hooks; make them no-ops during capture.
  window.startRecording = async () => {};
  window.stopRecording = () => {};
}

async function main() {
  if (FROM === 0) {
    try { rmSync(FRAMES_DIR, { recursive: true }); } catch {}
  }
  mkdirSync(FRAMES_DIR, { recursive: true });

  const watchdog = setTimeout(() => {
    console.error('WATCHDOG: capture appears hung, exiting.');
    process.exit(3);
  }, Number(args.watchdog || 285000));
  if (watchdog.unref) watchdog.unref();

  console.log(`Launching Chromium for ${URL}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--window-size=1280,720',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(installClock);

    // Fail fast: a broken app must never silently encode into a "successful" MP4.
    const resp = await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    if (!resp || !resp.ok()) {
      throw new Error(
        `Navigation to ${URL} failed: ${resp ? resp.status() : 'no response'}`,
      );
    }
    // Let React mount at vnow=0 in real time (fonts/assets already loaded).
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    // Require the app-ready signal (set in lib/video/hooks.ts on mount). Poll
    // from Node with REAL timers -- the page's rAF/setTimeout are faked, so
    // page.waitForFunction (raf/timeout polling) would never fire.
    let mounted = false;
    for (let i = 0; i < 100 && !mounted; i++) {
      mounted = await page.evaluate(() => window.__replitVideoPlayerMounted === true);
      if (!mounted) await new Promise((r) => setTimeout(r, 100));
    }
    if (!mounted) {
      throw new Error(
        'App never signalled ready (window.__replitVideoPlayerMounted) within 10s',
      );
    }
    await page.evaluate(() => window.__flush());

    const step = async () => {
      await page.evaluate((ms) => window.__advance(ms), FRAME_MS);
      await page.evaluate(() => window.__flush());
    };

    // Fast-forward (no screenshots) to the first frame this slice needs.
    if (FROM > 0) {
      console.log(`Fast-forwarding clock to frame ${FROM}...`);
      for (let i = 0; i < FROM; i++) await step();
    }

    const last = Math.min(FROM + COUNT, TOTAL_FRAMES);
    console.log(`Capturing frames ${FROM}..${last - 1} of ${TOTAL_FRAMES} @ ${FPS}fps...`);
    const t0 = Date.now();
    for (let i = FROM; i < last; i++) {
      const buf = await page.screenshot({ type: 'jpeg', quality: QUALITY });
      writeFileSync(join(FRAMES_DIR, `frame-${String(i).padStart(5, '0')}.jpg`), buf);
      if (i === FROM || (i - FROM) % 60 === 0) {
        const done = i - FROM + 1;
        const rate = ((Date.now() - t0) / done).toFixed(0);
        console.log(`  Frame ${i}/${TOTAL_FRAMES}  (~${rate}ms/frame)`);
      }
      if (i < last - 1) await step();
    }

    await browser.close();
    browser = undefined;

    if (DO_ENCODE) {
      console.log('Encoding with ffmpeg...');
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-framerate', String(FPS),
          '-i', join(FRAMES_DIR, 'frame-%05d.jpg'),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '18',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          OUTPUT,
        ],
        { maxBuffer: 1 << 26 },
      );
      console.log(`Done! Output: ${OUTPUT}`);
    } else {
      console.log(`Captured slice ${FROM}..${last - 1}; skipping encode (frames in ${FRAMES_DIR}).`);
    }
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
