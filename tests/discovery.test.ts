import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getSupportedThinkingLevels, type Api, type Model, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import extension, { resolveEnvValue } from "../model-discovery.ts";

const nativeFetch = globalThis.fetch;
const provider = { baseUrl: "https://example.test/v1///", api: "openai-completions", discoverModels: true };
const refreshContext = (allowNetwork: boolean, options: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
  allowNetwork, signal: new AbortController().signal, publish: async () => true, ...options,
});

async function harness(t: TestContext, mockFetch = true) {
  if (!mockFetch) t.mock.method(globalThis, "fetch", nativeFetch);
  const dir = await mkdtemp(join(tmpdir(), "pi-model-discovery-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    await rm(dir, { recursive: true, force: true });
  });
  const requests: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
  let payload: unknown = { data: [{ id: "model", input: ["text"], reasoning: false, context_length: 256_000, max_output_tokens: 8192, pricing: { input_per_million: 1 } }] };
  let status = 200;
  if (mockFetch) t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    requests.push({ url, headers: new Headers(init.headers), signal: init.signal });
    return Response.json(payload, { status });
  });
  const registrations = new Map<string, ProviderConfig>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const notices: string[] = [];
  let piKey: string | undefined;
  const ctx = {
    ui: { notify: (message: string) => notices.push(message) },
    waitForIdle: async () => {},
    modelRegistry: { getApiKeyForProvider: async () => piKey },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerProvider: (id: string, config: ProviderConfig) => { registrations.set(id, config); },
    registerCommand: (name: string, config: Parameters<ExtensionAPI["registerCommand"]>[1]) => { commands.set(name, config); },
    on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => void) => { events.set(name, callback); },
  } as unknown as ExtensionAPI;
  const cachePath = join(dir, "cache", "pi-model-discovery.json");
  return {
    dir, pi, ctx, requests, registrations, commands, notices, cachePath,
    setPayload: (value: unknown) => { payload = value; },
    setStatus: (value: number) => { status = value; },
    setPiKey: (value: string | undefined) => { piKey = value; },
    configure: (providers: Record<string, unknown>) => writeFile(join(dir, "models.json"), JSON.stringify({ providers })),
    cache: () => readFile(cachePath, "utf8"),
    start: async () => { registrations.clear(); await extension(pi); events.get("session_start")?.({}, ctx); },
    refresh: () => commands.get("model-discovery-refresh")!.handler("", ctx),
  };
}

test("startup shares requests, then cache and offline refresh retain advertised metadata", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider, two: { ...provider, modelsUrl: "" }, ignored: { ...provider, discoverModels: false } });
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://example.test/v1/models");
  assert.equal(h.registrations.size, 2);
  const first = h.registrations.get("one")!.models;
  assert.deepEqual(first?.[0].input, ["text"]);
  assert.equal((first?.[0] as { reasoning: boolean }).reasoning, false);
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.registrations.get("one")!.models, first);
  assert.deepEqual(await h.registrations.get("one")!.refreshModels!(refreshContext(false)), first);
  assert.equal(h.requests.length, 1);
  assert.equal(h.notices.length, 0);
});

test("thinking levels survive startup, cache reuse and refresh; old model formats are refetched", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider });
  h.setPayload([{ id: "kimi-code-cn/k3.1-pro", reasoning: true, reasoning_levels: ["low", "high", "max"] }]);
  const levels = () => getSupportedThinkingLevels(h.registrations.get("one")!.models![0] as Model<Api>);
  await h.start();
  assert.deepEqual(levels(), ["low", "high", "max"]);
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(levels(), ["low", "high", "max"]);

  const cache = JSON.parse(await h.cache());
  // Version 3 discarded advertised tiers and cached only these default mappings.
  cache.providers.one.fingerprint = createHash("sha256")
    .update(JSON.stringify([3, provider.baseUrl, provider.api, "", [], undefined, {}])).digest("hex");
  cache.providers.one.models[0].thinkingLevelMap = { xhigh: null, max: null };
  await writeFile(h.cachePath, JSON.stringify(cache));
  await h.start();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(levels(), ["low", "high", "max"]);

  h.setPayload([{ id: "kimi-code-cn/k3.1-pro", reasoning: true,
    supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }]);
  await h.refresh();
  assert.deepEqual(levels(), ["high", "max"]);
  await h.start();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(levels(), ["high", "max"]);
});

test("custom catalog URLs receive resolved auth and headers; cache contains no credentials", async (t) => {
  const h = await harness(t);
  const previousKey = process.env.DISCOVERY_TEST_KEY;
  process.env.DISCOVERY_TEST_KEY = "secret-one";
  t.after(() => {
    if (previousKey === undefined) delete process.env.DISCOVERY_TEST_KEY;
    else process.env.DISCOVERY_TEST_KEY = previousKey;
  });
  await h.configure({ one: { ...provider, modelsUrl: "https://catalog.test/list?region=x", apiKey: "$DISCOVERY_TEST_KEY", headers: { "X-Key": "${DISCOVERY_TEST_KEY}" } } });
  await h.start();
  assert.equal(h.requests[0].url, "https://catalog.test/list?region=x");
  assert.equal(h.requests[0].headers.get("Authorization"), "Bearer secret-one");
  assert.equal(h.requests[0].headers.get("X-Key"), "secret-one");
  assert.equal((await h.cache()).includes("secret-one"), false);
  process.env.DISCOVERY_TEST_KEY = "secret-two";
  await h.start();
  assert.equal(h.requests.length, 2, "resolved environment credential rotation invalidates cache");
  assert.equal(h.requests[1].headers.get("Authorization"), "Bearer secret-two");
  assert.equal("apiKey" in h.registrations.get("one")!, false);
});

test("provider names and model overrides do not invalidate cache; manual refresh fetches the new catalog", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider });
  await h.start();
  h.setPayload([{ id: "new-server-model" }]);
  await h.configure({ one: { ...provider, name: "Renamed", modelOverrides: { model: { maxTokens: 1024 } } } });
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.registrations.get("one")!.models?.[0].id, "model");
  await h.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(h.registrations.get("one")!.models?.[0].id, "new-server-model");
});

test("an API key replaces the configured Authorization header", async (t) => {
  const h = await harness(t);
  for (const apiKey of [undefined, "replacement-key"]) {
    await h.configure({ one: { ...provider, apiKey, headers: { authorization: "Custom credential" } } });
    await h.start();
    await h.refresh();
    assert.equal(h.requests.at(-1)!.headers.get("Authorization"),
      apiKey ? "Bearer replacement-key" : "Custom credential");
  }
});

test("online hook and command refresh update disk; command shares requests", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider, two: provider });
  await h.start();
  h.setPayload([{ id: "updated", reasoning: false, pricing: { output_per_million: 2 } }]);
  const models = await h.registrations.get("one")!.refreshModels!(refreshContext(true, { force: true }));
  assert.equal(models[0].id, "updated");
  assert.equal(models[0].cost.output, 2);
  await h.refresh();
  assert.equal(h.requests.length, 3);
  await h.start();
  assert.equal(h.requests.length, 3);
  assert.equal(h.registrations.get("two")!.models?.[0].id, "updated");
});

test("compatibility changes are isolated and invalidate cache", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider, two: { ...provider, compat: { reasoning: true, thinkingLevelMap: { xhigh: "high" } } } });
  await h.start();
  assert.equal(h.requests.length, 2);
  assert.equal((h.registrations.get("one")!.models?.[0] as { reasoning: boolean }).reasoning, false);
  assert.equal((h.registrations.get("two")!.models?.[0] as { reasoning: boolean }).reasoning, true);
  await h.configure({ one: { ...provider, compat: { reasoning: true } } });
  await h.start();
  assert.equal(h.requests.length, 3);
});

test("startup failure preserves fallback and other providers; failed refresh preserves last success", async (t) => {
  const h = await harness(t);
  await h.configure({ broken: { ...provider, apiKey: "$PI_DISCOVERY_DELIBERATELY_UNSET", models: [{ id: "fallback" }] }, healthy: provider });
  await h.start();
  const broken = h.registrations.get("broken")!;
  assert.equal(broken.models, undefined);
  assert.equal(await broken.refreshModels!(refreshContext(false)), undefined, "the cache-only step keeps the fallback");
  assert.equal(h.registrations.get("healthy")!.models?.[0].id, "model");
  assert.ok(h.notices.some((message) => message.includes("PI_DISCOVERY_DELIBERATELY_UNSET")));
  h.setStatus(503);
  await assert.rejects(() => h.registrations.get("healthy")!.refreshModels!(refreshContext(true, { force: true })), /HTTP 503/);
  await h.refresh();
  assert.equal(h.registrations.get("healthy")!.models?.[0].id, "model");
  assert.equal((await h.registrations.get("healthy")!.refreshModels!(refreshContext(false)))[0].id, "model");
});

test("cancelled refresh passes signal and does not overwrite the successful cache", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider });
  await h.start();
  const before = await h.cache();
  const abort = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.ok(init.signal);
    const response = new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    abort.abort(new Error("cancelled"));
    return response;
  });
  await assert.rejects(() => h.registrations.get("one")!.refreshModels!(refreshContext(true, { signal: abort.signal, force: true })), /cancelled/);
  assert.equal(await h.cache(), before);
});

test("malformed cache and BOM-prefixed line-comment config recover without altering models.json", async (t) => {
  const h = await harness(t);
  const config = '\uFEFF{ // provider\n "providers": { "one": {"baseUrl":"https://example.test/v1", "api":"openai-completions", "discoverModels":true,},},}';
  await writeFile(join(h.dir, "models.json"), config);
  await h.start();
  await writeFile(h.cachePath, "broken");
  await h.start();
  assert.equal(h.requests.length, 2);
  assert.ok(h.notices.some((message) => message.includes("Cannot read model cache")));
  assert.equal(await readFile(join(h.dir, "models.json"), "utf8"), config);
});

for (const flag of ["1", "true", "YES"]) {
  test(`offline startup (${flag}) preserves fallback without requesting a catalog`, async (t) => {
    const h = await harness(t);
    process.env.PI_OFFLINE = flag;
    await h.configure({ one: { ...provider, models: [{ id: "fallback" }] } });
    await h.start();
    assert.equal(h.requests.length, 0);
    assert.equal(h.registrations.get("one")!.models, undefined);
    assert.ok(h.notices.some((message) => message.includes("offline mode")));
    assert.equal(await h.registrations.get("one")!.refreshModels!(refreshContext(false)), undefined);
    assert.equal(h.requests.length, 0);
    await assert.rejects(() => h.cache(), { code: "ENOENT" });
  });
}

test("offline startup uses matching metadata cache without fetching", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider });
  await h.start();
  const original = h.registrations.get("one")!.models;
  process.env.PI_OFFLINE = "1";
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.registrations.get("one")!.models, original);
  assert.deepEqual(await h.registrations.get("one")!.refreshModels!(refreshContext(false)), original);
});

for (const kind of ["stale", "broken", "empty-models"] as const) {
  test(`offline startup ignores ${kind} cache without fetching or overwriting it`, async (t) => {
    const h = await harness(t);
    await h.configure({ one: provider });
    await h.start();
    if (kind === "stale") {
      await h.configure({ one: { ...provider, baseUrl: "https://changed.test/v1", models: [{ id: "fallback" }] } });
    } else if (kind === "broken") {
      await writeFile(h.cachePath, "broken JSON");
    } else {
      const cache = JSON.parse(await h.cache());
      cache.providers.one.models = [];
      await writeFile(h.cachePath, JSON.stringify(cache));
    }
    const before = await h.cache();
    process.env.PI_OFFLINE = "1";
    await h.start();
    assert.equal(h.requests.length, 1);
    assert.equal(h.registrations.get("one")!.models, undefined);
    assert.equal(await h.cache(), before);
    assert.ok(h.notices.some((message) => message.includes("offline mode")));
  });
}

test("manual refresh explicitly fetches in offline mode and populates a missing cache", async (t) => {
  const h = await harness(t);
  process.env.PI_OFFLINE = "1";
  await h.configure({ one: provider, two: provider });
  await h.start();
  assert.equal(h.requests.length, 0);
  await h.refresh();
  assert.equal(h.requests.length, 1, "identical providers share the manual request");
  assert.equal(h.registrations.get("one")!.models?.[0].id, "model");
  const cache = JSON.parse(await h.cache());
  assert.equal(cache.providers.two.models[0].id, "model");
  await h.start();
  assert.equal(h.requests.length, 1, "next offline startup uses the newly populated cache");
});

test("resolved credentials support escapes, missing or empty variables and command rejection", (t) => {
  process.env.PI_DISCOVERY_EMPTY = "";
  t.after(() => { delete process.env.PI_DISCOVERY_EMPTY; });
  assert.equal(resolveEnvValue("literal $$ $!"), "literal $ !");
  assert.equal(resolveEnvValue("${tenant-id}/${}/${1invalid}"), "${tenant-id}/${}/${1invalid}");
  assert.throws(() => resolveEnvValue("${PI_DISCOVERY_DELIBERATELY_UNSET}"), /not set/);
  assert.throws(() => resolveEnvValue("$PI_DISCOVERY_EMPTY"), /empty or not set/);
  assert.throws(() => resolveEnvValue("!echo token"), /does not execute/);
});

test("startup fetches uncached catalogs concurrently", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider, two: { ...provider, baseUrl: "https://other.test/v1" } });
  const answers: Array<() => void> = [];
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    answers.push(() => resolve(Response.json([{ id: "model" }])));
    // Answer only once both requests are in flight; serial fetching would time out instead.
    if (answers.length === 2) for (const answer of answers) answer();
  }));
  await h.start();
  assert.equal(h.registrations.get("one")!.models?.[0].id, "model");
  assert.equal(h.registrations.get("two")!.models?.[0].id, "model");
});

test("online refresh skips catalogs fetched in the last four hours unless forced", async (t) => {
  const h = await harness(t);
  await h.configure({ one: provider });
  await h.start();
  const refresh = (options: Partial<RefreshModelsContext> = {}) => h.registrations.get("one")!.refreshModels!(refreshContext(true, options));
  await refresh();
  assert.equal(h.requests.length, 1, "a cold start does not fetch twice");
  await refresh({ force: true });
  assert.equal(h.requests.length, 2);
  const cache = JSON.parse(await h.cache());
  cache.providers.one.fetchedAt = Date.now() - 5 * 60 * 60 * 1000;
  await writeFile(h.cachePath, JSON.stringify(cache));
  await h.start();
  assert.equal(h.requests.length, 2, "startup uses an old cache");
  await refresh();
  assert.equal(h.requests.length, 3, "online refresh replaces an old cache");
});

test("refreshes use Pi's API key, so !command keys are never run but still discover models", async (t) => {
  const h = await harness(t);
  await h.configure({ one: { ...provider, apiKey: "!must-not-execute", models: [{ id: "fallback" }] } });
  await h.start();
  assert.equal(h.requests.length, 0);
  assert.equal(h.registrations.get("one")!.models, undefined);
  assert.ok(h.notices.some((message) => message.includes("!command")));
  const refresh = h.registrations.get("one")!.refreshModels!;
  assert.equal(await refresh(refreshContext(false)), undefined);
  const models = await refresh(refreshContext(true, { credential: { type: "api_key", key: "from-pi" } }));
  assert.equal(models[0].id, "model");
  assert.equal(h.requests[0].headers.get("Authorization"), "Bearer from-pi");
  h.setPiKey("from-registry");
  await h.refresh();
  assert.equal(h.requests[1].headers.get("Authorization"), "Bearer from-registry");
  h.notices.length = 0;
  await h.start();
  assert.equal(h.requests.length, 2, "the cache verifies a !command key without running it");
  assert.equal(h.registrations.get("one")!.models?.[0].id, "model");
  assert.equal(h.notices.length, 0);
});

test("Pi's online refresh recovers from failed startup discovery", async (t) => {
  const h = await harness(t);
  await h.configure({ gateway: { ...provider, apiKey: "test-token", models: [{ id: "fallback" }] } });
  const runtime = await ModelRuntime.create({
    modelsPath: join(h.dir, "models.json"), authPath: join(h.dir, "auth.json"),
    modelsStorePath: join(h.dir, "models-store.json"), allowModelNetwork: false,
  });
  const pi = { ...h.pi, registerProvider: (id: string, config: ProviderConfig) => runtime.registerProvider(id, config) } as ExtensionAPI;
  h.setStatus(503);
  await extension(pi);
  assert.ok(runtime.getModel("gateway", "fallback"));
  h.setStatus(200);
  // Pi runs a cache-only step, then a network step with its resolved credential.
  const result = await runtime.refresh({ allowNetwork: true, providers: ["gateway"] });
  assert.deepEqual([...result.errors.keys()], []);
  assert.ok(runtime.getModel("gateway", "model"));
  assert.equal(runtime.getModel("gateway", "fallback"), undefined);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].headers.get("Authorization"), "Bearer test-token");
  await runtime.refresh({ allowNetwork: true, providers: ["gateway"] });
  assert.equal(h.requests.length, 2, "a fresh catalog is not fetched again");
});

test("real Pi runtime composes discovered models with auth, model overrides and static fallback", async (t) => {
  const h = await harness(t);
  await h.configure({
    discovered: { ...provider, name: "Gateway", apiKey: "test-token", headers: { "X-Test": "header" },
      modelOverrides: { model: { maxTokens: 4096, thinkingLevelMap: { max: null, medium: "high" } } } },
    broken: { ...provider, apiKey: "!unsupported", models: [{ id: "fallback" }] },
  });
  const runtime = await ModelRuntime.create({
    modelsPath: join(h.dir, "models.json"), authPath: join(h.dir, "auth.json"),
    modelsStorePath: join(h.dir, "models-store.json"), allowModelNetwork: false,
  });
  const pi = { ...h.pi, registerProvider: (id: string, config: ProviderConfig) => runtime.registerProvider(id, config) } as ExtensionAPI;
  h.setPayload([{ id: "model", reasoning: true, reasoning_levels: ["low", "high", "max"] }]);
  await extension(pi);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("discovered", "model")!;
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high"]);
  assert.equal(model.thinkingLevelMap?.medium, "high");
  assert.equal(runtime.getCompatibilityRequestConfig(model).headers?.["X-Test"], "header");
  assert.ok(await runtime.getAuth("discovered"));
  assert.ok(runtime.getModel("broken", "fallback"));
});

test("real HTTP catalog is discovered through the extension entry point", async (t) => {
  const h = await harness(t, false);
  let auth: string | undefined;
  const server = createServer((request, response) => {
    auth = request.headers.authorization;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "http-model", max_input_tokens: 64_000 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await h.configure({ local: { ...provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-key" } });
  await h.start();
  assert.equal(h.registrations.get("local")!.models?.[0].id, "http-model");
  assert.equal(auth, "Bearer local-key");
});
