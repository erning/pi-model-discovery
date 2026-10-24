# pi-model-discovery

Pi package with a single-file extension (`model-discovery.ts`) that discovers chat models from compatible model catalogs. It reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json` and registers their models before Pi selects a startup model.

Derived from [maplezzk/pi-extensions](https://github.com/maplezzk/pi-extensions/tree/main/packages/pi-models-discovery) (`c5cf4ab`) with the advertised metadata improvements from [PR #241](https://github.com/maplezzk/pi-extensions/pull/241) (`858660e`), simplified into a single self-contained file without the configuration panel or i18n.

## Install

Requires Pi 1.4.0 or later. Install from GitHub:

```sh
pi install git:github.com/erning/pi-model-discovery
```

Or install from a local clone:

```sh
pi install .
```

To try the local extension for a single run:

```sh
pi -e ./model-discovery.ts
```

If you previously copied or symlinked `model-discovery.ts` into `~/.pi/agent/extensions/`, remove that copy or symlink before using the package. Also disable or remove the upstream `pi-models-discovery` extension if installed, so the same providers are not registered twice.

## Update

For the GitHub installation:

```sh
pi update git:github.com/erning/pi-model-discovery
```

Without a tag or commit suffix, Pi follows the installed checkout's upstream branch (`master` for this repository). On update, it fetches that branch and compares its commit hash with the installed `HEAD`. If they differ, Pi updates the installed checkout. This does not depend on changing `package.json`'s `version`: a pushed commit on the tracked branch is enough. Run `/reload` in an active Pi session after updating.

Local-path installations use the working files directly; use `git pull` in the clone and `/reload` to load changes.

To pin a release after a tag exists, install `git:github.com/erning/pi-model-discovery@v1.0.0`. A pinned tag or commit stays on that ref; updates do not select a newer release automatically.

## Configure

Add `"discoverModels": true` to a provider in `<agent-dir>/models.json`. The agent directory defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it for both configuration and cache files:

```json
{
  "providers": {
    "gateway": {
      "name": "My Gateway",
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$GATEWAY_API_KEY",
      "discoverModels": true
    }
  }
}
```

- `baseUrl` and `api` must be nonempty strings. Use an API supported by Pi, such as `openai-completions`.
- Discovery fetches `GET {baseUrl}/models` by default (trailing slashes stripped). A nonempty string `modelsUrl` is used as-is instead; supply a complete URL. An empty or non-string `modelsUrl` uses the default endpoint. Requests time out after five seconds.
- Both `{ "data": [{ "id": "model-id" }] }` and a top-level array are accepted. Entries without a nonblank string `id` are skipped; a response with no valid entries fails discovery. All accepted entries are registered as chat models.
- Catalog requests send the provider's `headers`. An API key sets `Authorization: Bearer <apiKey>`, replacing any configured Authorization header; without one, a configured Authorization header is sent unchanged. The same credentials are sent to `modelsUrl` when configured. Bearer is the only scheme derived from the key: a catalog that authenticates differently, such as Anthropic's `/v1/models` with `x-api-key` and `anthropic-version`, needs those headers in `headers`.
- Startup discovery resolves `apiKey` and header values itself. They support literals, `$NAME` / `${NAME}` interpolation, and `$$` / `$!` escapes; missing or empty environment variables fail discovery. Startup never runs `!command` values: a provider whose `apiKey` is a `!command` keeps its fallback models until Pi's model refresh or `/model-discovery-refresh` discovers them. Those refreshes authenticate with Pi's effective API key for the provider, the same key used for chat, so `!command` keys and keys saved with `/login` work there. Header values never run `!command`.
- Unauthenticated catalogs can omit `apiKey`, though Pi may still require a dummy key to make a local model selectable. Pi's background refresh also runs only for providers with a key.
- The extension reads but does not rewrite `models.json`; BOM, `//` comments, and trailing commas are supported. After editing discovery configuration, run `/reload`. The manual refresh command uses the configuration captured when the extension loaded.

## Cache and refresh

Discovered models are cached per provider ID in `<agent-dir>/cache/pi-model-discovery.json`, together with the time they were fetched. At startup, a cache entry with a matching fingerprint is loaded without a catalog request. Providers without one are fetched concurrently, before Pi selects a startup model. The fingerprint includes `baseUrl`, API type, `modelsUrl`, resolved header values, the resolved `apiKey` (for a `!command` key, its text), provider `compat`, and the extension's model format version. Changes to those values invalidate the cache; changing only a provider's name or `modelOverrides` does not. Environment variables in those values must still resolve to verify the fingerprint, even when offline.

`pi --list-models` (including `pi --list-models <search>`) refreshes discovery catalogs before listing models whenever networking is allowed, regardless of cache age. Successful requests update the cache; failed requests retain the last matching cached models. `--offline` or `PI_OFFLINE=1` keeps listing cache-only. Providers using `!command` API keys retain the startup behavior described above: listing does not execute those commands and uses matching cached models when available.

Pi also refreshes model catalogs itself: in the background after interactive or RPC startup, and when `/model` or the scoped model selector needs fresh catalogs. Each refresh calls the provider's `refreshModels` hook twice:

- First with `allowNetwork: false`, which returns the cached models, or leaves the current models unchanged when there are none. Handwritten fallback models therefore stay until discovery succeeds.
- Then with `allowNetwork: true`, unless Pi is offline or has no key for the provider. This step fetches the catalog only when the last successful fetch is more than four hours old, matching Pi's built-in catalogs, or when the caller forces a refresh.

A provider whose startup discovery failed is therefore discovered by Pi's next background refresh, and server-side catalog changes appear at the first interactive start after the cache is four hours old. To fetch every catalog now and update the cache, including in offline mode:

```text
/model-discovery-refresh
```

During one startup or manual refresh, providers sharing the same catalog URL, resolved headers and `compat` share a request.

With `pi --offline` or `PI_OFFLINE=1` (also `true` / `yes`), startup never requests the model catalog. It uses a matching cache if available; otherwise it keeps handwritten `models` as a fallback and warns. A missing, invalid, or outdated cache does not trigger a network request in offline mode.

A catalog fetch or parsing failure during a refresh keeps the last successful list. Cache-write failures produce a warning without discarding the fetched models.

## Advertised metadata

The table lists source precedence. Scalar fields use the first valid value; `input` is derived from the first usable source as described below.

| Pi field | Catalog fields in precedence order |
| --- | --- |
| `name` | `name`, `display_name`, model ID |
| `contextWindow` | `context_window`, `contextWindow`, `max_model_len`, `context_length`, `max_context_length`, `max_input_tokens` |
| `maxTokens` | `max_tokens`, `maxTokens`, `max_output_tokens`, `max_completion_tokens` |
| `input` | Provider `compat.input`, then the first usable list of `input`, `modalities.input`, `architecture.input_modalities`, then `capabilities.vision`, then `capabilities.image_input` |
| `reasoning` | Provider `compat.reasoning`, model `reasoning`, `capabilities.reasoning`, `capabilities.thinking` |
| `thinkingLevelMap` | Provider `compat.thinkingLevelMap` entries, model `thinkingLevelMap` entries, then the first usable list of `reasoning_levels` or `supported_reasoning_levels[].effort` |
| `cost.input` | `cost.input`, `pricing.input_per_million` |
| `cost.output` | `cost.output`, `pricing.output_per_million` |
| `cost.cacheRead` | `cost.cacheRead`, `cost.cache_read`, `pricing.cache_read_input_per_million` |
| `cost.cacheWrite` | `cost.cacheWrite`, `cost.cache_write`, `pricing.cache_creation_input_per_million` |

Catalogs list input modalities in different places: a top-level `input` array, `modalities.input` (Vercel's AI Gateway, magpie), or `architecture.input_modalities` (OpenRouter). A list is usable if it is an array containing at least one of the exact strings `text` or `image`; the first usable one, in that order, decides, and enables image input only if it contains `image`. Missing, non-array, empty, or unsupported-only lists such as `["audio"]` fall through to the next one, then to `capabilities.vision`, then `capabilities.image_input`. A valid `vision: false` wins over `image_input: true`. The result always includes `text`; image support produces `["text", "image"]`, and explicit lack of image support produces `["text"]`. If no source is usable, the default is `["text"]`.

Provider `compat.input` takes a list in the same form and applies it to every discovered model, ahead of what the catalog says. It is for gateways that accept images for models whose catalog entries are text-only. For example, magpie with Image recognition on describes images to models that cannot see them, but its `/v1/models` lists only each model's own modalities:

```json
"magpie": {
  "baseUrl": "http://127.0.0.1:3425/v1",
  "api": "openai-completions",
  "apiKey": "magpie",
  "discoverModels": true,
  "compat": { "input": ["text", "image"] }
}
```

Model `reasoning` and fields under `capabilities` accept booleans or objects with a boolean `supported` property. Provider `compat.reasoning` accepts only a boolean; an object there is ignored. Explicit `false` is preserved and takes precedence over lower-priority sources.

Thinking levels come from `reasoning_levels` (an array of strings), or from `supported_reasoning_levels` (an array of objects with an `effort` string) when the first list is unusable. A list is usable if it contains at least one recognized value: `off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Listed levels map to their own API values; `none` maps Pi's `off` level to the API value `none`. Unlisted levels are set to `null`, so Pi hides them and skips them when cycling. For example, K3.1 Pro's `["low", "high", "max"]` exposes exactly those three levels. Empty, malformed, or unrecognized-only lists retain the defaults below. Lists do not enable reasoning on their own; `reasoning` still controls whether thinking is available.

A model-level `thinkingLevelMap` overrides the list per entry and is also preserved when loading cached models. Recognized Pi keys accept nonblank strings or `null`; invalid entries are ignored. Provider `compat.thinkingLevelMap` entries override the resulting model mapping.

Names must be nonblank strings. Token limits must be positive safe integers; numeric strings, fractions, zero, and negative values are ignored. Costs must be finite, nonnegative numbers in **price per one million tokens**. Zero is valid; numeric strings and prices in other units are not converted. Invalid values fall through to the next alias, then to the default.

When no valid metadata or provider override supplies a value, models use the defaults Pi applies to handwritten `models.json` models: `contextWindow: 128_000`, `maxTokens: 16_384`, `input: ["text"]`, `reasoning: false`, and zero cost. Discovered models also default to `compat.supportsDeveloperRole: false` and, without usable thinking metadata, `thinkingLevelMap: { xhigh: null, max: null }`. A catalog that lists only model IDs, such as OpenAI's, therefore yields conservative text-only models; enable images or reasoning for a whole provider with `compat.input` or `compat.reasoning`, and adjust individual models with `modelOverrides`. Token limits are selected independently; `maxTokens` is not clamped to `contextWindow`, but Pi limits each request's output to the remaining context window.

Provider-level `compat` overrides the default compatibility flags on discovered models. Its `input`, `reasoning` and `thinkingLevelMap` fields are extracted into model-level fields; `thinkingLevelMap` entries override the discovered mapping and default `xhigh` / `max` values. Pi applies `modelOverrides` by model ID after discovery, so these explicit user overrides take precedence over the discovered metadata.

## Tests

Requires Node.js 22.19 or later. Install development dependencies and run:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover advertised metadata and defaults, authentication with configured and Pi-resolved keys, cache reuse and invalidation, concurrent startup, the refresh interval, offline startup, manual refresh, cancellation, failure fallback and recovery through Pi's model runtime refresh, and a local HTTP catalog. They use temporary agent directories and do not modify your Pi configuration or contact external model services. Test dependencies are for local development; the installed extension still runs from one TypeScript file using Pi's own APIs.

## License

[MIT](./LICENSE)
