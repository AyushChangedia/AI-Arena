import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";
import { ProviderError, coerceArgs, postJson, priceFor, toJsonSchema } from "./types";

interface GooglePart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

interface GoogleResponse {
  candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export class GoogleProvider implements ModelProvider {
  readonly id = "google" as const;
  readonly label = "Google";
  readonly models = [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ];

  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.apiKey = env.GOOGLE_API_KEY?.trim() || undefined;
    this.baseUrl = (
      env.GOOGLE_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    if (!this.apiKey) {
      throw new ProviderError("Google is not configured (GOOGLE_API_KEY is unset).", "not_configured");
    }

    const contents = req.messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.toolName ?? "tool",
                response: { result: m.content, isError: m.isError ?? false },
              },
            },
          ],
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "model",
          parts: [
            ...(m.content ? [{ text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args } })),
          ],
        };
      }
      return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
    });

    const data = (await postJson(
      `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`,
      {
        contents,
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          ...(req.temperature !== null ? { temperature: req.temperature } : {}),
        },
        tools: [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: toJsonSchema(t),
            })),
          },
        ],
      },
      { "x-goog-api-key": this.apiKey },
      req.signal,
      "Google",
    )) as GoogleResponse;

    if (data.error) throw new ProviderError(data.error.message ?? "Google error", "bad_response");

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: crypto.randomUUID(),
        name: p.functionCall?.name ?? "",
        args: coerceArgs(p.functionCall?.args),
      }));

    const tokensIn = data.usageMetadata?.promptTokenCount ?? null;
    const tokensOut = data.usageMetadata?.candidatesTokenCount ?? null;

    return {
      text,
      toolCalls,
      done: toolCalls.length === 0,
      usage: { tokensIn, tokensOut, costUsd: priceFor(req.model, tokensIn, tokensOut) },
    };
  }
}
