import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api, ModelCostRates } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

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

interface DiscoveryProvider {
  id: string;
  baseUrl: string;
  api: Api;
  modelsUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderState {
  entry: DiscoveryProvider;
  config: ProviderConfig;
  models?: ChatModelConfig[];
  fetchedAt?: number;
}

interface CatalogRequest {
  url: string;
  headers: Headers;
  requestKey: string;
}

interface CacheEntry {
  fingerprint: string;
  fetchedAt?: number;
  models: ChatModelConfig[];
}

interface CacheFile {
  version: 1;
  providers: Record<string, CacheEntry>;
}

type Notify = (message: string, level?: "info" | "warning") => void;
type FetchCache = Map<string, Promise<ChatModelConfig[]>>;

// Bump when parsing or defaults change, so cached models are rebuilt from the catalog.
const MODEL_FORMAT = 2;
// Pi refreshes catalogs in the background on every interactive start. Like Pi's built-in
// catalogs, skip the request when the last successful fetch is this recent.
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

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
    contextWindow: positiveTokenLimit(
      raw.context_window,
      raw.contextWindow,
      raw.max_model_len,
      raw.context_length,
      raw.max_context_length,
      raw.max_input_tokens,
    ),
    maxTokens: positiveTokenLimit(
      raw.max_tokens,
      raw.maxTokens,
      raw.max_output_tokens,
      raw.max_completion_tokens,
    ),
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

// Missing metadata uses the defaults Pi applies to handwritten models.json models.
export function buildModel(model: ModelMetadata, providerCompat?: Record<string, unknown>): ChatModelConfig {
  const { reasoning, thinkingLevelMap, ...compat } = providerCompat ?? {};
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: typeof reasoning === "boolean" ? reasoning : (model.reasoning ?? false),
    thinkingLevelMap: {
      xhigh: null,
      max: null,
      ...asRecord(thinkingLevelMap) as ChatModelConfig["thinkingLevelMap"],
    },
    compat: { supportsDeveloperRole: false, ...compat },
    input: model.input ?? ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
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

// Match Pi's models.json support for BOM, line comments, and trailing commas.
function parseConfig(text: string): Record<string, unknown> {
  const json = text
    .replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match.startsWith('"') ? match : "")
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match);
  const data: unknown = JSON.parse(json);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("models.json must contain an object.");
  }
  return asRecord(data);
}

async function readProviders(path: string, notify: Notify): Promise<DiscoveryProvider[]> {
  let data: Record<string, unknown>;
  try {
    data = parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") notify(`Cannot read models.json: ${errorMessage(error)}`);
    return [];
  }
  const providers: DiscoveryProvider[] = [];
  for (const [id, value] of Object.entries(asRecord(data.providers))) {
    const raw = asRecord(value);
    if (raw.discoverModels !== true) continue;
    if (typeof raw.baseUrl !== "string" || !raw.baseUrl || typeof raw.api !== "string" || !raw.api) {
      notify(`${id}: discovery requires baseUrl and api.`);
      continue;
    }
    const headers = asRecord(raw.headers);
    if (Object.values(headers).some((value) => typeof value !== "string")) {
      notify(`${id}: discovery headers must be strings.`);
      continue;
    }
    providers.push({
      id,
      baseUrl: raw.baseUrl,
      api: raw.api as Api,
      modelsUrl: typeof raw.modelsUrl === "string" ? raw.modelsUrl : undefined,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
      headers: headers as Record<string, string>,
      compat: asRecord(raw.compat),
    });
  }
  return providers;
}

export function resolveEnvValue(raw: string): string {
  if (raw.startsWith("!")) throw new Error("Discovery does not execute !command credentials; use an environment variable.");
  return raw.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    if (match === "$$") return "$";
    if (match === "$!") return "!";
    const name = (braced ?? plain) as string;
    const value = process.env[name];
    // Like Pi, treat an empty variable as unset.
    if (!value) throw new Error(`Environment variable ${name} is empty or not set.`);
    return value;
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveHeaders(entry: DiscoveryProvider): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(entry.headers ?? {})) headers.set(name, resolveEnvValue(value));
  return headers;
}

// Startup resolves the configured key from the environment. Refreshes pass Pi's effective
// API key, which also covers !command keys and keys saved with /login.
function catalogRequest(entry: DiscoveryProvider, apiKey?: string): CatalogRequest {
  const url = entry.modelsUrl || `${entry.baseUrl.replace(/\/+$/, "")}/models`;
  const headers = resolveHeaders(entry);
  const key = apiKey ?? (entry.apiKey === undefined ? undefined : resolveEnvValue(entry.apiKey));
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return { url, headers, requestKey: hash([url, [...headers], entry.compat]) };
}

// Hash resolved values, so rotating an environment variable invalidates the cache. A !command
// key is identified by its text, so its cache verifies at startup without running the command.
function fingerprint(entry: DiscoveryProvider): string {
  const apiKey = entry.apiKey?.startsWith("!") ? entry.apiKey : entry.apiKey && resolveEnvValue(entry.apiKey);
  return hash([MODEL_FORMAT, entry.baseUrl, entry.api, entry.modelsUrl || "", [...resolveHeaders(entry)], apiKey, entry.compat]);
}

async function fetchModels(entry: DiscoveryProvider, request: CatalogRequest, signal?: AbortSignal): Promise<ChatModelConfig[]> {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(request.url, {
    headers: request.headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}.`);
  return parseModels(await response.json(), entry.compat);
}

function fetchShared(entry: DiscoveryProvider, request: CatalogRequest, cache: FetchCache): Promise<ChatModelConfig[]> {
  let pending = cache.get(request.requestKey);
  if (!pending) {
    pending = fetchModels(entry, request);
    cache.set(request.requestKey, pending);
  }
  return pending;
}

function isFresh(fetchedAt: number | undefined): boolean {
  const age = fetchedAt === undefined ? Infinity : Date.now() - fetchedAt;
  return age >= 0 && age < REFRESH_INTERVAL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCache(path: string, notify: Notify): Promise<CacheFile> {
  try {
    const raw = asRecord(JSON.parse(await readFile(path, "utf8")));
    if (raw.version !== 1 || raw.providers === null || typeof raw.providers !== "object" || Array.isArray(raw.providers)) {
      throw new Error("Unsupported model cache format.");
    }
    return { version: 1, providers: raw.providers as CacheFile["providers"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") notify(`Cannot read model cache: ${errorMessage(error)}`);
    return { version: 1, providers: {} };
  }
}

export default async function discoveryExtension(pi: ExtensionAPI): Promise<void> {
  const pending: Array<{ message: string; level: "info" | "warning" }> = [];
  let showNotice: Notify | undefined;
  const notify: Notify = (message, level = "warning") => {
    if (showNotice) showNotice(message, level);
    else pending.push({ message, level });
  };
  pi.on("session_start", (_event, ctx) => {
    showNotice = (message, level = "warning") => ctx.ui.notify(`[model-discovery] ${message}`, level);
    for (const notice of pending.splice(0)) showNotice(notice.message, notice.level);
  });
  pi.on("session_shutdown", () => { showNotice = undefined; });

  // Pi normalizes --offline to PI_OFFLINE=1 before loading extensions.
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
  const agentDir = getAgentDir();
  const cachePath = join(agentDir, "cache", "pi-model-discovery.json");
  const providers = await readProviders(join(agentDir, "models.json"), notify);
  const cache = providers.length ? await readCache(cachePath, notify) : { version: 1 as const, providers: {} };
  let writes = Promise.resolve();

  // Serialize read/modify/write and replace atomically to avoid truncated cache files.
  function persist({ entry, models, fetchedAt }: ProviderState): Promise<void> {
    writes = writes.then(async () => {
      const latest = await readCache(cachePath, notify);
      Object.defineProperty(latest.providers, entry.id, {
        value: { fingerprint: fingerprint(entry), fetchedAt, models }, enumerable: true, configurable: true, writable: true,
      });
      const temp = `${cachePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(temp, `${JSON.stringify(latest, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, cachePath);
      } finally {
        await rm(temp, { force: true });
      }
    }).catch((error) => { notify(`${entry.id}: cannot save model cache: ${errorMessage(error)}`); });
    return writes;
  }

  function update(state: ProviderState, models: ChatModelConfig[]): Promise<void> {
    state.models = models;
    state.fetchedAt = Date.now();
    return persist(state);
  }

  const states = providers.map((entry) => {
    const state: ProviderState = { entry, config: { baseUrl: entry.baseUrl, api: entry.api } };
    state.config.refreshModels = async (context) => {
      // Pi runs this cache-only step before every network step, and a throw would skip the network step.
      // Returning undefined keeps the current models, including the models.json fallback; [] would clear them.
      if (!context.allowNetwork) return state.models as ChatModelConfig[];
      if (state.models && !context.force && isFresh(state.fetchedAt)) return state.models;
      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      const models = await fetchModels(entry, catalogRequest(entry, apiKey), context.signal);
      context.signal.throwIfAborted();
      await update(state, models);
      return models;
    };
    return state;
  });

  // Start every uncached request before awaiting any, so slow catalogs time out together.
  const startupRequests: FetchCache = new Map();
  await Promise.all(states.map(async (state) => {
    const { entry } = state;
    try {
      const cached = Object.hasOwn(cache.providers, entry.id) ? cache.providers[entry.id] : undefined;
      if (cached && cached.fingerprint === fingerprint(entry)) {
        try {
          state.models = parseModels(cached.models, entry.compat);
          state.fetchedAt = typeof cached.fetchedAt === "number" ? cached.fetchedAt : undefined;
        } catch {
          notify(`${entry.id}: invalid cached models; ignoring cache.`);
        }
      }
      if (state.models) return;
      if (offline) {
        notify(`${entry.id}: offline mode; no matching model cache. Keeping configured fallback models.`);
      } else if (entry.apiKey?.startsWith("!")) {
        notify(`${entry.id}: startup does not run the !command API key; Pi's model refresh or /model-discovery-refresh will discover models.`, "info");
      } else {
        await update(state, await fetchShared(entry, catalogRequest(entry), startupRequests));
      }
    } catch (error) {
      notify(`${entry.id}: discovery failed: ${errorMessage(error)}`);
    }
  }));

  for (const state of states) {
    if (state.models) state.config.models = state.models;
    // Let Pi's models.json layer supply authentication, names, headers and modelOverrides.
    // Omitting models on failure preserves the configured static fallback.
    pi.registerProvider(state.entry.id, state.config);
  }

  pi.registerCommand("model-discovery-refresh", {
    description: "Rediscover models and update the local model cache",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const requests: FetchCache = new Map();
      const results = await Promise.all(states.map(async (state) => {
        try {
          // Authenticate like chat requests do, with Pi's effective API key for the provider.
          const apiKey = await ctx.modelRegistry.getApiKeyForProvider(state.entry.id);
          const models = await fetchShared(state.entry, catalogRequest(state.entry, apiKey), requests);
          pi.registerProvider(state.entry.id, { ...state.config, models });
          await update(state, models);
          return true;
        } catch (error) {
          ctx.ui.notify(`[model-discovery] ${state.entry.id}: refresh failed: ${errorMessage(error)}`, "warning");
          return false;
        }
      }));
      const refreshed = results.filter(Boolean).length;
      ctx.ui.notify(`[model-discovery] Refreshed ${refreshed}/${states.length} providers.`, refreshed === states.length ? "info" : "warning");
    },
  });
}
