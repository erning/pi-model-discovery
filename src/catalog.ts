import type { ModelCostRates } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

export interface ModelMetadata {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ChatModelConfig["input"];
  reasoning?: boolean;
  cost?: Partial<ModelCostRates>;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function positiveTokenLimit(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function nonNegativeCost(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function capabilitySupported(value: unknown): boolean | undefined {
  const supported = typeof value === "boolean" ? value : asRecord(value).supported;
  return typeof supported === "boolean" ? supported : undefined;
}

// Chat models always accept text; advertised modalities determine image support.
function modelInput(input: unknown, capabilities: Record<string, unknown>): ChatModelConfig["input"] | undefined {
  const image = Array.isArray(input) && (input.includes("text") || input.includes("image"))
    ? input.includes("image")
    : capabilitySupported(capabilities.vision) ?? capabilitySupported(capabilities.image_input);
  return image === undefined ? undefined : image ? ["text", "image"] : ["text"];
}

export function canonicalizeModel(value: unknown): ModelMetadata | undefined {
  const raw = asRecord(value);
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return undefined;
  const capabilities = asRecord(raw.capabilities);
  const cost = asRecord(raw.cost);
  const pricing = asRecord(raw.pricing);
  return {
    id: raw.id,
    name: nonEmptyString(raw.name, raw.display_name),
    contextWindow: positiveTokenLimit(raw.context_window, raw.contextWindow, raw.max_model_len, raw.context_length, raw.max_context_length, raw.max_input_tokens),
    maxTokens: positiveTokenLimit(raw.max_tokens, raw.maxTokens, raw.max_output_tokens, raw.max_completion_tokens),
    input: modelInput(raw.input, capabilities),
    reasoning: capabilitySupported(raw.reasoning)
      ?? capabilitySupported(capabilities.reasoning)
      ?? capabilitySupported(capabilities.thinking),
    cost: {
      input: nonNegativeCost(cost.input, pricing.input_per_million),
      output: nonNegativeCost(cost.output, pricing.output_per_million),
      cacheRead: nonNegativeCost(cost.cacheRead, cost.cache_read, pricing.cache_read_input_per_million),
      cacheWrite: nonNegativeCost(cost.cacheWrite, cost.cache_write, pricing.cache_creation_input_per_million),
    },
  };
}

export function buildModel(model: ModelMetadata, providerCompat?: Record<string, unknown>): ChatModelConfig {
  const { reasoning, thinkingLevelMap, ...compat } = providerCompat ?? {};
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: typeof reasoning === "boolean" ? reasoning : (model.reasoning ?? true),
    thinkingLevelMap: {
      xhigh: null,
      max: null,
      ...asRecord(thinkingLevelMap) as ChatModelConfig["thinkingLevelMap"],
    },
    compat: { supportsDeveloperRole: false, ...compat },
    input: model.input ?? ["text", "image"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? 1_000_000,
    maxTokens: model.maxTokens ?? 65_536,
  };
}

export function parseModels(payload: unknown, compat?: Record<string, unknown>): ChatModelConfig[] {
  const entries = Array.isArray(payload) ? payload : asRecord(payload).data;
  const models = (Array.isArray(entries) ? entries : [])
    .map(canonicalizeModel)
    .filter((model) => model !== undefined)
    .map((model) => buildModel(model, compat));
  if (models.length === 0) throw new Error("The model catalog contains no valid model IDs.");
  return models;
}
