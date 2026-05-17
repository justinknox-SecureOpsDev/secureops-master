import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

export interface WatermarkInfo {
  recipientLabel: string;
  tokenShortId: string;
  accessedAt: Date;
}

function footerText(info: WatermarkInfo): string {
  const ts = info.accessedAt.toISOString().replace(/\.\d+Z$/, "Z");
  return `Confidential — issued to ${info.recipientLabel} • Share ${info.tokenShortId} • Accessed ${ts}`;
}

/**
 * Overlay a faint, single-line footer on every page of an existing PDF
 * buffer. The text records who the share recipient was, the short id
 * of the share token, and the moment the file was retrieved. The
 * source document in object storage is never modified — this only
 * mutates the in-memory copy we are about to stream to the recipient.
 *
 * Best-effort: PDFs that pdf-lib cannot parse (corrupt, password
 * protected, or using features pdf-lib does not support) cause this
 * to throw — the caller is expected to fall back to streaming the raw
 * bytes so the recipient still gets the file.
 */
export async function watermarkPdfBuffer(
  buf: Buffer,
  info: WatermarkInfo,
): Promise<Buffer> {
  const pdf = await PDFDocument.load(buf, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = footerText(info);
  const fontSize = 8;
  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    const textW = font.widthOfTextAtSize(text, fontSize);
    const x = Math.max(12, (width - textW) / 2);
    // Faint mid-grey at ~70% opacity. Visible enough to deter casual
    // forwarding, light enough not to obscure underlying content.
    page.drawText(text, {
      x,
      y: 12,
      size: fontSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
      opacity: 0.7,
    });
  }
  const out = await pdf.save({ useObjectStreams: false });
  return Buffer.from(out);
}

/**
 * Overlay a translucent bottom-edge banner on a raster image. Output
 * format is chosen to match the input where possible (PNG → PNG,
 * WebP → WebP, everything else → JPEG). EXIF orientation is honoured
 * so the banner lands at the visual bottom even if the file has a
 * rotation tag.
 */
export async function watermarkImageBuffer(
  buf: Buffer,
  info: WatermarkInfo,
): Promise<{ buffer: Buffer; contentType: string }> {
  const pipeline = sharp(buf, { failOn: "none" }).rotate();
  const meta = await pipeline.metadata();
  const w = meta.width ?? 1000;
  const h = meta.height ?? 1000;

  // Banner scales with the image but is clamped so it stays readable
  // on small thumbnails and doesn't dominate large scans.
  const bannerH = Math.max(22, Math.min(48, Math.round(h * 0.045)));
  const fontPx = Math.max(11, Math.round(bannerH * 0.55));

  const escaped = footerText(info)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const svg = `<svg width="${w}" height="${bannerH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${w}" height="${bannerH}" fill="black" fill-opacity="0.6"/>
    <text x="${Math.round(w / 2)}" y="${Math.round(bannerH * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-size="${fontPx}" fill="white" text-anchor="middle">${escaped}</text>
  </svg>`;

  const composited = pipeline.composite([
    { input: Buffer.from(svg), gravity: "south" },
  ]);

  const fmt = (meta.format ?? "").toLowerCase();
  if (fmt === "png") {
    return { buffer: await composited.png().toBuffer(), contentType: "image/png" };
  }
  if (fmt === "webp") {
    return { buffer: await composited.webp().toBuffer(), contentType: "image/webp" };
  }
  // gif/heif/avif and unknown → JPEG. Animated gifs lose animation;
  // this is acceptable for ID-card style scans which are the
  // realistic content here.
  return { buffer: await composited.jpeg({ quality: 88 }).toBuffer(), contentType: "image/jpeg" };
}

export function isPdfContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  return ct.toLowerCase().includes("pdf");
}

export function isWatermarkableImageContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  const lc = ct.toLowerCase();
  if (!lc.startsWith("image/")) return false;
  // Skip SVG (XML, not raster) and anything we cannot reliably re-encode.
  if (lc.includes("svg")) return false;
  return true;
}
