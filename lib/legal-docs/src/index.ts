// Pure, browser-safe exports (field metadata, templates, fill logic).
// The pdfkit-based renderer is node-only and lives behind the
// "@workspace/legal-docs/pdf" subpath export.
export * from "./fields";
export * from "./fill";
export { LEGAL_TEMPLATES } from "./templates.generated";
