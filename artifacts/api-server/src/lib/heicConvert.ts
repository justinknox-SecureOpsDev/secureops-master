import { spawn } from "node:child_process";

/**
 * HEIC/HEIF decode for anonymous HR application uploads.
 *
 * Why a subprocess instead of sharp: this environment's libvips/sharp is built
 * with AVIF-only HEIF support (no HEVC codec), so `sharp` CANNOT decode a real
 * iPhone HEIC (which is HEVC). ImageMagick's libheif carries the HEVC decoder,
 * so we shell out to it for just the HEIC→JPEG step. `imagemagick` is a declared
 * system dependency (see replit.nix) so the binary is present in prod too.
 */

const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const HARD_TIMEOUT_MS = 20_000;

/**
 * Resource ceilings for the untrusted ImageMagick subprocess. This endpoint is
 * unauthenticated, so a hostile HEIC must not be able to exhaust host memory,
 * disk, or CPU. `MAGICK_TIME_LIMIT` bounds CPU seconds; a wall-clock kill below
 * backs it up; `MAGICK_AREA_LIMIT` caps decoded pixels (decompression bombs).
 */
const IM_LIMITS: Record<string, string> = {
  MAGICK_MEMORY_LIMIT: "256MiB",
  MAGICK_MAP_LIMIT: "512MiB",
  MAGICK_DISK_LIMIT: "1GiB",
  MAGICK_AREA_LIMIT: "128MP",
  MAGICK_TIME_LIMIT: "15",
  MAGICK_THREAD_LIMIT: "2",
};

/**
 * Decode a HEIC/HEIF still image to a normalized JPEG using ImageMagick.
 * Output is EXIF-auto-oriented, metadata-stripped (drops GPS from ID photos),
 * capped at 3000px on the long edge, and re-encoded at quality 82 — so the
 * stored driver's-license / SSN-card image is viewable in every admin browser.
 *
 * Rejects on decode failure, timeout, missing binary, or oversized output; the
 * caller maps a rejection to a user-facing 422.
 */
export function heicBufferToJpeg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Force the input coder (`heic:-`) so a mislabeled or hostile upload can't
    // trick ImageMagick into interpreting the bytes as some other delegate.
    const args = [
      "heic:-",
      "-auto-orient",
      "-strip",
      "-resize",
      "3000x3000>",
      "-quality",
      "82",
      "jpeg:-",
    ];

    const child = spawn("magick", args, {
      env: { ...process.env, ...IM_LIMITS },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    let outLen = 0;
    const err: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("HEIC conversion timed out")));
    }, HARD_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("HEIC conversion output too large")));
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 20) err.push(d);
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      if (code === 0 && outLen > 0) {
        finish(() => resolve(Buffer.concat(out)));
        return;
      }
      const detail = Buffer.concat(err).toString("utf8").split("\n")[0].slice(0, 200);
      finish(() => reject(new Error(`HEIC conversion failed (exit ${code}): ${detail}`)));
    });

    // Ignore EPIPE if ImageMagick exits before consuming all of stdin.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
