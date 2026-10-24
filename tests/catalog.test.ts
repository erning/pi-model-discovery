import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { buildModel, canonicalizeModel, parseModels } from "../model-discovery.ts";

// Metadata aliases and precedence from upstream PR #241 (858660e).
test("token limits accept the first valid alias", () => {
  const models = parseModels([
    { id: "gateway", context_length: 1_050_000, max_context_length: 2_000_000, max_output_tokens: 128_000, max_completion_tokens: 4096 },
    { id: "anthropic", max_input_tokens: 200_000, max_tokens: 32_000 },
    { id: "groq", context_window: 131_072, max_completion_tokens: 32_768 },
    { id: "mistral", max_context_length: 32_768, max_input_tokens: 64_000 },
    { id: "snake", context_window: 128_000, context_length: 256_000, max_tokens: 4096, max_output_tokens: 8192 },
    { id: "camel", contextWindow: 64_000, context_length: 256_000, maxTokens: 2048, max_output_tokens: 8192 },
    { id: "vllm", max_model_len: 48_000, context_length: 256_000, max_output_tokens: 1024 },
    { id: "invalid", context_window: 0, contextWindow: -1, max_model_len: "broken", context_length: 256_000,
      max_tokens: -1, maxTokens: "broken", max_output_tokens: 8192 },
    { id: "defaults", context_length: 1.5, max_input_tokens: null, max_output_tokens: 0 },
  ]);
  assert.deepEqual(models.map((m) => [m.id, m.contextWindow, m.maxTokens]), [
    ["gateway", 1_050_000, 128_000], ["anthropic", 200_000, 32_000], ["groq", 131_072, 32_768],
    ["mistral", 32_768, 16_384], ["snake", 128_000, 4096], ["camel", 64_000, 2048],
    ["vllm", 48_000, 1024], ["invalid", 256_000, 8192], ["defaults", 128_000, 16_384],
  ]);
});

test("names and capabilities preserve explicit false", () => {
  const models = parseModels({ data: [
    { id: "text", name: "Named", display_name: "Other", capabilities: { vision: false, reasoning: false } },
    { id: "anthropic", display_name: "Anthropic", capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
    { id: "disabled", name: 123, display_name: "Valid", capabilities: { image_input: { supported: false }, thinking: { supported: false } } },
    { id: "explicit", input: ["text"], reasoning: false, capabilities: { vision: true, thinking: { supported: true } } },
    { id: "image-only", input: ["image", "audio"], capabilities: { vision: false } },
    { id: "unknown", name: " " },
  ] });
  assert.deepEqual(models.map((m) => [m.name, m.input, m.reasoning]), [
    ["Named", ["text"], false], ["Anthropic", ["text", "image"], true], ["Valid", ["text"], false],
    ["explicit", ["text"], false], ["image-only", ["text", "image"], false], ["unknown", ["text"], false],
  ]);
});

test("input uses the first usable source and always retains text", () => {
  const cases = [
    { id: "empty", input: [], capabilities: { vision: true } },
    { id: "unsupported", input: ["audio"], capabilities: { image_input: { supported: true } } },
    { id: "non-array", input: "text", capabilities: { vision: true } },
    { id: "vision-first", capabilities: { vision: false, image_input: true } },
    { id: "invalid-vision", capabilities: { vision: { supported: "false" }, image_input: true } },
    { id: "explicit-text", input: ["audio", "text"], capabilities: { vision: true } },
    { id: "explicit-image", input: ["image"], capabilities: { vision: false } },
    { id: "no-usable-source", input: ["audio"], capabilities: { vision: "true" } },
    { id: "modalities", modalities: { input: ["text", "image", "pdf"], output: ["text"] }, capabilities: { vision: false } },
    { id: "modalities-text", modalities: { input: ["text"] }, capabilities: { vision: true } },
    { id: "openrouter", architecture: { input_modalities: ["image", "text"] } },
    { id: "input-first", input: ["text"], modalities: { input: ["text", "image"] } },
    { id: "modalities-first", modalities: { input: ["text"] }, architecture: { input_modalities: ["text", "image"] } },
    { id: "unusable-modalities", modalities: { input: ["audio"] }, architecture: { input_modalities: ["text", "image"] } },
  ];
  assert.deepEqual(parseModels(cases).map((m) => [m.id, m.input]), [
    ["empty", ["text", "image"]], ["unsupported", ["text", "image"]], ["non-array", ["text", "image"]],
    ["vision-first", ["text"]], ["invalid-vision", ["text", "image"]], ["explicit-text", ["text"]],
    ["explicit-image", ["text", "image"]], ["no-usable-source", ["text"]],
    ["modalities", ["text", "image"]], ["modalities-text", ["text"]], ["openrouter", ["text", "image"]],
    ["input-first", ["text"]], ["modalities-first", ["text"]], ["unusable-modalities", ["text", "image"]],
  ]);
});

test("provider compat.input overrides advertised input, as for a magpie gateway", () => {
  // Shaped like magpie's /v1/models: k3 sees images itself; magpie describes images to glm-5.3.
  const magpie = [
    { id: "kimi-code-cn/k3", display_name: "K3", context_window: 1_000_000, max_output_tokens: 128_000, reasoning: true,
      modalities: { input: ["text", "image", "video"], output: ["text"] } },
    { id: "zhipu/glm-5.3", display_name: "GLM-5.3", reasoning: true, modalities: { input: ["text"], output: ["text"] } },
  ];
  assert.deepEqual(parseModels(magpie).map((m) => m.input), [["text", "image"], ["text"]]);
  const described = parseModels(magpie, { input: ["text", "image"] });
  assert.deepEqual(described.map((m) => m.input), [["text", "image"], ["text", "image"]]);
  assert.equal("input" in described[0].compat!, false);
  assert.deepEqual(parseModels(magpie, { input: ["text"] }).map((m) => m.input), [["text"], ["text"]]);
  assert.deepEqual(parseModels(magpie, { input: "image" }).map((m) => m.input), [["text", "image"], ["text"]]);
});

test("model reasoning accepts supported objects but provider reasoning requires a boolean", () => {
  const entries = [
    { id: "model-first", reasoning: { supported: false }, capabilities: { reasoning: true } },
    { id: "capability-first", reasoning: "true", capabilities: { reasoning: false, thinking: true } },
    { id: "thinking", capabilities: { reasoning: null, thinking: { supported: true } } },
  ];
  assert.deepEqual(parseModels(entries).map((m) => m.reasoning), [false, false, true]);
  assert.deepEqual(parseModels(entries, { reasoning: { supported: true } }).map((m) => m.reasoning), [false, false, true]);
  assert.deepEqual(parseModels(entries, { reasoning: true }).map((m) => m.reasoning), [true, true, true]);
  const advertised = [{ id: "model", reasoning: true, reasoning_levels: ["low", "high", "max"] }];
  assert.equal(parseModels(advertised, { reasoning: false })[0].reasoning, false);
});

test("advertised thinking levels expose max and hide unlisted levels in Pi", () => {
  const levels = ["low", "high", "max"];
  const models = parseModels([
    { id: "kimi-code-cn/k3.1-pro", reasoning: true, reasoning_levels: levels,
      supported_reasoning_levels: levels.map((effort) => ({ effort })) },
    { id: "kimi-code-cn/k3.1-pro-highspeed", reasoning: true,
      supported_reasoning_levels: levels.map((effort) => ({ effort })) },
  ]);
  for (const model of models) {
    assert.deepEqual(model.thinkingLevelMap, {
      off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.deepEqual(getSupportedThinkingLevels(model as Model<Api>), levels);
  }
  assert.deepEqual(parseModels(JSON.parse(JSON.stringify(models))), models, "normalized mappings survive cache parsing");
});

test("thinking lists use the first usable source and normalize none to off", () => {
  const models = parseModels([
    { id: "flat-first", reasoning_levels: ["low", "max"], supported_reasoning_levels: [{ effort: "high" }] },
    { id: "empty", reasoning_levels: [], supported_reasoning_levels: [{ effort: "xhigh" }] },
    { id: "invalid", reasoning_levels: "high", supported_reasoning_levels: [{ effort: "high" }] },
    { id: "unknown", reasoning_levels: [null, {}, 1, "unknown", "MAX"],
      supported_reasoning_levels: [null, {}, { effort: 1 }, { effort: "max" }] },
    { id: "off", reasoning_levels: ["none", "low", "high", "high"] },
    { id: "explicit-off", reasoning_levels: ["none", "off", "medium"] },
  ].map((model) => ({ ...model, reasoning: true })));
  assert.deepEqual(models.map((model) => getSupportedThinkingLevels(model as Model<Api>)), [
    ["low", "max"], ["xhigh"], ["high"], ["max"], ["off", "low", "high"], ["off", "medium"],
  ]);
  assert.equal(models[4].thinkingLevelMap?.off, "none");
  assert.equal(models[5].thinkingLevelMap?.off, "off");
  for (const raw of [
    {}, { reasoning_levels: [] }, { reasoning_levels: ["unknown", 42] },
    { supported_reasoning_levels: [] }, { supported_reasoning_levels: ["max", null, { effort: false }] },
    { reasoning_levels: {}, supported_reasoning_levels: "high" },
  ]) {
    const [model] = parseModels([{ id: "fallback", reasoning: true, ...raw }]);
    assert.deepEqual(model.thinkingLevelMap, { xhigh: null, max: null });
    assert.deepEqual(getSupportedThinkingLevels(model as Model<Api>), ["off", "minimal", "low", "medium", "high"]);
  }
});

test("explicit model mappings override lists and provider mappings override model mappings", () => {
  const raw = [{ id: "model", reasoning: true, reasoning_levels: ["low", "high", "max"],
    thinkingLevelMap: { low: null, medium: "balanced", max: "maximum", high: false, xhigh: " ", invalid: "max" } }];
  const [model] = parseModels(raw);
  assert.deepEqual(model.thinkingLevelMap, {
    off: null, minimal: null, low: null, medium: "balanced", high: "high", xhigh: null, max: "maximum",
  });
  const [overridden] = parseModels(raw, { thinkingLevelMap: { max: null, xhigh: "maximum" } });
  assert.deepEqual(overridden.thinkingLevelMap, { ...model.thinkingLevelMap, max: null, xhigh: "maximum" });
  assert.equal("thinkingLevelMap" in overridden.compat!, false);
  assert.deepEqual(parseModels([{ id: "explicit-only", thinkingLevelMap: { max: "max", low: null } }])[0].thinkingLevelMap,
    { xhigh: null, max: "max", low: null });
  assert.deepEqual(parseModels([{ id: "invalid", thinkingLevelMap: { max: 42, xhigh: "", high: [] } }])[0].thinkingLevelMap,
    { xhigh: null, max: null });
});

test("costs use finite nonnegative prices per million with explicit costs first", () => {
  const models = parseModels([
    { id: "priced", pricing: { input_per_million: 1.36, output_per_million: 6.8, cache_read_input_per_million: 0.068, cache_creation_input_per_million: 1.7 } },
    { id: "explicit", cost: { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, pricing: { input_per_million: 3, output_per_million: 4 } },
    { id: "snake", cost: { input: -1, cache_read: 0.3, cache_write: 0.4 }, pricing: { input_per_million: 1, output_per_million: 2 } },
    { id: "invalid", cost: { input: Infinity, output: NaN }, pricing: { input_per_million: -1, output_per_million: "broken", prompt: "0.000001" } },
  ]);
  assert.deepEqual(models.map((m) => m.cost), [
    { input: 1.36, output: 6.8, cacheRead: 0.068, cacheWrite: 1.7 },
    { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test("defaults match Pi's models.json; provider overrides win and extra thinking tiers require opt-in", () => {
  const plain = buildModel({ id: "model" });
  assert.deepEqual([plain.contextWindow, plain.maxTokens, plain.input, plain.reasoning], [128_000, 16_384, ["text"], false]);
  assert.deepEqual(plain.thinkingLevelMap, { xhigh: null, max: null });
  const overridden = buildModel({ id: "model", reasoning: false }, {
    reasoning: true, thinkingLevelMap: { xhigh: "high" }, supportsDeveloperRole: true, supportsReasoningEffort: false,
  });
  assert.equal(overridden.reasoning, true);
  assert.deepEqual(overridden.thinkingLevelMap, { xhigh: "high", max: null });
  assert.deepEqual(overridden.compat, { supportsDeveloperRole: true, supportsReasoningEffort: false });
});

test("malformed catalogs and entries do not register empty catalogs", () => {
  for (const payload of [null, {}, { data: "bad" }, [], [null, {}, { id: " " }, { id: 1 }]]) {
    assert.throws(() => parseModels(payload), /no valid model IDs/);
  }
  assert.deepEqual(parseModels([null, { id: "valid" }]).map((m) => m.id), ["valid"]);
  assert.equal(canonicalizeModel(false), undefined);
});
