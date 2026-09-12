import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OpenRouterProvider, DEFAULT_FREE_MODEL, discoverFreeModels } from "@/lib/agents/providers/openrouter";
import { ProviderError } from "@/lib/agents/providers/types";
import type { ProviderRequest } from "@/lib/agents/providers/types";
import type { ToolSpec } from "@/lib/arena/types";

/**
 * The arena runs on free models, where the two likely failures are "this model
 * was retired" and "you have hit the free rate limit". Both have to arrive as
 * something the UI can name and the match can survive — a thrown string or a
 * silently empty turn would strand the agent mid-run.
 */

const TOOL: ToolSpec = {
  name: "file.write",
  title: "Write file",
  description: "Write a file",
  permissions: ["write"],
  parameters: {
    path: { type: "string", description: "Path", required: true },
    content: { type: "string", description: "Content", required: true },
  },
} as unknown as ToolSpec;

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: DEFAULT_FREE_MODEL,
    systemPrompt: "You are a careful engineer.",
    messages: [{ role: "user", content: "Build it." }],
    tools: [TOOL],
    temperature: null,
    maxTokens: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Stands in for OpenRouter. Returns the captured requests for assertions.
 *
 * The provider checks the model catalogue before completing, so assertions pick
 * the completion call by URL rather than assuming it is the first one.
 */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  });
  return calls;
}

/** The completion request, skipping any catalogue lookup that preceded it. */
function completion(calls: { url: string; init: RequestInit }[]) {
  const call = calls.find((c) => c.url.endsWith("/chat/completions"));
  if (!call) throw new Error("no completion request was made");
  return call;
}

const KEY = { OPENROUTER_API_KEY: "sk-or-v1-test" };

afterEach(() => vi.unstubAllGlobals());

describe("configuration", () => {
  it("is not configured without a key, and says which variable is missing", async () => {
    const provider = new OpenRouterProvider({});
    expect(provider.configured).toBe(false);
    await expect(provider.next(request())).rejects.toMatchObject({
      kind: "not_configured",
      message: expect.stringContaining("OPENROUTER_API_KEY"),
    });
  });

  it("never mentions ANTHROPIC_API_KEY", () => {
    const provider = new OpenRouterProvider({});
    expect(JSON.stringify(provider.models)).not.toMatch(/anthropic/i);
  });

  it("ships free models by default", () => {
    const provider = new OpenRouterProvider(KEY);
    expect(provider.configured).toBe(true);
    expect(provider.models.length).toBeGreaterThan(0);
    // Every default must carry the suffix that makes OpenRouter bill nothing.
    for (const m of provider.models) expect(m.id, m.id).toMatch(/:free$/);
  });

  it("takes an override list so a retired model can be swapped without a deploy", () => {
    const provider = new OpenRouterProvider({
      ...KEY,
      OPENROUTER_MODELS: "vendor/new-model:free|New Model, vendor/other:free",
    });
    expect(provider.models).toEqual([
      { id: "vendor/new-model:free", label: "New Model" },
      { id: "vendor/other:free", label: "vendor/other:free" },
    ]);
  });

  it("falls back to the defaults when the override is blank or junk", () => {
    for (const value of ["", "   ", ",,,"]) {
      expect(new OpenRouterProvider({ ...KEY, OPENROUTER_MODELS: value }).models.length).toBeGreaterThan(0);
    }
  });
});

describe("a successful turn", () => {
  it("sends an OpenAI-compatible request with the key in the header", async () => {
    const calls = stubFetch(200, {
      choices: [{ message: { content: "Writing it.", tool_calls: [] } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });

    await new OpenRouterProvider(KEY).next(request());

    const call = completion(calls);
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or-v1-test");
    expect(headers["X-Title"]).toBe("AI Agent Arena");

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_FREE_MODEL);
    expect(body.tool_choice).toBe("auto");
    // The tool catalogue must survive the projection, or the agent cannot act.
    expect(body.tools).toHaveLength(1);
    const tools = body.tools as { function: { name: string; parameters: unknown } }[];
    expect(tools[0]!.function.name).toBe("file.write");
    expect(tools[0]!.function.parameters).toMatchObject({ required: ["path", "content"] });
    // The system prompt leads the conversation.
    expect((body.messages as { role: string }[])[0]!.role).toBe("system");
  });

  it("parses tool calls, including arguments sent as a JSON string", async () => {
    stubFetch(200, {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "file.write", arguments: '{"path":"/index.html","content":"<h1>hi</h1>"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const turn = await new OpenRouterProvider(KEY).next(request());
    expect(turn.done).toBe(false);
    expect(turn.toolCalls).toEqual([
      { id: "call_1", name: "file.write", args: { path: "/index.html", content: "<h1>hi</h1>" } },
    ]);
  });

  it("reports a free model as costing zero, not as unknown", async () => {
    stubFetch(200, {
      choices: [{ message: { content: "Done." } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const turn = await new OpenRouterProvider(KEY).next(request());
    expect(turn.usage).toEqual({ tokensIn: 100, tokensOut: 20, costUsd: 0 });
    expect(turn.done).toBe(true);
  });

  it("reports a paid model's cost as unknown rather than inventing one", async () => {
    stubFetch(200, {
      choices: [{ message: { content: "Done." } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const turn = await new OpenRouterProvider(KEY).next(request({ model: "openai/gpt-4o" }));
    expect(turn.usage.costUsd).toBeNull();
  });

  it("round-trips a prior tool call and its result", async () => {
    const calls = stubFetch(200, { choices: [{ message: { content: "ok" } }] });
    await new OpenRouterProvider(KEY).next(
      request({
        messages: [
          { role: "user", content: "Build it." },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "file.write", args: { path: "/a.txt", content: "x" } }],
          },
          { role: "tool", content: "written", toolCallId: "call_1", toolName: "file.write" },
        ],
      }),
    );
    const body = JSON.parse(String(completion(calls).init.body)) as { messages: Record<string, unknown>[] };
    const assistant = body.messages.find((m) => m.role === "assistant")!;
    expect((assistant.tool_calls as { id: string }[])[0]!.id).toBe("call_1");
    const tool = body.messages.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toBe("call_1");
  });
});

describe("failing gracefully on the free tier", () => {
  async function failWith(status: number, body: unknown) {
    stubFetch(status, body);
    return new OpenRouterProvider(KEY)
      .next(request())
      .then(() => null)
      .catch((e: unknown) => e as ProviderError);
  }

  it("calls a retired model unavailable, not an auth problem", async () => {
    const error = await failWith(404, { error: { message: "No endpoints found" } });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error!.kind).toBe("unavailable");
  });

  it("points a free-model 404 at the setting that usually causes it", async () => {
    // OpenRouter returns this same 404 when the account's privacy settings
    // exclude every provider willing to serve a free endpoint. The wording
    // says the model is missing; the cause is usually the account.
    const error = await failWith(404, { error: { message: "No endpoints found for this model" } });
    expect(error!.message).toMatch(/settings\/privacy/);
    expect(error!.message).toMatch(/every free model is failing/i);
    expect(error!.message).toMatch(/OPENROUTER_MODELS/);
  });

  it("does not blame the privacy setting for a paid model", async () => {
    stubFetch(404, { error: { message: "No endpoints found" } });
    const error = await new OpenRouterProvider(KEY)
      .next(request({ model: "openai/gpt-4o" }))
      .then(() => null)
      .catch((e: unknown) => e as ProviderError);
    expect(error!.message).not.toMatch(/settings\/privacy/);
    expect(error!.message).toMatch(/retired/);
  });

  it("calls a rate limit a rate limit, and marks it retryable", async () => {
    const error = await failWith(429, { error: { message: "Rate limit exceeded" } });
    expect(error!.kind).toBe("rate_limit");
    expect(error!.retryable).toBe(true);
  });

  it("treats a 402 as needing credits rather than as a bad key", async () => {
    const error = await failWith(402, { error: { message: "Insufficient credits" } });
    expect(error!.kind).toBe("auth");
  });

  it("surfaces a bad key", async () => {
    const error = await failWith(401, { error: { message: "Invalid key" } });
    expect(error!.kind).toBe("auth");
  });

  it("catches an error returned inside a 200 body", async () => {
    // OpenRouter answers 200 with an error payload when the upstream provider
    // fails. Without this the harness would see a valid, empty turn and the
    // agent would silently do nothing for a step.
    const error = await failWith(200, { error: { message: "Upstream timed out", code: 503 } });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error!.kind).toBe("unavailable");
    expect(error!.retryable).toBe(true);
  });

  it("catches a per-choice error too", async () => {
    const error = await failWith(200, {
      choices: [{ error: { message: "Model overloaded", code: 429 } }],
    });
    expect(error!.kind).toBe("rate_limit");
  });

  it("does not report an empty response as a completed turn", async () => {
    const error = await failWith(200, { choices: [] });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error!.kind).toBe("unavailable");
  });

  it("never leaks the key into an error message", async () => {
    for (const status of [401, 402, 404, 429, 500]) {
      const error = await failWith(status, { error: { message: "nope" } });
      expect(error!.message).not.toContain("sk-or-v1-test");
    }
  });
});

describe("discovering which free models actually exist", () => {
  function stubModels(status: number, body: unknown) {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      ),
    );
  }

  it("keeps only free models, and marks which can call tools", async () => {
    stubModels(200, {
      data: [
        { id: "vendor/good:free", name: "Good", supported_parameters: ["tools", "temperature"] },
        { id: "vendor/chat-only:free", name: "Chat Only", supported_parameters: ["temperature"] },
        { id: "vendor/paid", name: "Paid", supported_parameters: ["tools"] },
      ],
    });
    const models = await discoverFreeModels(KEY);
    expect(models?.map((m) => m.id)).toEqual(["vendor/good:free", "vendor/chat-only:free"]);
    // Tool-capable first, because only those can compete here.
    expect(models?.[0]).toMatchObject({ id: "vendor/good:free", supportsTools: true });
    expect(models?.[1]!.supportsTools).toBe(false);
  });

  it("returns null rather than an empty list when it cannot check", async () => {
    // "Could not check" and "none available" are different claims, and showing
    // the second when the first is true would be a lie about the free tier.
    expect(await discoverFreeModels({})).toBeNull();

    stubModels(401, { error: { message: "bad key" } });
    expect(await discoverFreeModels(KEY)).toBeNull();

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(await discoverFreeModels(KEY)).toBeNull();
  });
});

describe("a match built from a typed brief stays readable", () => {
  it("rebuilds the custom task on the live arena page", () => {
    // A live match routes through /arena/<id> rather than rendering in place.
    // Without this the task cannot be reconstructed from the match and every
    // model-driven custom brief 404s.
    const page = readFileSync("src/app/arena/[matchId]/page.tsx", "utf8");
    expect(page).toMatch(/ensureCustomTask\(match\)/);
    // Both the page and its metadata read the task, so both need it.
    expect(page.match(/ensureCustomTask\(match\)/g)).toHaveLength(2);
  });
});

describe("surviving a retired free model", () => {
  function stubRouter(dead: string[], alive: string) {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      const json = (status: number, body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
        );
      if (String(url).endsWith("/models")) {
        return json(200, {
          data: [
            { id: alive, name: "Alive", supported_parameters: ["tools"] },
            { id: "vendor/chat-only:free", name: "Chat only", supported_parameters: [] },
          ],
        });
      }
      const body = JSON.parse(String(init.body)) as { model: string };
      if (dead.includes(body.model)) {
        return json(404, {
          error: { message: "This model is unavailable for free. The paid version is available now" },
        });
      }
      return json(200, { choices: [{ message: { content: "ok" } }], usage: {} });
    });
  }

  it("runs on a live free model when the configured one has been retired", async () => {
    // The exact failure seen in production: the id was real when it shipped and
    // is now paid-only. Hard-coded ids rot, so the request is repointed rather
    // than the run abandoned.
    const dead = "google/gemini-2.0-flash-exp:free";
    stubRouter([dead], "vendor/alive:free");

    const turn = await new OpenRouterProvider(KEY).next(request({ model: dead }));
    expect(turn.modelUsed).toBe("vendor/alive:free");
    // Still free, so the cost is still a measured zero.
    expect(turn.usage.costUsd).toBe(0);
  });

  it("never silently substitutes a model that cannot call tools", async () => {
    stubRouter(["vendor/dead:free"], "vendor/alive:free");
    const turn = await new OpenRouterProvider(KEY).next(request({ model: "vendor/dead:free" }));
    expect(turn.modelUsed).not.toBe("vendor/chat-only:free");
  });

  it("leaves a paid model exactly as asked", async () => {
    // Substituting here would spend money on something nobody chose.
    stubRouter(["openai/gpt-4o"], "vendor/alive:free");
    const error = await new OpenRouterProvider(KEY)
      .next(request({ model: "openai/gpt-4o" }))
      .then(() => null)
      .catch((e: unknown) => e as ProviderError);
    expect(error!.kind).toBe("unavailable");
  });

  it("uses the requested model untouched when it is still alive", async () => {
    stubRouter([], "vendor/alive:free");
    const turn = await new OpenRouterProvider(KEY).next(request({ model: "vendor/alive:free" }));
    expect(turn.modelUsed).toBe("vendor/alive:free");
  });
});
