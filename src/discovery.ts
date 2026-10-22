import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { asRecord, parseModels, type ChatModelConfig } from "./catalog.ts";

interface DiscoveryProvider {
  id: string;
  baseUrl: string;
  api: Api;
  modelsUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface CacheEntry {
  fingerprint: string;
  models: ChatModelConfig[];
}

interface CacheFile {
  version: 1;
  providers: Record<string, CacheEntry>;
}

type Notify = (message: string, level?: "info" | "warning") => void;
type FetchCache = Map<string, Promise<ChatModelConfig[]>>;

// Match Pi's models.json support for line comments and trailing commas.
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
    if (value === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return value;
  });
}

function requestConfig(entry: DiscoveryProvider) {
  const url = entry.modelsUrl || `${entry.baseUrl.replace(/\/+$/, "")}/models`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(entry.headers ?? {})) headers.set(name, resolveEnvValue(value));
  if (entry.apiKey !== undefined) {
    const key = resolveEnvValue(entry.apiKey);
    if (key) headers.set("Authorization", `Bearer ${key}`);
  }
  // Hash resolved authentication too, so rotating an environment variable invalidates the cache.
  const requestKey = createHash("sha256").update(JSON.stringify([url, [...headers], entry.compat])).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify([entry.baseUrl, entry.api, requestKey])).digest("hex");
  return { url, headers, requestKey, fingerprint };
}

async function fetchModels(entry: DiscoveryProvider, signal?: AbortSignal): Promise<ChatModelConfig[]> {
  const { url, headers } = requestConfig(entry);
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}.`);
  return parseModels(await response.json(), entry.compat);
}

function fetchShared(entry: DiscoveryProvider, cache: FetchCache, signal?: AbortSignal): Promise<ChatModelConfig[]> {
  const { requestKey } = requestConfig(entry);
  let pending = cache.get(requestKey);
  if (!pending) {
    pending = fetchModels(entry, signal);
    cache.set(requestKey, pending);
  }
  return pending;
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
    // Individual model lists are validated before use.
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

  const agentDir = getAgentDir();
  const cachePath = join(agentDir, "cache", "pi-model-discovery.json");
  const providers = await readProviders(join(agentDir, "models.json"), notify);
  const cache = providers.length ? await readCache(cachePath, notify) : { version: 1 as const, providers: {} };
  let writes = Promise.resolve();

  // Serialize read/modify/write and replace atomically to avoid truncated cache files.
  function persist(entry: DiscoveryProvider, models: ChatModelConfig[]): Promise<void> {
    const fingerprint = requestConfig(entry).fingerprint;
    writes = writes.then(async () => {
      const latest = await readCache(cachePath, notify);
      Object.defineProperty(latest.providers, entry.id, {
        value: { fingerprint, models }, enumerable: true, configurable: true, writable: true,
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

  const states = new Map<string, { entry: DiscoveryProvider; models?: ChatModelConfig[]; config: ProviderConfig }>();
  const startupRequests: FetchCache = new Map();
  for (const entry of providers) {
    const state: { entry: DiscoveryProvider; models?: ChatModelConfig[]; config: ProviderConfig } = {
      entry,
      config: { baseUrl: entry.baseUrl, api: entry.api },
    };
    state.config.refreshModels = async (context) => {
      if (!context.allowNetwork) {
        if (!state.models?.length) throw new Error("No discovered models are cached; preserving configured fallback models.");
        return state.models;
      }
      const models = await fetchModels(entry, context.signal);
      context.signal.throwIfAborted();
      await persist(entry, models);
      state.models = models;
      return models;
    };
    try {
      const cached = Object.hasOwn(cache.providers, entry.id) ? cache.providers[entry.id] : undefined;
      if (cached && cached.fingerprint === requestConfig(entry).fingerprint) {
        try {
          state.models = parseModels(cached.models, entry.compat);
        } catch {
          notify(`${entry.id}: invalid cached models; rediscovering.`);
        }
      }
      if (!state.models) {
        state.models = await fetchShared(entry, startupRequests);
        await persist(entry, state.models);
      }
    } catch (error) {
      notify(`${entry.id}: discovery failed: ${errorMessage(error)}`);
    }
    if (state.models) state.config.models = state.models;
    try {
      // Let Pi's models.json layer supply authentication, names, headers and modelOverrides.
      // Omitting models on failure preserves the configured static fallback.
      pi.registerProvider(entry.id, state.config);
      states.set(entry.id, state);
    } catch (error) {
      notify(`${entry.id}: registration failed: ${errorMessage(error)}`);
    }
  }

  pi.registerCommand("model-discovery-refresh", {
    description: "Rediscover models and update the local model cache",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const requests: FetchCache = new Map();
      let refreshed = 0;
      for (const state of states.values()) {
        try {
          const models = await fetchShared(state.entry, requests);
          pi.registerProvider(state.entry.id, { ...state.config, models });
          state.models = models;
          await persist(state.entry, models);
          refreshed++;
        } catch (error) {
          ctx.ui.notify(`[model-discovery] ${state.entry.id}: refresh failed: ${errorMessage(error)}`, "warning");
        }
      }
      ctx.ui.notify(`[model-discovery] Refreshed ${refreshed}/${states.size} providers.`, refreshed === states.size ? "info" : "warning");
    },
  });
}
