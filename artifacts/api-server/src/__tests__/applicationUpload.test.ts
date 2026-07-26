import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  resolveContentType,
  isAcceptedApplicationType,
  normalizeApplicationUpload,
} from "../routes/storage";

// Guards the public /apply (and /onboard, /amend) document-upload pipeline.
// The recurring "can't upload driver's license / SSN card" failure was iPhone
// HEIC photos: they were rejected outright, and even once accepted this build's
// sharp/libvips (AVIF-only, no HEVC) cannot decode them. These lock in HEIC
// acceptance plus a real ImageMagick HEIC->JPEG transcode.

/**
 * Encode a genuine HEVC HEIC via the same ImageMagick that decodes it in
 * production. `.heic` is HEVC by spec (AVIF is the AV1 variant), so this is the
 * closest stand-in for an iPhone photo available in the sandbox — and, notably,
 * sharp cannot read it, which is the whole reason the ImageMagick path exists.
 */
function makeRealHeic(): Buffer {
  const png = execFileSync(
    "magick",
    ["-size", "900x600", "gradient:navy-white", "png:-"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return execFileSync("magick", ["png:-", "heic:-"], {
    input: png,
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("application upload content-type resolution", () => {
  it("passes through a declared image type", () => {
    expect(resolveContentType("image/jpeg", "card.jpg")).toBe("image/jpeg");
  });

  it("recovers HEIC from the extension when the browser sends octet-stream", () => {
    expect(resolveContentType("application/octet-stream", "license.HEIC")).toBe("image/heic");
  });

  it("recovers DOCX from the extension when the type is empty", () => {
    expect(resolveContentType("", "cv.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("application upload accepted types", () => {
  it("accepts iPhone HEIC/HEIF, common images, and PDFs", () => {
    for (const t of ["image/heic", "image/heif", "image/jpeg", "image/png", "application/pdf"]) {
      expect(isAcceptedApplicationType(t)).toBe(true);
    }
  });

  it("rejects unrelated binary types", () => {
    for (const t of ["application/zip", "application/octet-stream", "video/mp4"]) {
      expect(isAcceptedApplicationType(t)).toBe(false);
    }
  });
});

describe("normalizeApplicationUpload", () => {
  it("decodes a real HEVC HEIC to a viewable JPEG (the iPhone case)", async () => {
    const heic = makeRealHeic();

    // Prove the premise: sharp parses the HEIF container header (it even reports
    // compression "hevc") but cannot decode the HEVC *pixels* — that decode is
    // exactly what ImageMagick provides. Asserting the pixel decode fails keeps
    // this test honest that the ImageMagick path is doing real work.
    await expect(sharp(heic).jpeg().toBuffer()).rejects.toThrow();

    const out = await normalizeApplicationUpload(heic, "image/heic", "drivers-license.heic");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.name).toBe("drivers-license.jpg");

    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width ?? 0).toBeGreaterThan(0);
    expect(meta.height ?? 0).toBeGreaterThan(0);
  });

  it("transcodes a regular raster photo of an ID to a viewable JPEG", async () => {
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const out = await normalizeApplicationUpload(png, "image/png", "ssn-card.png");
    expect(out.contentType).toBe("image/jpeg");
    expect(out.name).toBe("ssn-card.jpg");
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("downscales an oversized phone photo so stored bytes stay bounded", async () => {
    const huge = await sharp({
      create: { width: 6000, height: 4500, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const out = await normalizeApplicationUpload(huge, "image/jpeg", "big.jpg");
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(3000);
  });

  it("passes PDFs through untouched (no image processing)", async () => {
    const pdf = Buffer.from("%PDF-1.4 not a real pdf body");
    const out = await normalizeApplicationUpload(pdf, "application/pdf", "resume.pdf");
    expect(out.contentType).toBe("application/pdf");
    expect(out.name).toBe("resume.pdf");
    expect(out.buffer).toBe(pdf);
  });
});
