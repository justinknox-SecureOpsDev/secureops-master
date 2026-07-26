import puppeteer from 'puppeteer-core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const CHROMIUM = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';
const URL = 'http://localhost:8082/permission-video/';
const FPS = 30;
const DURATION_MS = 23500; // 8000 + 7000 + 8000 + 500ms buffer
const TOTAL_FRAMES = Math.ceil((DURATION_MS / 1000) * FPS);
const FRAMES_DIR = '/tmp/pv-frames';
const OUTPUT = 'attached_assets/location-permission-demo.mp4';

async function main() {
  // Clean frames dir
  try { rmSync(FRAMES_DIR, { recursive: true }); } catch {}
  mkdirSync(FRAMES_DIR, { recursive: true });

  console.log(`Launching Chromium...`);
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,720',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  console.log(`Navigating to ${URL}...`);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });

  // Give fonts/animations a moment to settle
  await new Promise(r => setTimeout(r, 800));

  console.log(`Capturing ${TOTAL_FRAMES} frames at ${FPS}fps...`);
  const interval = 1000 / FPS;

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = join(FRAMES_DIR, `frame-${String(i).padStart(5, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });
    if (i % 30 === 0) console.log(`  Frame ${i}/${TOTAL_FRAMES}`);
    await new Promise(r => setTimeout(r, interval));
  }

  await browser.close();
  console.log('Capture complete. Encoding with ffmpeg...');

  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', join(FRAMES_DIR, 'frame-%05d.png'),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    OUTPUT,
  ]);

  console.log(`Done! Output: ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
