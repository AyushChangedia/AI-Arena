import type { ProviderId, ToolSpec } from "@/lib/arena/types";

/**
 * A provider answers exactly one question: given this conversation and this
 * tool catalogue, what is the next action?
 *
 * It knows nothing about matches, scoring, or the arena. That is what makes
 * adding a vendor a one-file change.
 */

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on assistant turns that requested tools. */
  toolCalls?: ProviderToolCall[];
  /** Set on tool-result turns. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature: number | null;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ProviderUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  /** Null when the model is not in the pricing table — reported as "—", never guessed. */
  costUsd: number | null;
}

export interface ProviderTurn {
  /**
   * The model that actually answered, when it differs from the one requested.
   * A router may substitute one; reporting the substitution is the difference
   * between a leaderboard and a fiction.
   */
  modelUsed?: string;
  /** Free text the model produced alongside (or instead of) tool calls. */
  text: string;
  toolCalls: ProviderToolCall[];
  /** True when the model signalled it is finished rather than calling a tool. */
  done: boolean;
  usage: ProviderUsage;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not_configured"
      | "auth"
      | "rate_limit"
      /** The model itself is gone or not served — distinct from the key being wrong. */
      | "unavailable"
      | "network"
      | "bad_response"
      | "aborted",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** False when no API key is present. The UI shows NOT CONFIGURED. */
  readonly configured: boolean;
  /** Models this adapter knows how to price and address. */
  readonly models: { id: string; label: string }[];
  next(req: ProviderRequest): Promise<ProviderTurn>;
}

/**
 * Static price table, USD per million tokens. Prices drift; an unknown model
 * yields `costUsd: null` and the UI prints "—" rather than inventing a figure.
 */
export const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4": { in: 0.8, out: 4 },
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
};

export function priceFor(model: string, tokensIn: number | null, tokensOut: number | null): number | null {
  if (tokensIn === null && tokensOut === null) return null;
  const key = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = PRICING[key]!;
  return ((tokensIn ?? 0) / 1_000_000) * p.in + ((tokensOut ?? 0) / 1_000_000) * p.out;
}

/** Shared JSON-schema projection of a tool spec. */
export function toJsonSchema(spec: ToolSpec): {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
  required: string[];
} {
  const properties: Record<
    string,
    { type: string; description: string; enum?: string[]; items?: { type: string } }
  > = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(spec.parameters)) {
    const isArray = param.type === "string[]";
    properties[name] = {
      type: isArray ? "array" : param.type,
      description: param.description,
      ...(isArray ? { items: { type: "string" } } : {}),
      ...(param.enum ? { enum: param.enum } : {}),
    };
    if (param.required) required.push(name);
  }
  return { type: "object", properties, required };
}

/** Tolerant argument coercion — models sometimes send JSON as a string. */
export function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Falls through: the registry will reject it with a schema error the
      // agent can read and recover from, which is the behaviour we want.
    }
  }
  return {};
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw new ProviderError(`${label} request aborted`, "aborted");
    throw new ProviderError(
      `${label} network error: ${e instanceof Error ? e.message : String(e)}`,
      "network",
      true,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text.slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(`${label} rejected the API key (${res.status})`, "auth");
    }
    if (res.status === 402) {
      throw new ProviderError(`${label} requires credits for this model (402). ${detail}`, "auth");
    }
    if (res.status === 404) {
      // A free model that has been retired or renamed lands here. It is not a
      // broken key and not a network fault, and saying so is the difference
      // between "swap the model" and "check your account".
      throw new ProviderError(`${label} does not serve this model (404). ${detail}`, "unavailable");
    }
    if (res.status === 429) {
      throw new ProviderError(`${label} rate limited (429). ${detail}`, "rate_limit", true);
    }
    throw new ProviderError(`${label} returned ${res.status}. ${detail}`, "network", res.status >= 500);
  }

  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ProviderError(`${label} returned a body that was not JSON`, "bad_response");
  }
}
