/**
 * The assistant must not explain a capability this company has not bought.
 *
 * The portal sidebar already drops any page whose feature flag is off
 * (buildNavGroups), and the suggestion cards already skip disabled features
 * (signals.ts). The how-to side used to be the odd one out: retrieval was pure
 * keyword matching, so an admin on a plan without payroll could be walked
 * through Accounting > Pay Run — a tab that is not in their portal at all.
 * They then hunt for a page that does not exist and conclude the portal is
 * broken.
 *
 * These tests are deliberately about the deterministic layer: what the model
 * is *given*. Gemini is never called here — if the payroll article never
 * reaches the prompt, there is nothing for it to paraphrase.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  clearOverrideInMemory,
  isFeatureEnabled,
  setOverrideInMemory,
  type FeatureKey,
} from "../lib/features";
import { KB_ARTICLES, knowledgeBaseIndex, retrieveArticles } from "../lib/assistant/knowledgeBase";
import { buildGrounding, systemInstruction } from "../lib/assistant/agent";

/** Feature overrides are process-global — never leak one into another suite. */
afterEach(() => {
  for (const k of FEATURE_KEYS) clearOverrideInMemory(k);
});

const allOn = () => true;
const allOff = () => false;
const off = (...keys: FeatureKey[]) => (k: FeatureKey) => !keys.includes(k);

const idsOf = (question: string, isEnabled: (k: FeatureKey) => boolean) =>
  retrieveArticles(question, { isEnabled }).articles.map((a) => a.id);

const PAYROLL_QUESTION = "how do I run payroll for last week?";
const INVOICE_QUESTION = "how do I invoice a client for the hours we worked?";

describe("knowledge base feature declarations", () => {
  it("declares a real feature key on every article that declares one", () => {
    for (const article of KB_ARTICLES) {
      if (!article.feature) continue;
      expect(FEATURE_KEYS as readonly string[], `article "${article.id}"`).toContain(article.feature);
    }
  });

  it("keeps the payroll and invoicing how-tos attached to their features", () => {
    // Named explicitly: these two are the ones an admin is walked into most
    // often, and the pair the bug was reported against.
    const byId = new Map(KB_ARTICLES.map((a) => [a.id, a]));
    expect(byId.get("run-payroll")?.feature).toBe("payroll");
    expect(byId.get("generate-invoice")?.feature).toBe("invoicing");
  });
});

describe("retrieval skips articles for switched-off features", () => {
  it("answers a payroll question normally when payroll is on", () => {
    expect(idsOf(PAYROLL_QUESTION, allOn)).toContain("run-payroll");
  });

  it("withholds the payroll article when payroll is off, and names it as unavailable", () => {
    const out = retrieveArticles(PAYROLL_QUESTION, { isEnabled: off("payroll") });
    expect(out.articles.map((a) => a.id)).not.toContain("run-payroll");
    expect(out.unavailable.map((u) => u.feature)).toContain("payroll");
  });

  it("answers an invoicing question normally when invoicing is on", () => {
    expect(idsOf(INVOICE_QUESTION, allOn)).toContain("generate-invoice");
  });

  it("withholds the invoice article when invoicing is off, and names it as unavailable", () => {
    const out = retrieveArticles(INVOICE_QUESTION, { isEnabled: off("invoicing") });
    expect(out.articles.map((a) => a.id)).not.toContain("generate-invoice");
    expect(out.unavailable.map((u) => u.feature)).toContain("invoicing");
  });

  it("does not let a disabled article eat one of the answer slots", () => {
    // The disabled article outscores the others on a payroll question. If it
    // were dropped after the top-N cut rather than before it, the person would
    // silently get one fewer usable article than they should.
    const on = retrieveArticles(PAYROLL_QUESTION, { isEnabled: allOn, limit: 3 });
    const gated = retrieveArticles(PAYROLL_QUESTION, { isEnabled: off("payroll"), limit: 3 });
    expect(gated.articles.length).toBe(on.articles.length);
  });

  it("keeps patrol separate from daily reports — a company can have one without the other", () => {
    // Both are "proof of coverage" but they are separately sold. Tagging the
    // pair with one key would either hide reports a company owns or walk them
    // through checkpoints they cannot set up.
    const question = "how do officers prove they walked their patrol rounds?";
    expect(idsOf(question, allOn)).toContain("patrol-checkpoints");

    const patrolOff = retrieveArticles(question, { isEnabled: off("patrol") });
    expect(patrolOff.articles.map((a) => a.id)).not.toContain("patrol-checkpoints");
    expect(patrolOff.unavailable.map((u) => u.feature)).toContain("patrol");

    // Daily reports still answer normally with patrol off.
    expect(idsOf("how do daily activity reports work?", off("patrol"))).toContain(
      "daily-activity-reports",
    );
  });

  it("keeps officer availability separate from coverage requests", () => {
    const question = "where do I see officer availability?";
    expect(idsOf(question, allOn)).toContain("officer-availability");

    const availabilityOff = retrieveArticles(question, { isEnabled: off("availability") });
    expect(availabilityOff.articles.map((a) => a.id)).not.toContain("officer-availability");
    expect(availabilityOff.unavailable.map((u) => u.feature)).toContain("availability");

    // Coverage requests are not a plan feature and must keep answering.
    expect(idsOf("how does a client ask for extra coverage?", allOff)).toContain(
      "coverage-requests",
    );
  });

  it("leaves always-on articles alone even with every feature switched off", () => {
    // Shifts, sites, time entries, permissions and the audit log are core
    // portal, not plan features. Nothing here may go quiet.
    expect(idsOf("how do I create a shift?", allOff)).toContain("create-shift");
    expect(idsOf("how do I approve a time entry?", allOff)).toContain("approve-time-entries");
    expect(idsOf("how do I add a site and set its rates?", allOff)).toContain("add-site");
    expect(retrieveArticles("how do I create a shift?", { isEnabled: allOff }).unavailable).toEqual([]);
  });

  it("does not announce a feature the question only brushed past", () => {
    // "hours" appears in the payroll body, but a question about clocking in is
    // not a payroll question — announcing "payroll is switched off" there would
    // be noise on every unrelated answer.
    const out = retrieveArticles("what stops an officer clocking in early?", {
      isEnabled: allOff,
    });
    expect(out.unavailable).toEqual([]);
  });
});

describe("the prompt the model actually receives", () => {
  it("hands over the payroll walkthrough when payroll is on", () => {
    const grounding = buildGrounding(PAYROLL_QUESTION, allOn);
    expect(grounding).toContain("Accounting > Pay Run");
    expect(grounding).not.toContain("NOT ENABLED");
  });

  it("never puts the payroll walkthrough in front of a company without payroll", () => {
    setOverrideInMemory("payroll", false);
    expect(isFeatureEnabled("payroll")).toBe(false);

    // No predicate passed: this is the real wiring the chat route uses.
    const grounding = buildGrounding(PAYROLL_QUESTION);
    expect(grounding).not.toContain("Accounting > Pay Run");
    expect(grounding).not.toContain("Accounting > Payroll Board");
    expect(grounding).not.toContain("/payroll/pay-run");
    expect(grounding).toContain("NOT ENABLED");
    expect(grounding).toMatch(/not enabled for this company/i);
  });

  it("never puts the invoicing walkthrough in front of a company without invoicing", () => {
    setOverrideInMemory("invoicing", false);
    expect(isFeatureEnabled("invoicing")).toBe(false);

    const grounding = buildGrounding(INVOICE_QUESTION);
    expect(grounding).not.toContain("Accounting > Invoice Board");
    expect(grounding).not.toContain("/invoices/board");
    expect(grounding).toContain("NOT ENABLED");
  });

  it("still grounds the parts of a question that are enabled", () => {
    // Invoicing off, time-entry approval on: they asked about both, so they
    // get the half they own rather than a blanket refusal.
    setOverrideInMemory("invoicing", false);
    const grounding = buildGrounding("how do I approve time entries and invoice the client?");
    expect(grounding).toContain("Reference articles");
    expect(grounding).toContain("NOT ENABLED");
    expect(grounding).not.toContain("/invoices/board");
  });

  it("never hands over patrol checkpoint steps to a company without patrol", () => {
    setOverrideInMemory("patrol", false);
    const grounding = buildGrounding("how do officers prove they walked their patrol rounds?");
    expect(grounding).not.toContain("scan them from the mobile app");
    expect(grounding).toContain("Patrol checkpoints");
    expect(grounding).toContain("NOT ENABLED");
  });

  it("never hands over availability steps to a company without availability", () => {
    setOverrideInMemory("availability", false);
    const grounding = buildGrounding("where do I see officer availability?");
    expect(grounding).not.toContain("Dispatch > Personnel");
    expect(grounding).toContain("Officer availability");
    expect(grounding).toContain("NOT ENABLED");
  });

  it("tells the model up front which capabilities this company does not have", () => {
    // An always-on article can mention a gated capability in passing (approving
    // time entries feeds the draft invoice), so the standing instruction has to
    // name what is off, not just the per-question block.
    setOverrideInMemory("payroll", false);
    const prompt = systemInstruction({ role: "admin" });
    expect(prompt).toContain("NOT INCLUDED in this company's plan");
    expect(prompt).toContain("Payroll");
    expect(prompt).not.toContain("payroll,"); // named in words, never as a flag key
    expect(prompt).not.toContain("Team chat"); // chat is on — do not list it
  });

  it("says nothing about plans when the company has everything", () => {
    expect(systemInstruction({ role: "admin" })).not.toContain("NOT INCLUDED");
  });

  it("does not advertise a switched-off topic in the assistant's own topic list", () => {
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("invoicing", false);
    const index = knowledgeBaseIndex(isFeatureEnabled);
    expect(index).not.toContain("Running payroll");
    expect(index).not.toContain("Generating and sending a client invoice");
    expect(index).toContain("Creating a shift");
  });
});
