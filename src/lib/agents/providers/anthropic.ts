import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";
import { ProviderError, coerceArgs, postJson, priceFor, toJsonSchema } from "./types";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";
  readonly models = [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ];

  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
    this.baseUrl = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    if (!this.apiKey) {
      throw new ProviderError("Anthropic is not configured (ANTHROPIC_API_KEY is unset).", "not_configured");
    }

    const messages = req.messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: m.toolCallId ?? "unknown",
              content: m.content,
              is_error: m.isError ?? false,
            },
          ],
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({
              type: "tool_use" as const,
              id: tc.id,
              name: tc.name,
              input: tc.args,
            })),
          ],
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });

    const data = (await postJson(
      `${this.baseUrl}/v1/messages`,
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages,
        ...(req.temperature !== null ? { temperature: req.temperature } : {}),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: toJsonSchema(t),
        })),
      },
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      req.signal,
      "Anthropic",
    )) as AnthropicResponse;

    if (data.error) throw new ProviderError(data.error.message ?? "Anthropic error", "bad_response");

    const blocks = data.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    const toolCalls = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? crypto.randomUUID(), name: b.name ?? "", args: coerceArgs(b.input) }));

    const tokensIn = data.usage?.input_tokens ?? null;
    const tokensOut = data.usage?.output_tokens ?? null;

    return {
      text,
      toolCalls,
      done: toolCalls.length === 0,
      usage: { tokensIn, tokensOut, costUsd: priceFor(req.model, tokensIn, tokensOut) },
    };
  }
}
