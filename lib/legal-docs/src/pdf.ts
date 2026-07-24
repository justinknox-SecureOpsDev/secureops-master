/**
 * Node-only markdown → PDF renderer for SOBBU platform legal documents.
 *
 * Deliberately neutral SOBBU branding (dark charcoal band, "SOBBU LLC")
 * — these are SOBBU's own documents, so the tenant-branded drawBrandHeader
 * from the api-server must NEVER be used here.
 *
 * Used by:
 *  - scripts/src/generate-legal-pdfs.ts — regenerates the blank template PDFs
 *    committed to legal/ and artifacts/admin-portal/public/legal/.
 *  - the api-server signing routes — renders the filled, signed snapshot with
 *    an appended electronic-signature certificate.
 */
import PDFDocument from "pdfkit";
import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];

const MARGIN = 56;
const BAND_HEIGHT = 92;
const INK = "#1a1a1a";
const SUBTLE = "#555555";
const FAINT = "#8a8a8a";
const RULE = "#d8d8d8";
const BAND = "#111111";

type InlineRun = { text: string; bold: boolean; italic: boolean; code: boolean };

type Block =
  | { type: "heading"; level: number; runs: InlineRun[] }
  | { type: "para"; runs: InlineRun[]; indent: number; bullet?: string; quote: boolean }
  | { type: "table"; header: InlineRun[][]; rows: InlineRun[][][] }
  | { type: "hr" };

function inlineRuns(tokens: Token[] | null): InlineRun[] {
  const runs: InlineRun[] = [];
  if (!tokens) return runs;
  let bold = 0;
  let italic = 0;
  const push = (text: string, code = false) => {
    if (!text) return;
    runs.push({ text, bold: bold > 0, italic: italic > 0, code });
  };
  for (const t of tokens) {
    switch (t.type) {
      case "strong_open": bold++; break;
      case "strong_close": bold = Math.max(0, bold - 1); break;
      case "em_open": italic++; break;
      case "em_close": italic = Math.max(0, italic - 1); break;
      case "code_inline": push(t.content, true); break;
      case "text": push(t.content); break;
      case "softbreak": push(" "); break;
      case "hardbreak": push("\n"); break;
      default:
        // link_open/close render as their inner text; html is disabled.
        break;
    }
  }
  return runs;
}

/** Flatten the markdown-it token stream into simple renderable blocks. */
function tokensToBlocks(tokens: Token[]): Block[] {
  const blocks: Block[] = [];
  type ListCtx = { ordered: boolean; index: number };
  const listStack: ListCtx[] = [];
  let quoteDepth = 0;
  let pendingBullet: string | null = null;

  // Table accumulation state
  let table: { header: InlineRun[][]; rows: InlineRun[][][] } | null = null;
  let tableRow: InlineRun[][] | null = null;
  let inHead = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open": {
        const inline = tokens[i + 1];
        blocks.push({
          type: "heading",
          level: Number(t.tag.slice(1)),
          runs: inlineRuns(inline?.type === "inline" ? inline.children : null),
        });
        i += 2; // skip inline + heading_close
        break;
      }
      case "paragraph_open": {
        const inline = tokens[i + 1];
        const runs = inlineRuns(inline?.type === "inline" ? inline.children : null);
        const indent = listStack.length;
        blocks.push({
          type: "para",
          runs,
          indent,
          ...(pendingBullet ? { bullet: pendingBullet } : {}),
          quote: quoteDepth > 0,
        });
        pendingBullet = null;
        i += 2; // skip inline + paragraph_close
        break;
      }
      case "bullet_list_open":
        listStack.push({ ordered: false, index: 0 });
        break;
      case "ordered_list_open":
        listStack.push({ ordered: true, index: 0 });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listStack.pop();
        break;
      case "list_item_open": {
        const ctx = listStack[listStack.length - 1];
        if (ctx) {
          ctx.index++;
          pendingBullet = ctx.ordered ? `${ctx.index}.` : "\u2022";
        }
        break;
      }
      case "blockquote_open": quoteDepth++; break;
      case "blockquote_close": quoteDepth = Math.max(0, quoteDepth - 1); break;
      case "hr": blocks.push({ type: "hr" }); break;
      case "table_open":
        table = { header: [], rows: [] };
        break;
      case "table_close":
        if (table) blocks.push({ type: "table", ...table });
        table = null;
        break;
      case "thead_open": inHead = true; break;
      case "thead_close": inHead = false; break;
      case "tr_open": tableRow = []; break;
      case "tr_close":
        if (table && tableRow) {
          if (inHead) table.header = tableRow;
          else table.rows.push(tableRow);
        }
        tableRow = null;
        break;
      case "th_open":
      case "td_open": {
        const inline = tokens[i + 1];
        tableRow?.push(inlineRuns(inline?.type === "inline" ? inline.children : null));
        i += 2; // skip inline + close
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function pickFont(run: InlineRun, baseBold = false): string {
  if (run.code) return "Courier";
  const bold = run.bold || baseBold;
  if (bold && run.italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (run.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function runsPlainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join("");
}

type WriteOpts = {
  x: number;
  width: number;
  size: number;
  color: string;
  baseBold?: boolean;
  lineGap?: number;
};

function writeRuns(doc: PDFKit.PDFDocument, runs: InlineRun[], o: WriteOpts): void {
  if (runs.length === 0) {
    doc.moveDown(0.4);
    return;
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const last = i === runs.length - 1;
    doc
      .font(pickFont(r, o.baseBold))
      .fontSize(r.code ? o.size - 0.5 : o.size)
      .fillColor(o.color);
    const textOpts = { width: o.width, continued: !last, lineGap: o.lineGap ?? 2 };
    if (i === 0) doc.text(r.text, o.x, doc.y, textOpts);
    else doc.text(r.text, textOpts);
  }
}

function contentBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > contentBottom(doc)) {
    doc.addPage();
  }
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN * 2;
}

function drawSobbuBand(doc: PDFKit.PDFDocument, subtitle: string): void {
  const W = doc.page.width;
  doc.rect(0, 0, W, BAND_HEIGHT).fill(BAND);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18).text("SOBBU LLC", MARGIN, 24);
  doc.fillColor("#c9c9c9").font("Helvetica").fontSize(9.5).text(subtitle, MARGIN, doc.y + 3);
  doc.rect(0, BAND_HEIGHT, W, 2).fill("#3a3a3a");
  doc.x = MARGIN;
  doc.y = BAND_HEIGHT + 24;
  doc.fillColor(INK);
}

function renderBlocks(doc: PDFKit.PDFDocument, blocks: Block[]): void {
  const w = contentWidth(doc);
  for (const b of blocks) {
    switch (b.type) {
      case "heading": {
        const sizes: Record<number, number> = { 1: 17, 2: 12.5, 3: 11, 4: 10 };
        const size = sizes[b.level] ?? 10;
        ensureSpace(doc, size * 4);
        doc.moveDown(b.level === 1 ? 0.4 : b.level === 2 ? 1.1 : 0.8);
        writeRuns(doc, b.runs, { x: MARGIN, width: w, size, color: INK, baseBold: true });
        if (b.level <= 2) {
          const y = doc.y + 4;
          doc.moveTo(MARGIN, y).lineTo(MARGIN + w, y).lineWidth(0.6).strokeColor(RULE).stroke();
          doc.y = y + 8;
        } else {
          doc.moveDown(0.35);
        }
        doc.x = MARGIN;
        break;
      }
      case "para": {
        const indent = b.indent > 0 ? (b.indent - 1) * 14 : 0;
        const quoteIndent = b.quote ? 14 : 0;
        const x0 = MARGIN + indent + quoteIndent;
        ensureSpace(doc, 28);
        if (b.bullet) {
          const labelW = b.bullet === "\u2022" ? 12 : 18;
          const y0 = doc.y;
          doc
            .font("Helvetica")
            .fontSize(9.5)
            .fillColor(b.quote ? SUBTLE : INK)
            .text(b.bullet, x0, y0, { width: labelW, lineBreak: false });
          doc.y = y0;
          writeRuns(doc, b.runs, {
            x: x0 + labelW,
            width: w - indent - quoteIndent - labelW,
            size: 9.5,
            color: b.quote ? SUBTLE : INK,
          });
          doc.moveDown(0.25);
        } else if (b.quote) {
          writeRuns(doc, b.runs.map((r) => ({ ...r, italic: true })), {
            x: x0,
            width: w - quoteIndent - 6,
            size: 9,
            color: SUBTLE,
          });
          doc.moveDown(0.55);
        } else {
          writeRuns(doc, b.runs, { x: x0, width: w - indent, size: 9.5, color: INK });
          doc.moveDown(0.55);
        }
        doc.x = MARGIN;
        break;
      }
      case "table": {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const colWs =
          cols === 2
            ? [w * 0.34, w * 0.66]
            : Array.from({ length: cols }, () => w / cols);
        const pad = 5;
        const drawRow = (cells: InlineRun[][], bold: boolean): void => {
          doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
          let h = 0;
          for (let c = 0; c < cols; c++) {
            const text = runsPlainText(cells[c] ?? []);
            const cellH = doc.heightOfString(text || " ", { width: colWs[c] - pad * 2 });
            h = Math.max(h, cellH);
          }
          h += pad * 2;
          if (doc.y + h > contentBottom(doc)) doc.addPage();
          const rowY = doc.y;
          let cx = MARGIN;
          for (let c = 0; c < cols; c++) {
            doc.y = rowY + pad;
            writeRuns(doc, cells[c] ?? [], {
              x: cx + pad,
              width: colWs[c] - pad * 2,
              size: 9,
              color: INK,
              baseBold: bold,
            });
            cx += colWs[c];
          }
          doc.y = rowY + h;
          doc
            .moveTo(MARGIN, doc.y)
            .lineTo(MARGIN + w, doc.y)
            .lineWidth(0.5)
            .strokeColor(RULE)
            .stroke();
        };
        doc.moveDown(0.3);
        doc
          .moveTo(MARGIN, doc.y)
          .lineTo(MARGIN + w, doc.y)
          .lineWidth(0.5)
          .strokeColor(RULE)
          .stroke();
        doc.y += 1;
        if (b.header.length > 0) drawRow(b.header, true);
        for (const row of b.rows) drawRow(row, false);
        doc.moveDown(0.7);
        doc.x = MARGIN;
        break;
      }
      case "hr": {
        ensureSpace(doc, 20);
        doc.moveDown(0.4);
        doc
          .moveTo(MARGIN, doc.y)
          .lineTo(MARGIN + w, doc.y)
          .lineWidth(0.75)
          .strokeColor(RULE)
          .stroke();
        doc.moveDown(0.6);
        doc.x = MARGIN;
        break;
      }
    }
  }
}

export type SignatureCertificate = {
  documentTitle: string;
  documentSha256: string;
  consentText: string;
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  signatureText: string;
  signedAtIso: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * MSA only: pass the executed guaranty, or "not_executed" to print an
   * explicit note. Omit entirely for the User Agreement.
   */
  guaranty?:
    | { name: string; title: string; address: string; signatureText: string; consentText: string }
    | "not_executed";
};

function certRow(doc: PDFKit.PDFDocument, label: string, value: string, opts?: { font?: string; size?: number }): void {
  const w = contentWidth(doc);
  const labelW = 130;
  ensureSpace(doc, 26);
  const y0 = doc.y;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(SUBTLE).text(label.toUpperCase(), MARGIN, y0, {
    width: labelW,
    lineBreak: false,
  });
  doc.y = y0;
  doc
    .font(opts?.font ?? "Helvetica")
    .fontSize(opts?.size ?? 9)
    .fillColor(INK)
    .text(value, MARGIN + labelW, y0, { width: w - labelW, lineGap: 1.5 });
  doc.moveDown(0.45);
  doc.x = MARGIN;
}

function renderSignatureCertificate(doc: PDFKit.PDFDocument, sig: SignatureCertificate): void {
  const w = contentWidth(doc);
  ensureSpace(doc, 200);
  doc.moveDown(1.4);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + w, doc.y).lineWidth(1).strokeColor(BAND).stroke();
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(INK)
    .text("Electronic Signature Certificate", MARGIN);
  doc.moveDown(0.6);

  const signedAt = new Date(sig.signedAtIso);
  const signedAtText = isNaN(signedAt.getTime())
    ? sig.signedAtIso
    : `${signedAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`;

  certRow(doc, "Document", sig.documentTitle);
  certRow(doc, "SHA-256", sig.documentSha256, { font: "Courier", size: 7.5 });
  certRow(doc, "Signed by", `${sig.signerName} — ${sig.signerTitle} (${sig.signerEmail})`);
  certRow(doc, "Signature", sig.signatureText, { font: "Helvetica-BoldOblique", size: 13 });
  certRow(doc, "Signed at", signedAtText);
  if (sig.ipAddress) certRow(doc, "IP address", sig.ipAddress);
  if (sig.userAgent) certRow(doc, "User agent", sig.userAgent, { size: 7.5 });
  certRow(doc, "Consent", sig.consentText, { size: 8 });

  if (sig.guaranty === "not_executed") {
    doc.moveDown(0.4);
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor(SUBTLE)
      .text("Personal Guaranty (Exhibit C): not executed.", MARGIN);
  } else if (sig.guaranty) {
    doc.moveDown(0.6);
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .fillColor(INK)
      .text("Personal Guaranty (Exhibit C) — executed", MARGIN);
    doc.moveDown(0.4);
    certRow(doc, "Guarantor", `${sig.guaranty.name} — ${sig.guaranty.title}`);
    certRow(doc, "Address", sig.guaranty.address);
    certRow(doc, "Signature", sig.guaranty.signatureText, {
      font: "Helvetica-BoldOblique",
      size: 13,
    });
    certRow(doc, "Consent", sig.guaranty.consentText, { size: 8 });
  }
}

export type RenderLegalPdfOptions = {
  /** Document title for PDF metadata and the footer. */
  title: string;
  markdown: string;
  /** When present, appends the electronic-signature certificate. */
  signature?: SignatureCertificate | null;
};

/**
 * Render a legal document to a PDFDocument. The caller is responsible for
 * piping the returned document and it MUST NOT call doc.end() — this
 * function already does.
 */
export function renderLegalPdf(opts: RenderLegalPdfOptions): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 64, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: opts.title, Author: "SOBBU LLC" },
  });

  drawSobbuBand(doc, "SecureOps Command \u2014 Platform Legal Document");

  const md = new MarkdownIt({ html: false });
  const blocks = tokensToBlocks(md.parse(opts.markdown, {}));
  renderBlocks(doc, blocks);

  if (opts.signature) renderSignatureCertificate(doc, opts.signature);

  // Footer with page numbers on every page.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 40;
    doc.font("Helvetica").fontSize(7.5).fillColor(FAINT);
    doc.text(`SOBBU LLC \u2014 ${opts.title}`, MARGIN, y, { lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN, y, {
      width: contentWidth(doc),
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return doc;
}

/** Collect a finished PDFDocument stream into a single Buffer. */
export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
