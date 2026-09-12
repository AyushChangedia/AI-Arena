import type { ProviderId } from "@/lib/arena/types";
import type { ModelProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { GoogleProvider } from "./google";

/**
 * Live provider registry. The scripted provider is not here: it is constructed
 * per execution with that execution's policy, so it has no global instance.
 */

let cache: Map<ProviderId, ModelProvider> | null = null;

function build(): Map<ProviderId, ModelProvider> {
  const list: ModelProvider[] = [new AnthropicProvider(), new OpenAIProvider(), new GoogleProvider()];
  return new Map(list.map((p) => [p.id, p]));
}

export function liveProviders(): Map<ProviderId, ModelProvider> {
  cache ??= build();
  return cache;
}

export function getProvider(id: ProviderId): ModelProvider | undefined {
  return liveProviders().get(id);
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  models: { id: string; label: string }[];
  /** Environment variable that would configure it. Never the value. */
  envVar: string;
}

const ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Safe to send to the browser: booleans and labels only. No key material, and
 * no indication of key length or shape.
 */
export function providerStatuses(): ProviderStatus[] {
  return [...liveProviders().values()].map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.configured,
    models: p.models,
    envVar: ENV_VARS[p.id] ?? "",
  }));
}

export function anyProviderConfigured(): boolean {
  return [...liveProviders().values()].some((p) => p.configured);
}

/** Forces re-reading the environment. Used by tests. */
export function resetProviderCache(): void {
  cache = null;
}
