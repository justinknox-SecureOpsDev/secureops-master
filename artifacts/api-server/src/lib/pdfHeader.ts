import { brand } from "./brandConfig";
import { brandLogoPng } from "./brandLogo";

const NAVY = brand.colorNavy;
const GOLD = brand.colorGold;
const CREAM = brand.colorCream;

const LOGO_SIZE = 50;
const LOGO_X = 56;
const LOGO_Y = 14;
const BAND_HEIGHT = 122;

/**
 * Draw the standard branded PDF header band — navy background with the
 * company logo badge stacked above the gold company name, a cream subtitle
 * line, and a gold rule across the bottom of the band.
 *
 * Returns the Y coordinate just below the gold rule so callers can flow
 * their content from there (header height is not assumed to be constant).
 *
 * Logo embedding is best-effort: any failure is swallowed so a missing or
 * corrupt logo never breaks the document.
 */
export function drawBrandHeader(
  doc: PDFKit.PDFDocument,
  subtitle: string,
): number {
  const W = doc.page.width;

  doc.rect(0, 0, W, BAND_HEIGHT).fill(NAVY);

  // Logo badge above the company name.
  try {
    doc.image(brandLogoPng, LOGO_X, LOGO_Y, { fit: [LOGO_SIZE, LOGO_SIZE] });
  } catch {
    /* best-effort: never break the PDF over a logo */
  }

  const nameY = LOGO_Y + LOGO_SIZE + 6;
  doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(20)
    .text(brand.companyName, LOGO_X, nameY);
  doc.fillColor(CREAM).font("Helvetica").fontSize(10)
    .text(subtitle, LOGO_X, doc.y + 2);

  doc.rect(0, BAND_HEIGHT, W, 3).fill(GOLD);

  return BAND_HEIGHT + 3;
}
