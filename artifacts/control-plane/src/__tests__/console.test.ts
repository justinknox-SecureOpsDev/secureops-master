/**
 * Operator-console output-escaping regression.
 *
 * `reportedVersion` is sourced from remote (untrusted) customer backends via
 * /api/version and persisted in the registry. The fleet table must HTML-escape
 * it (and every other interpolated field) before it reaches innerHTML, or a
 * malicious/compromised backend could inject script into the privileged
 * operator dashboard and steal the operator's session token.
 *
 * jsdom is not available in this workspace, so we evaluate the real public/app.js
 * inside a `vm` context backed by a minimal fake DOM and assert the rendered
 * row markup is escaped.
 */

import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appJsSource = readFileSync(resolve(here, "../../public/app.js"), "utf8");

interface FakeEl {
  tag: string;
  innerHTML: string;
  hidden: boolean;
  textContent: string;
  className: string;
  value: string;
  appendChild: () => void;
  querySelector: () => FakeEl;
  addEventListener: () => void;
  setAttribute: () => void;
  getAttribute: () => string;
}

function makeEl(tag = ""): FakeEl {
  return {
    tag,
    innerHTML: "",
    hidden: false,
    textContent: "",
    className: "",
    value: "",
    appendChild: () => {},
    querySelector: () => makeEl("stub"),
    addEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => "",
  };
}

function renderWith(customersData: unknown[]): { created: FakeEl[]; esc: (s: unknown) => string } {
  const created: FakeEl[] = [];
  const elements: Record<string, FakeEl> = {};
  const documentStub = {
    getElementById: (id: string) => (elements[id] = elements[id] || makeEl(id)),
    createElement: (tag: string) => {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Append a bridge in the SAME script scope so we can reach the module-local
  // `customers`/`renderFleet`/`esc` bindings (top-level `let`/`function`).
  const augmented =
    appJsSource +
    "\n;globalThis.__renderFleetWith = function (arr) { customers = arr; renderFleet(); };" +
    "\n;globalThis.__esc = esc;";
  vm.runInContext(augmented, sandbox);
  (sandbox.__renderFleetWith as (a: unknown[]) => void)(customersData);
  return { created, esc: sandbox.__esc as (s: unknown) => string };
}

const baseCustomer = {
  name: "Acme",
  orgCode: "acme",
  apiBaseUrl: "https://a.test",
  contactEmail: "",
  needsUpdate: false,
  lastStatus: "online",
  isActive: true,
  lastSeenAt: null,
  effectiveTargetVersion: null,
};

describe("operator console escaping", () => {
  it("escapes a hostile reported version in the fleet table", () => {
    const hostile = '<img src=x onerror="alert(document.cookie)">';
    const { created } = renderWith([{ ...baseCustomer, reportedVersion: hostile }]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr).toBeTruthy();
    // The raw tag must be neutralized; the angle brackets/quotes are escaped so
    // it can never form a live <img onerror> element, only inert text.
    expect(tr!.innerHTML).not.toContain("<img");
    expect(tr!.innerHTML).not.toContain('onerror="alert');
    expect(tr!.innerHTML).toContain("&lt;img");
  });

  it("escapes hostile name / org code / url fields too", () => {
    const { created } = renderWith([
      {
        ...baseCustomer,
        name: "<script>x</script>",
        orgCode: "<b>",
        apiBaseUrl: "https://a.test/'><script>1</script>",
        reportedVersion: "v1",
      },
    ]);
    const tr = created.find((e) => e.tag === "tr");
    expect(tr!.innerHTML).not.toContain("<script>");
    expect(tr!.innerHTML).toContain("&lt;script&gt;");
  });

  it("esc neutralizes angle brackets, quotes and ampersands", () => {
    const { esc } = renderWith([]);
    expect(esc("<script>\"'&")).toBe("&lt;script&gt;&quot;&#39;&amp;");
  });
});

async function renderActivityWith(changes: unknown[]): Promise<FakeEl[]> {
  const created: FakeEl[] = [];
  const elements: Record<string, FakeEl> = {};
  const documentStub = {
    getElementById: (id: string) => (elements[id] = elements[id] || makeEl(id)),
    createElement: (tag: string) => {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage: { getItem: () => "tok", setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    fetch: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ changes }),
      }) as unknown as Response,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const augmented = appJsSource + "\n;globalThis.__loadActivity = loadActivity;";
  vm.runInContext(augmented, sandbox);
  await (sandbox.__loadActivity as () => Promise<void>)();
  return created;
}

describe("fleet activity feed escaping", () => {
  it("escapes hostile summary / operator / customer name in the activity feed", async () => {
    const created = await renderActivityWith([
      {
        id: "1",
        kind: "brand",
        summary: "<img src=x onerror=alert(1)>",
        operator: "<b>op</b>",
        status: 200,
        createdAt: new Date().toISOString(),
        customerId: "c1",
        customerName: "<script>x</script>",
      },
    ]);
    const li = created.find((e) => e.tag === "li");
    expect(li).toBeTruthy();
    expect(li!.innerHTML).not.toContain("<img");
    expect(li!.innerHTML).not.toContain("<script>x");
    expect(li!.innerHTML).toContain("&lt;img");
    expect(li!.innerHTML).toContain("&lt;script&gt;x");
  });

  it("shows a removed-customer marker when the customer name is null", async () => {
    const created = await renderActivityWith([
      {
        id: "2",
        kind: "features",
        summary: "Updated features: chat=on",
        operator: "op@test",
        status: 200,
        createdAt: new Date().toISOString(),
        customerId: "gone",
        customerName: null,
      },
    ]);
    const li = created.find((e) => e.tag === "li");
    expect(li!.innerHTML).toContain("removed customer");
  });
});
