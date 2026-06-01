/**
 * Static accessibility-label lint for the SecureOps Expo mobile app.
 *
 * The admin portal has a runtime axe-core scan (`a11y-admin-portal.ts`), but the
 * React Native app can't be driven the same way. Instead, this check parses the
 * officer screens with the TypeScript compiler API and flags interactive
 * elements that ship without a screen-reader label or role — the kind of
 * regression that's invisible until a VoiceOver/TalkBack user hits it.
 *
 * What it flags: any <TouchableOpacity>, <TouchableHighlight>,
 * <TouchableWithoutFeedback>, <Pressable>, <Switch> or <TextInput> that declares
 * neither `accessibilityLabel` nor `accessibilityRole`.
 *
 * Escape hatches (an element is considered intentionally handled if it has any):
 *   - accessibilityLabel / aria-label
 *   - accessibilityRole / role
 *   - accessible={false}                       (children are exposed individually)
 *   - accessibilityElementsHidden              (iOS: hidden from VoiceOver)
 *   - importantForAccessibility (= "no" / "no-hide-descendants" on Android)
 *   - aria-hidden
 *   - a JSX spread ({...props}) — can't be verified statically, so trusted
 *
 * Scope: the officer (employee) screens that have been made screen-reader
 * friendly. Add files to OFFICER_SCREEN_GLOBS as more screens are hardened.
 *
 * Run on demand:
 *   pnpm --filter @workspace/scripts run a11y-mobile
 *
 * No workflow / device / DB required — it's pure static analysis.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import ts from "typescript";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP_ROOT = resolve(HERE, "../../artifacts/security-ops");

// Officer-facing screens that have been made screen-reader friendly and must
// stay that way. Globs are resolved relative to the Expo app root.
const OFFICER_SCREEN_GLOBS = [
  "app/(employee)/home.tsx",
  "app/(employee)/shifts.tsx",
  "app/(employee)/clock.tsx",
  "app/(employee)/incidents.tsx",
  "app/(employee)/profile.tsx",
  "components/chat/ChatRoomScreen.tsx",
  "components/chat/ChatRoomsList.tsx",
];

// Admin-facing screens that have been made screen-reader friendly and must
// stay that way. Chat screens (app/(admin)/chat.tsx, chat/[id].tsx) are
// intentionally excluded — they're hardened under a separate chat-a11y effort.
// NB: expo-router dynamic-route filenames contain literal square brackets
// (e.g. [id].tsx). node:fs globSync treats `[...]` as a character class, so the
// brackets are escaped POSIX-style as `[[]` and `[]]` to match them literally.
const ADMIN_SCREEN_GLOBS = [
  "app/(admin)/dashboard.tsx",
  "app/(admin)/employees.tsx",
  "app/(admin)/employees/[[]id[]].tsx",
  "app/(admin)/employees/create.tsx",
  "app/(admin)/incidents.tsx",
  "app/(admin)/live-map.tsx",
  "app/(admin)/payroll.tsx",
  "app/(admin)/invoices.tsx",
  "app/(admin)/licenses.tsx",
  "app/(admin)/license-approvals.tsx",
  "app/(admin)/clients.tsx",
  "app/(admin)/clients/[[]id[]].tsx",
  "app/(admin)/time-approval.tsx",
  "app/(admin)/shifts/index.tsx",
  "app/(admin)/shifts/[[]id[]].tsx",
  "app/(admin)/shifts/create.tsx",
  "app/(admin)/shifts/edit/[[]shiftId[]].tsx",
];

const SCREEN_GLOBS = [...OFFICER_SCREEN_GLOBS, ...ADMIN_SCREEN_GLOBS];

// Interactive components that must expose a label or role to assistive tech.
const INTERACTIVE_TAGS = new Set([
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "Pressable",
  "Switch",
  "TextInput",
]);

// Presence of any of these props means the author has consciously handled the
// element for assistive tech, so we don't flag it.
const SATISFYING_PROPS = new Set([
  "accessibilityLabel",
  "aria-label",
  "accessibilityRole",
  "role",
  "accessibilityElementsHidden",
  "importantForAccessibility",
  "aria-hidden",
]);

type Finding = { file: string; line: number; tag: string };

function jsxTagName(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string | null {
  const { tagName } = node;
  if (ts.isIdentifier(tagName)) return tagName.text;
  // e.g. <RN.TouchableOpacity> — use the trailing member name.
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text;
  return null;
}

/** True if the element is exempt (labelled, role'd, hidden, or spreads props). */
function isHandled(
  attributes: ts.JsxAttributes,
): boolean {
  for (const attr of attributes.properties) {
    // A spread ({...rest}) may carry accessibility props we can't see — trust it.
    if (ts.isJsxSpreadAttribute(attr)) return true;
    if (ts.isJsxAttribute(attr)) {
      const name = attr.name.getText();
      if (SATISFYING_PROPS.has(name)) return true;
      // accessible={false} unhides children so each is read individually.
      if (name === "accessible") {
        const init = attr.initializer;
        if (
          init &&
          ts.isJsxExpression(init) &&
          init.expression &&
          init.expression.kind === ts.SyntaxKind.FalseKeyword
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function scanFile(absPath: string, label: string): Finding[] {
  const source = readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
    if (ts.isJsxElement(node)) opening = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) opening = node;

    if (opening) {
      const tag = jsxTagName(opening);
      if (tag && INTERACTIVE_TAGS.has(tag) && !isHandled(opening.attributes)) {
        const { line } = sf.getLineAndCharacterOfPosition(opening.getStart(sf));
        findings.push({ file: label, line: line + 1, tag });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const pattern of SCREEN_GLOBS) {
    const matches = globSync(pattern, { cwd: APP_ROOT });
    if (matches.length === 0) {
      console.error(
        `⚠️  No files matched "${pattern}" under ${APP_ROOT} — did a screen move or get renamed?`,
      );
    }
    for (const m of matches) files.push(m);
  }

  if (files.length === 0) {
    console.error("No screens to scan — check OFFICER_SCREEN_GLOBS / ADMIN_SCREEN_GLOBS.");
    process.exit(1);
  }

  console.log(`Mobile a11y label scan over ${files.length} screen(s):`);

  const allFindings: Finding[] = [];
  for (const rel of [...new Set(files)].sort()) {
    const abs = resolve(APP_ROOT, rel);
    const findings = scanFile(abs, rel);
    if (findings.length === 0) {
      console.log(`  ✅ ${rel}`);
    } else {
      console.log(`  ❌ ${rel}: ${findings.length} unlabeled interactive element(s)`);
      for (const f of findings) {
        console.log(`     • line ${f.line}: <${f.tag}> has no accessibilityLabel or accessibilityRole`);
      }
      allFindings.push(...findings);
    }
  }

  console.log("");
  if (allFindings.length > 0) {
    console.error(
      `Mobile a11y label scan FAILED: ${allFindings.length} interactive element(s) missing a screen-reader label/role.`,
    );
    console.error(
      "Add accessibilityLabel (and/or accessibilityRole), or mark the element accessible={false} / accessibilityElementsHidden if it is decorative.",
    );
    process.exit(1);
  }
  console.log("Mobile a11y label scan passed: every interactive element has a label or role.");
}

main();
