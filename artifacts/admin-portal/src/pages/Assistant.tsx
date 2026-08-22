import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  checkAssistantConfigured,
  dismissSuggestion,
  fetchAssistantReply,
  fetchSuggestions,
  resolvePendingActionOutcome,
  type PendingAction,
  type Suggestion,
  type Turn,
} from "@workspace/assistant-chat-client";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react";

/**
 * In-portal assistant.
 *
 * Two panels that deliberately do not depend on each other: the suggestions
 * list is computed from the account's own data on the server and works whether
 * or not the AI integration is connected, and the chat needs Gemini. When the
 * integration is missing the page says so plainly rather than failing on the
 * first message.
 *
 * The chat/pending-action request logic (POST /assistant/chat, POST
 * /assistant/actions/:id/approve|discard, GET /assistant/status) lives in
 * @workspace/assistant-chat-client, shared with the mobile app's equivalent
 * screen — see that package's doc comment for why.
 */

const CATEGORY_STYLE: Record<Suggestion["category"], { label: string; tone: string }> = {
  money: { label: "Revenue", tone: "bg-amber-100 text-amber-900 border-amber-300" },
  compliance: { label: "Compliance", tone: "bg-red-100 text-red-900 border-red-300" },
  client: { label: "Client-facing", tone: "bg-blue-100 text-blue-900 border-blue-300" },
  dispatch: { label: "Workload", tone: "bg-violet-100 text-violet-900 border-violet-300" },
  admin: { label: "Admin", tone: "bg-zinc-100 text-zinc-800 border-zinc-300" },
};

const STARTERS = [
  "What are we not using that would save us time?",
  "How do I run payroll?",
  "How do I invoice a client?",
  "Why are some hours missing from an invoice?",
];

export default function AssistantPage() {
  const { toast } = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [findings, setFindings] = useState<Suggestion[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      setConfigured(await checkAssistantConfigured(api));
    })();
  }, []);

  const loadFindings = useCallback(async () => {
    setFindingsLoading(true);
    try {
      setFindings(await fetchSuggestions(api));
    } catch (err) {
      toast({
        title: "Could not load suggestions",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setFindingsLoading(false);
    }
  }, [toast]);

  useEffect(() => { void loadFindings(); }, [loadFindings]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    const priorTurns = turns;
    setTurns((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setSending(true);
    const reply = await fetchAssistantReply(api, priorTurns, message);
    setTurns((prev) => [...prev, reply]);
    setSending(false);
    // An action that ran may have resolved a finding.
    if (reply.actionsTaken?.some((a) => a.ok)) void loadFindings();
  }

  async function resolvePending(turnIndex: number, action: PendingAction, approve: boolean) {
    setApproving(action.id);
    const resolution = await resolvePendingActionOutcome(api, action, approve);
    setTurns((prev) => prev.map((t, i) => (i === turnIndex ? { ...t, resolution } : t)));
    setApproving(null);
    if (resolution.ok) {
      toast({ title: "Done", description: resolution.text });
      void loadFindings();
    } else if (approve) {
      // A discard's "nothing was changed" resolution is not an error — only
      // surface the toast when an approve attempt actually failed.
      toast({ title: "Action failed", description: resolution.text, variant: "destructive" });
    }
  }

  async function dismiss(id: string) {
    setFindings((prev) => prev.filter((f) => f.id !== id));
    if (!(await dismissSuggestion(api, id))) {
      toast({ title: "Could not dismiss", description: "The suggestion is still active.", variant: "destructive" });
      void loadFindings();
    }
  }

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="flex items-center gap-3 mb-1">
        <Sparkles className="w-5 h-5 brand-navy" />
        <h1 className="text-xl brand-wordmark brand-navy">Secure Ops AI Bot</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Ask how something works, or have it draft a shift, a roster change, or a time-entry
        decision. It never changes anything on its own — every action comes back as a card you
        approve first — and it acts with your permissions, so nothing it does is something you
        could not do yourself.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        {/* ── Chat ─────────────────────────────────────────────────────── */}
        <section className="border rounded-lg bg-card flex flex-col min-h-[460px]">
          {configured === false && (
            <div className="m-3 p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Secure Ops AI Bot is not connected</p>
                  <p className="mt-0.5">
                    Chat needs a Gemini connection, which an operator sets up in the Replit AI
                    Integrations pane. The efficiency suggestions beside this panel are worked out
                    from your own data and still work.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {turns.length === 0 && (
              <div className="text-sm text-muted-foreground">
                <p className="mb-3">Try one of these:</p>
                <div className="flex flex-wrap gap-2">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      disabled={sending || configured === false}
                      className="text-left text-xs px-3 py-1.5 rounded-full border bg-background hover:bg-accent disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
                <div
                  className={
                    t.role === "user"
                      ? "max-w-[85%] rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground whitespace-pre-wrap"
                      : "max-w-[95%] rounded-lg px-3 py-2 text-sm bg-muted whitespace-pre-wrap"
                  }
                >
                  {t.content}

                  {t.actionsTaken && t.actionsTaken.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {t.actionsTaken.map((a, j) => (
                        <li key={j} className="flex items-start gap-1.5 text-xs">
                          {a.ok ? (
                            <Check className="w-3.5 h-3.5 mt-0.5 text-emerald-700 shrink-0" />
                          ) : (
                            <X className="w-3.5 h-3.5 mt-0.5 text-red-700 shrink-0" />
                          )}
                          <span className={a.ok ? "text-emerald-900" : "text-red-900"}>{a.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {t.pendingAction && !t.resolution && (
                    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950">
                      <p className="text-xs font-medium uppercase tracking-wide">Needs your approval</p>
                      <p className="mt-1 text-sm font-medium">{t.pendingAction.summary}</p>
                      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {t.pendingAction.details.map((d) => (
                          <div key={d.label} className="flex gap-1.5">
                            <dt className="text-amber-800 shrink-0">{d.label}:</dt>
                            <dd className="font-medium break-words">{d.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void resolvePending(i, t.pendingAction!, true)}
                          disabled={approving === t.pendingAction.id}
                        >
                          {approving === t.pendingAction.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void resolvePending(i, t.pendingAction!, false)}
                          disabled={approving === t.pendingAction.id}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {t.resolution && (
                    <p
                      className={`mt-2 text-xs font-medium ${t.resolution.ok ? "text-emerald-800" : "text-red-800"}`}
                    >
                      {t.resolution.text}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
              </div>
            )}
          </div>

          <form
            className="border-t p-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={configured === false ? "Secure Ops AI Bot not connected" : "Ask a question, or describe what you want done…"}
              aria-label="Message Secure Ops AI Bot"
              disabled={sending || configured === false}
              className="flex-1 min-w-0 rounded-md border px-3 py-2 text-sm bg-background disabled:opacity-60"
            />
            <Button type="submit" size="sm" disabled={sending || !input.trim() || configured === false}>
              <Send className="w-4 h-4" />
              <span className="sr-only sm:not-sr-only">Send</span>
            </Button>
          </form>
        </section>

        {/* ── Adoption suggestions ─────────────────────────────────────── */}
        <section className="border rounded-lg bg-card p-4">
          <h2 className="text-sm font-semibold mb-1">What you're not using</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Worked out from your own data. Each one disappears by itself once it is sorted.
          </p>

          {findingsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking…
            </div>
          ) : findings.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              Nothing to flag — you're using the parts of the system that apply to you.
            </p>
          ) : (
            <ul className="space-y-3">
              {findings.map((f) => {
                const style = CATEGORY_STYLE[f.category];
                return (
                  <li key={f.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${style.tone}`}>
                        {style.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => void dismiss(f.id)}
                        aria-label={`Dismiss suggestion: ${f.title}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{f.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{f.evidence}</p>
                    <p className="mt-1.5 text-xs">{f.benefit}</p>
                    <Link
                      href={f.route}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      {f.routeLabel} <ArrowRight className="w-3 h-3" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
