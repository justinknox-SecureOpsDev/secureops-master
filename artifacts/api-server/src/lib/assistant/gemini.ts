import { GoogleGenAI, type FunctionDeclaration, type GenerateContentResponse } from "@google/genai";
import { logger } from "../logger";

/**
 * Gemini client wrapper for the admin assistant.
 *
 * Deliberately mirrors lib/pdfEmployeeExtract.ts rather than inventing a
 * second pattern: the same Replit AI Integrations env vars, the same lazy
 * init, and the same `__serviceUnavailable`-tagged error when the
 * integration is not connected — so an unconfigured deployment degrades
 * honestly (503, "not configured") instead of failing in some new way.
 *
 * The API key never leaves the server. Every model call in this feature
 * originates here; the browser only ever talks to our own routes.
 */

const MODEL = "gemini-3.6-flash";
const REQUEST_TIMEOUT_MS = 45_000;

export type ServiceUnavailableError = Error & { __serviceUnavailable: true };

export function isServiceUnavailable(err: unknown): err is ServiceUnavailableError {
  return typeof err === "object" && err !== null && "__serviceUnavailable" in err;
}

function serviceUnavailable(message: string): ServiceUnavailableError {
  const err = new Error(message) as ServiceUnavailableError;
  err.__serviceUnavailable = true;
  return err;
}

/**
 * Whether the Gemini integration is configured on this deployment. Callers
 * use this to render an honest "assistant is not connected" state instead of
 * a generic failure, and to keep the non-AI parts of the feature (the
 * adoption findings list) working regardless.
 */
export function isAssistantConfigured(): boolean {
  return Boolean(process.env["AI_INTEGRATIONS_GEMINI_API_KEY"]);
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
  const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
  if (!apiKey) {
    throw serviceUnavailable(
      "The AI assistant is not connected on this deployment. An operator needs to connect Gemini in the Replit AI Integrations pane.",
    );
  }
  client = new GoogleGenAI({
    apiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
  return client;
}

/** Reset the memoised client — used by tests that flip the env vars. */
export function resetAssistantClientForTests(): void {
  client = null;
}

export type ModelTurn = {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
};

export type ModelReply = {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

/**
 * One model round-trip. Returns the assistant's prose plus any tool calls it
 * asked for. Never throws for a "no answer" case — an empty reply is returned
 * as empty text so the caller decides what to say to the human.
 */
export async function generate(opts: {
  systemInstruction: string;
  contents: ModelTurn[];
  tools: FunctionDeclaration[];
}): Promise<ModelReply> {
  const ai = getClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL,
      contents: opts.contents,
      config: {
        systemInstruction: opts.systemInstruction,
        abortSignal: controller.signal,
        temperature: 0.2,
        ...(opts.tools.length > 0 ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
      },
    });
    const calls = (res.functionCalls ?? [])
      .filter((c): c is { name: string; args?: Record<string, unknown> } => typeof c.name === "string")
      .map((c) => ({ name: c.name, args: (c.args ?? {}) as Record<string, unknown> }));
    return { text: (res.text ?? "").trim(), functionCalls: calls };
  } catch (err) {
    if (isServiceUnavailable(err)) throw err;
    logger.warn({ err }, "[assistant] gemini call failed");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
