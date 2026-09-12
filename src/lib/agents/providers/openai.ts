import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";
import { ProviderError, coerceArgs, postJson, priceFor, toJsonSchema } from "./types";

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI";
  readonly models = [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
  ];

  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.apiKey = env.OPENAI_API_KEY?.trim() || undefined;
    this.baseUrl = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    if (!this.apiKey) {
      throw new ProviderError("OpenAI is not configured (OPENAI_API_KEY is unset).", "not_configured");
    }

    const messages: Record<string, unknown>[] = [{ role: "system", content: req.systemPrompt }];
    for (const m of req.messages) {
      if (m.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: m.toolCallId ?? "unknown",
          content: m.content,
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }

    const data = (await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: req.model,
        messages,
        max_completion_tokens: req.maxTokens,
        ...(req.temperature !== null ? { temperature: req.temperature } : {}),
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: toJsonSchema(t) },
        })),
        tool_choice: "auto",
      },
      { authorization: `Bearer ${this.apiKey}` },
      req.signal,
      "OpenAI",
    )) as OpenAIResponse;

    if (data.error) throw new ProviderError(data.error.message ?? "OpenAI error", "bad_response");

    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function?.name ?? "",
      args: coerceArgs(tc.function?.arguments),
    }));

    const tokensIn = data.usage?.prompt_tokens ?? null;
    const tokensOut = data.usage?.completion_tokens ?? null;

    return {
      text: (message?.content ?? "").trim(),
      toolCalls,
      done: toolCalls.length === 0,
      usage: { tokensIn, tokensOut, costUsd: priceFor(req.model, tokensIn, tokensOut) },
    };
  }
}
