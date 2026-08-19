/**
 * Render the client-facing setup checklist to a shareable PDF.
 *
 * Source of truth: `docs/client-system-setup-checklist.md`.
 * Output:          `docs/client-system-setup-checklist.pdf`.
 *
 * Per customer: copy the markdown, fill in the "Prepared for" line and the
 * status column, then regenerate with `--in`/`--out` so each customer gets
 * their own PDF without editing the template. Missing output directories are
 * created.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run generate-onboarding-pdf
 *   pnpm --filter @workspace/scripts run generate-onboarding-pdf -- \
 *     --in docs/customers/acme-setup.md --out docs/customers/acme-setup.pdf \
 *     --title "Acme Security — Getting Your System Live"
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderLegalPdf, pdfToBuffer } from "@workspace/legal-docs/pdf";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const DEFAULT_IN = path.resolve(repoRoot, "docs", "client-system-setup-checklist.md");
const DEFAULT_OUT = path.resolve(repoRoot, "docs", "client-system-setup-checklist.pdf");
const DEFAULT_TITLE = "SecureOps Command — Getting Your System Live";

/**
 * Read `--flag value` from an argv list. A flag present with no value — or
 * immediately followed by another flag — is a mistake worth failing on
 * loudly, since the alternative is silently writing over the shared template
 * while the operator thinks they produced a per-customer copy.
 */
export function readFlag(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function resolvePaths(argv: readonly string[]): {
  input: string;
  output: string;
  title: string;
} {
  const inFlag = readFlag(argv, "--in");
  const outFlag = readFlag(argv, "--out");
  return {
    input: inFlag ? path.resolve(repoRoot, inFlag) : DEFAULT_IN,
    output: outFlag ? path.resolve(repoRoot, outFlag) : DEFAULT_OUT,
    title: readFlag(argv, "--title") ?? DEFAULT_TITLE,
  };
}

export async function generate(argv: readonly string[]): Promise<string> {
  const { input, output, title } = resolvePaths(argv);

  const markdown = readFileSync(input, "utf8");
  const doc = renderLegalPdf({
    title,
    markdown,
    bandLabel: "SecureOps Command — Client Setup Checklist",
  });

  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, await pdfToBuffer(doc));
  return output;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  generate(process.argv.slice(2))
    .then((output) => {
      console.log(`[generate-onboarding-pdf] wrote ${path.relative(repoRoot, output)}`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
