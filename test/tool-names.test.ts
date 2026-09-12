import { afterEach, describe, expect, it, vi } from "vitest";
import { toolNameMap } from "@/lib/agents/providers/types";
import { OpenRouterProvider, DEFAULT_FREE_MODEL } from "@/lib/agents/providers/openrouter";
import { OpenAIProvider } from "@/lib/agents/providers/openai";
import { AnthropicProvider } from "@/lib/agents/providers/anthropic";
import { GoogleProvider } from "@/lib/agents/providers/google";
import { allTools } from "@/lib/tools/registry";
import type { ProviderRequest } from "@/lib/agents/providers/types";
import type { ToolSpec } from "@/lib/arena/types";

/**
 * The arena names tools `file.read`, `shell.exec`, `code.run`. Every function
 * calling API in use rejects the dot, and rejects it on the *request* — so one
 * unmapped name is not a degraded turn, it is a 400 that ends the match before
 * a single tool has run. That is exactly what happened in production:
 *
 *   invalid request: tool names can only contain certain characters (A-Za-z0-9_)
 *
 * Both agents failed every assertion without ever having been asked a question.
 * These tests hold the wire format to that constraint, and hold the mapping
 * back so that nothing above the adapter has to know it happened.
 */

const WIRE_SAFE = /^[A-Za-z0-9_]+$/;

function spec(name: string): ToolSpec {
  return {
    name,
    title: name,
    description: `Tool ${name}`,
    permission: "read",
    timeoutMs: 1000,
    cost: 0,
    parameters: { path: { type: "string", description: "Path", required: true } },
  };
}

describe("toolNameMap", () => {
  it("makes every real arena tool name legal on the wire", () => {
    const names = toolNameMap(allTools());
    for (const tool of allTools()) {
      expect(names.toWire(tool.name), tool.name).toMatch(WIRE_SAFE);
    }
  });

  it("round-trips every real tool name, so the registry still sees the real one", () => {
    const names = toolNameMap(allTools());
    for (const tool of allTools()) {
      expect(names.fromWire(names.toWire(tool.name))).toBe(tool.name);
    }
  });

  it("maps the dotted names to the obvious underscored ones", () => {
    const names = toolNameMap(allTools());
    expect(names.toWire("file.read")).toBe("file_read");
    expect(names.toWire("shell.exec")).toBe("shell_exec");
    expect(names.fromWire("code_run")).toBe("code.run");
  });

  it("keeps two names that sanitise alike apart, rather than routing one to the other", () => {
    const names = toolNameMap([spec("file.read"), spec("file_read")]);
    const a = names.toWire("file.read");
    const b = names.toWire("file_read");

    expect(a).not.toBe(b);
    expect(a).toMatch(WIRE_SAFE);
    expect(b).toMatch(WIRE_SAFE);
    // The point of the disambiguation: each still comes back as itself.
    expect(names.fromWire(a)).toBe("file.read");
    expect(names.fromWire(b)).toBe("file_read");
  });

  it("is deterministic, so the same catalogue always produces the same wire names", () => {
    const build = () => toolNameMap([spec("a.b"), spec("a_b"), spec("a-b")]);
    const first = build();
    const second = build();
    for (const name of ["a.b", "a_b", "a-b"]) {
      expect(second.toWire(name)).toBe(first.toWire(name));
    }
  });

  it("passes an invented name straight back, so the registry can say it is unknown", () => {
    const names = toolNameMap(allTools());
    // A model that hallucinates a tool must produce the arena's own "unknown
    // tool" error — the one an agent can read and recover from — not a silent
    // remap onto a real tool.
    expect(names.fromWire("definitely_not_a_tool")).toBe("definitely_not_a_tool");
  });

  it("sanitises an unmapped name on the way out, so replayed history cannot 400 the next turn", () => {
    const names = toolNameMap(allTools());
    // Last turn's invented `some.made.up` comes back through the history. Sent
    // as-is it would fail the whole request exactly as the first one did.
    expect(names.toWire("some.made.up")).toMatch(WIRE_SAFE);
  });

  it("stays inside the 64-character limit every one of these APIs enforces", () => {
    const long = `a.${"x".repeat(200)}`;
    const names = toolNameMap([spec(long)]);
    const wire = names.toWire(long);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(wire).toMatch(WIRE_SAFE);
    expect(names.fromWire(wire)).toBe(long);
  });

  it("never emits an empty name from a name made entirely of illegal characters", () => {
    const names = toolNameMap([spec("...")]);
    expect(names.toWire("...")).toMatch(WIRE_SAFE);
  });
});

// ─── the wire itself ─────────────────────────────────────────────────────────

afterEach(() => vi.unstubAllGlobals());

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: DEFAULT_FREE_MODEL,
    systemPrompt: "You are a careful engineer.",
    messages: [{ role: "user", content: "Build a coffee shop landing page." }],
    tools: allTools(),
    temperature: null,
    maxTokens: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Captures request bodies so the wire format can be asserted directly. */
function capture(body: unknown) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (init?.body) {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  return sent;
}

/** Every tool name anywhere in a request body, however the vendor nests them. */
function toolNamesIn(body: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, key: string | null) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "name" && typeof v === "string") found.push(v);
      else walk(v, k);
    }
  };
  walk(body, null);
  return found;
}

const OPENAI_SHAPED = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "file_write", arguments: '{"path":"index.html"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

describe("OpenRouter", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-v1-test" };

  it("sends no illegal character in any tool name", async () => {
    const sent = capture(OPENAI_SHAPED);
    await new OpenRouterProvider(env).next(request());

    const completion = sent.find((s) => s.url.endsWith("/chat/completions"));
    expect(completion, "no completion request was made").toBeDefined();
    const names = toolNamesIn(completion!.body);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name, name).toMatch(WIRE_SAFE);
  });

  it("hands the harness back the arena's own name, not the wire one", async () => {
    capture(OPENAI_SHAPED);
    const turn = await new OpenRouterProvider(env).next(request());
    // `file_write` on the wire; `file.write` is what the registry can invoke.
    expect(turn.toolCalls[0]?.name).toBe("file.write");
  });

  it("maps replayed history too, so turn two fails no differently from turn one", async () => {
    const sent = capture(OPENAI_SHAPED);
    await new OpenRouterProvider(env).next(
      request({
        messages: [
          { role: "user", content: "Build it." },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "file.write", args: { path: "index.html" } }],
          },
          { role: "tool", content: "ok", toolCallId: "call_1", toolName: "file.write" },
        ],
      }),
    );

    const completion = sent.find((s) => s.url.endsWith("/chat/completions"));
    for (const name of toolNamesIn(completion!.body)) expect(name, name).toMatch(WIRE_SAFE);
  });
});

describe("the other adapters have the same constraint", () => {
  it("OpenAI sends legal names and maps the reply back", async () => {
    const sent = capture(OPENAI_SHAPED);
    const turn = await new OpenAIProvider({ OPENAI_API_KEY: "sk-test" }).next(
      request({ model: "gpt-4o-mini" }),
    );
    for (const name of toolNamesIn(sent[0]!.body)) expect(name, name).toMatch(WIRE_SAFE);
    expect(turn.toolCalls[0]?.name).toBe("file.write");
  });

  it("Anthropic sends legal names and maps the reply back", async () => {
    const sent = capture({
      content: [{ type: "tool_use", id: "tu_1", name: "file_write", input: { path: "index.html" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const turn = await new AnthropicProvider({ ANTHROPIC_API_KEY: "sk-ant-test" }).next(
      request({ model: "claude-haiku-4-5" }),
    );
    for (const name of toolNamesIn(sent[0]!.body)) expect(name, name).toMatch(WIRE_SAFE);
    expect(turn.toolCalls[0]?.name).toBe("file.write");
  });

  it("Google sends legal names and maps the reply back", async () => {
    const sent = capture({
      candidates: [
        { content: { parts: [{ functionCall: { name: "file_write", args: { path: "index.html" } } }] } },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
    const turn = await new GoogleProvider({ GOOGLE_API_KEY: "test" }).next(
      request({
        model: "gemini-2.0-flash",
        messages: [{ role: "tool", content: "ok", toolCallId: "1", toolName: "file.write" }],
      }),
    );
    for (const name of toolNamesIn(sent[0]!.body)) expect(name, name).toMatch(WIRE_SAFE);
    expect(turn.toolCalls[0]?.name).toBe("file.write");
  });
});
