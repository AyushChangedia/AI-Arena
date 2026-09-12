import type { ModelProvider, ProviderRequest, ProviderTurn } from "./types";
import { ProviderError, coerceArgs, postJson, toJsonSchema, toolNameMap } from "./types";
import type { ToolNameMap } from "./types";

/**
 * OpenRouter.
 *
 * One key reaches every vendor OpenRouter fronts, and its `:free` tier makes the
 * arena runnable with real models without buying credits. The wire format is
 * OpenAI's `/chat/completions`, so this adapter is the OpenAI one with a
 * different base URL, attribution headers, and free-tier realities handled.
 *
 * ## Why the model list is configurable rather than fixed
 *
 * Free models on OpenRouter are promotional: they are added, renamed and retired
 * without notice, and a list hard-coded today is wrong within months. So the
 * defaults below are a starting point, `OPENROUTER_MODELS` overrides them
 * wholesale, and a model that has gone away produces a clean "model unavailable"
 * rather than a crash — see the 404 mapping in `postJson`.
 *
 * ## Tool calling is not optional here
 *
 * Every task in the arena is driven by tool calls, so a model that cannot call
 * tools cannot compete — it will talk instead of acting and score zero on a task
 * it never attempted. The defaults are chosen from models that advertise tool
 * support; if you override the list, pick ones that do.
 */

interface OpenRouterResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
    /** OpenRouter surfaces upstream provider failures per choice. */
    error?: { message?: string; code?: number };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

/**
 * Free, tool-capable models, newest-capable first. Every id carries the `:free`
 * suffix, which is what makes OpenRouter bill nothing for it.
 */
const DEFAULT_FREE_MODELS: { id: string; label: string }[] = [
  { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3 (free)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)" },
  { id: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B (free)" },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small 3.1 (free)" },
  { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash (free)" },
  { id: "deepseek/deepseek-r1-0528:free", label: "DeepSeek R1 (free)" },
];

/** Used when an agent names a model this adapter does not recognise. */
export const DEFAULT_FREE_MODEL = DEFAULT_FREE_MODELS[0]!.id;

/** How long a fetched free-model list stays good for. */
const CATALOGUE_TTL_MS = 5 * 60_000;

export interface DiscoveredModel {
  id: string;
  label: string;
  /** Every task here is tool-driven, so this decides whether it can compete. */
  supportsTools: boolean;
}

interface ModelListResponse {
  data?: {
    id?: string;
    name?: string;
    supported_parameters?: string[];
    pricing?: { prompt?: string; completion?: string };
  }[];
}

/**
 * Ask OpenRouter which free models actually exist right now.
 *
 * The shipped defaults are a guess frozen at build time, and free models are
 * retired without notice — so rather than asking anyone to trust that list, the
 * app can read the real one. Server-side only; the key never leaves the server
 * and the result is labels and ids, nothing secret.
 *
 * Returns null when unconfigured or unreachable, so the caller can say "could
 * not check" instead of showing an empty list that looks like "none available".
 */
export async function discoverFreeModels(
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<DiscoveredModel[] | null> {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: signal ?? AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: ModelListResponse;
  try {
    body = (await res.json()) as ModelListResponse;
  } catch {
    return null;
  }

  return (body.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id.endsWith(":free"))
    .map((m) => ({
      id: m.id!,
      label: m.name ?? m.id!,
      // OpenRouter advertises tool support per model; without it an agent will
      // talk instead of acting and score near zero on a task it never attempted.
      supportsTools: (m.supported_parameters ?? []).includes("tools"),
    }))
    .sort((a, b) => Number(b.supportsTools) - Number(a.supportsTools) || a.id.localeCompare(b.id));
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter" as const;
  readonly label = "OpenRouter";
  readonly models: { id: string; label: string }[];

  private readonly env: Record<string, string | undefined>;
  /** Short-lived: the free list changes, but not between steps of one match. */
  private catalogue: { at: number; models: DiscoveredModel[] } | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly referer: string | undefined;
  private readonly title: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
    this.apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
    this.baseUrl = (env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.models = parseModels(env.OPENROUTER_MODELS) ?? DEFAULT_FREE_MODELS;

    // Optional attribution. OpenRouter uses these to label traffic; neither is
    // required and neither carries anything secret.
    this.referer = env.OPENROUTER_SITE_URL?.trim() || env.NEXT_PUBLIC_SITE_URL?.trim() || undefined;
    this.title = env.OPENROUTER_APP_TITLE?.trim() || "AI Agent Arena";
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Free ids end in `:free`, so a zero cost is a fact rather than a guess. */
  private isFree(model: string): boolean {
    return model.endsWith(":free");
  }

  /**
   * Which free models exist right now, cached for a few minutes.
   *
   * Empty means "could not ask", which is deliberately not the same as "none
   * exist": the caller falls back to using the model as requested rather than
   * refusing to run.
   */
  private async liveFreeModels(signal: AbortSignal): Promise<DiscoveredModel[]> {
    if (this.catalogue && Date.now() - this.catalogue.at < CATALOGUE_TTL_MS) {
      return this.catalogue.models;
    }
    const models = (await discoverFreeModels(this.env, signal)) ?? [];
    // Only cache a real answer, so a blip does not pin an empty list.
    if (models.length > 0) this.catalogue = { at: Date.now(), models };
    return models;
  }

  /**
   * Turn a requested free model into one OpenRouter will actually serve.
   *
   * Free ids are promotional and get retired constantly — "This model is
   * unavailable for free, the paid version is available now" is the routine
   * reply, and hard-coding ids means the arena breaks every time that happens.
   * So the list is read from OpenRouter and the request is pointed at something
   * live. Paid ids are left exactly as asked: substituting one would spend
   * money the caller did not agree to.
   */
  private async resolveModel(requested: string, signal: AbortSignal): Promise<string> {
    if (!this.isFree(requested)) return requested;

    const live = await this.liveFreeModels(signal);
    if (live.length === 0) return requested;

    const asked = live.find((m) => m.id === requested);
    if (asked?.supportsTools) return requested;

    // Every task here is tool-driven, so a model that cannot call tools is no
    // substitute at all — it would talk instead of acting.
    return live.find((m) => m.supportsTools)?.id ?? requested;
  }

  async next(req: ProviderRequest): Promise<ProviderTurn> {
    if (!this.apiKey) {
      throw new ProviderError(
        "OpenRouter is not configured (OPENROUTER_API_KEY is unset).",
        "not_configured",
      );
    }

    // The arena's dotted tool names are not legal on this wire; a single one
    // 400s the request before any tool runs. Mapped out here, mapped back below.
    const names = toolNameMap(req.tools);

    const messages: Record<string, unknown>[] = [{ role: "system", content: req.systemPrompt }];
    for (const m of req.messages) {
      if (m.role === "tool") {
        messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "unknown", content: m.content });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: names.toWire(tc.name), arguments: JSON.stringify(tc.args) },
          })),
        });
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }

    // Resolved before the call, not after a failure: a retired free id is the
    // normal case here, not the exception.
    const model = await this.resolveModel(req.model, req.signal);
    const data = await this.post({ ...req, model }, messages, names);

    // OpenRouter answers 200 with an error body when the upstream provider
    // fails, so a non-2xx check alone would let a failed turn through as an
    // empty, "successful" one.
    const failure = data.error ?? data.choices?.[0]?.error;
    if (failure) throw classify(failure, req.model);

    const choice = data.choices?.[0];
    const message = choice?.message;

    // No choices at all is the shape a rate-limited or dropped upstream returns.
    if (!choice) {
      throw new ProviderError(
        `OpenRouter returned no completion for ${req.model}. The free tier may be saturated — try again, or pick another model.`,
        "unavailable",
        true,
      );
    }

    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? crypto.randomUUID(),
      name: names.fromWire(tc.function?.name ?? ""),
      args: coerceArgs(tc.function?.arguments),
    }));

    const tokensIn = data.usage?.prompt_tokens ?? null;
    const tokensOut = data.usage?.completion_tokens ?? null;

    return {
      modelUsed: model,
      text: (message?.content ?? "").trim(),
      toolCalls,
      done: toolCalls.length === 0,
      usage: {
        tokensIn,
        tokensOut,
        // A `:free` model costs nothing, and 0 is the measured truth. Anything
        // else priced through OpenRouter varies by upstream and is reported as
        // "—" rather than guessed from a stale table.
        costUsd: this.isFree(model) ? 0 : null,
      },
    };
  }

  /**
   * The HTTP call, with OpenRouter's 404 translated on the way out.
   *
   * `postJson` maps status codes generically for every provider; what a 404
   * *means* here is provider-specific, so the advice is added at this level
   * rather than baked into the shared helper.
   */
  private async post(
    req: ProviderRequest,
    messages: Record<string, unknown>[],
    names: ToolNameMap,
  ): Promise<OpenRouterResponse> {
    try {
      return (await postJson(
        `${this.baseUrl}/chat/completions`,
        {
          model: req.model,
          messages,
          max_tokens: req.maxTokens,
          ...(req.temperature !== null ? { temperature: req.temperature } : {}),
          tools: req.tools.map((t) => ({
            type: "function",
            function: {
              name: names.toWire(t.name),
              description: t.description,
              parameters: toJsonSchema(t),
            },
          })),
          tool_choice: "auto",
        },
        {
          authorization: `Bearer ${this.apiKey}`,
          ...(this.referer ? { "HTTP-Referer": this.referer } : {}),
          "X-Title": this.title,
        },
        req.signal,
        "OpenRouter",
      )) as OpenRouterResponse;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unavailable") {
        throw new ProviderError(unavailableAdvice(req.model, e.message), "unavailable", e.retryable);
      }
      throw e;
    }
  }
}

/**
 * What to actually do about "no endpoints found".
 *
 * OpenRouter returns the same 404 for two very different situations, and the
 * wording points at the wrong one. A free endpoint is paid for with your
 * prompts, so if the account's privacy settings exclude providers that may
 * train on inputs, every endpoint for that model is filtered out and the reply
 * reads as though the model does not exist. That trips people far more often
 * than an actual retirement, and it takes out every free model at once rather
 * than one.
 */
function unavailableAdvice(model: string, message: string): string {
  const isFree = model.endsWith(":free");
  return [
    `OpenRouter served no endpoint for ${model}: ${message}.`,
    isFree
      ? "Free endpoints are the usual cause. If every free model is failing, it is almost certainly the account setting rather than the model — enable free-model training at openrouter.ai/settings/privacy, since free capacity is paid for with your prompts."
      : "",
    "Otherwise the id has been retired: /system lists the free models your key can reach right now, and OPENROUTER_MODELS repoints the arena without a redeploy.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Maps OpenRouter's in-body error codes onto the kinds the harness acts on. */
function classify(error: { message?: string; code?: number }, model: string): ProviderError {
  const message = error.message ?? "OpenRouter error";
  switch (error.code) {
    case 400:
      return new ProviderError(`OpenRouter rejected the request: ${message}`, "bad_request");
    case 401:
    case 403:
      return new ProviderError(`OpenRouter rejected the API key: ${message}`, "auth");
    case 402:
      return new ProviderError(`${model} needs credits on OpenRouter: ${message}`, "auth");
    case 404:
      return new ProviderError(unavailableAdvice(model, message), "unavailable");
    case 429:
      return new ProviderError(
        `OpenRouter rate limited ${model}: ${message}. The free tier is capped per minute and per day.`,
        "rate_limit",
        true,
      );
    case 502:
    case 503:
      return new ProviderError(
        `The provider behind ${model} is unavailable: ${message}`,
        "unavailable",
        true,
      );
    default:
      return new ProviderError(`OpenRouter error: ${message}`, "bad_response");
  }
}

/**
 * `OPENROUTER_MODELS` as `id|Label` pairs, comma or newline separated. The label
 * is optional and falls back to the id.
 */
function parseModels(raw: string | undefined): { id: string; label: string }[] | null {
  if (!raw?.trim()) return null;
  const models = raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label] = entry.split("|").map((part) => part.trim());
      return { id: id!, label: label || id! };
    })
    .filter((m) => m.id.length > 0);
  return models.length > 0 ? models : null;
}
