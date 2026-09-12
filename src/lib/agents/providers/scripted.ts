import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";
import { ProviderError } from "./types";
import type { PolicyObservation, PolicyContext, ScriptedPolicy } from "@/lib/agents/policies/types";

/**
 * The demo "model".
 *
 * It implements the same `ModelProvider` interface as the live vendors and is
 * driven by the same harness. What it does NOT do is call a model: a
 * deterministic policy chooses the next action instead.
 *
 * Every match driven by this provider is labelled DEMO in the UI, reports cost
 * as "—" rather than a fabricated figure, and is described on the match page
 * as "scripted policy · real execution".
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted" as const;
  readonly label = "Scripted policy";
  readonly configured = true;
  readonly models: { id: string; label: string }[] = [];

  constructor(
    private policy: ScriptedPolicy,
    private catalogue: Set<string>,
    private profile: PolicyContext["profile"],
  ) {}

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    if (req.signal.aborted) throw new ProviderError("execution aborted", "aborted");

    const ctx: PolicyContext = {
      step: countAssistantTurns(req),
      history: observationsFrom(req),
      profile: this.profile,
      catalogue: this.catalogue,
    };

    const action = this.policy.next(ctx);

    if (action.kind === "finish") {
      return {
        text: [action.think, action.message].filter(Boolean).join("\n\n"),
        toolCalls: [],
        done: true,
        // Demo runs consume no tokens and cost nothing. Reporting a number here
        // would be inventing data, so all three stay null and the UI shows "—".
        usage: { tokensIn: null, tokensOut: null, costUsd: null },
      };
    }

    if (!this.catalogue.has(action.tool)) {
      // A policy asking for a tool this execution does not have is a real
      // failure the harness must handle, exactly as a model's would be.
      return {
        text: action.think,
        toolCalls: [{ id: callId(ctx.step), name: action.tool, args: action.args }],
        done: false,
        usage: { tokensIn: null, tokensOut: null, costUsd: null },
      };
    }

    return {
      text: action.think,
      toolCalls: [{ id: callId(ctx.step), name: action.tool, args: action.args }],
      done: false,
      usage: { tokensIn: null, tokensOut: null, costUsd: null },
    };
  }

}

function callId(step: number): string {
  return `scripted_${step}_${Math.random().toString(36).slice(2, 8)}`;
}

function countAssistantTurns(req: ProviderRequest): number {
  return req.messages.filter((m) => m.role === "assistant").length;
}

/**
 * Reconstructs what actually happened from the transcript the harness built.
 * The policy therefore sees real tool outputs and real errors, not a script.
 */
function observationsFrom(req: ProviderRequest): PolicyObservation[] {
  const out: PolicyObservation[] = [];
  const pending = new Map<string, { tool: string; args: Record<string, unknown> }>();

  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) pending.set(tc.id, { tool: tc.name, args: tc.args });
    }
    if (m.role === "tool") {
      const call = (m.toolCallId && pending.get(m.toolCallId)) || {
        tool: m.toolName ?? "unknown",
        args: {},
      };
      out.push({
        tool: call.tool,
        args: call.args,
        ok: !m.isError,
        output: m.isError ? "" : m.content,
        error: m.isError ? m.content : null,
      });
    }
  }
  return out;
}
