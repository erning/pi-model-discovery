# pi-model-discovery

A small Pi extension that discovers chat models from compatible model catalogs. It reads providers marked with `"discoverModels": true` in `models.json` and registers their models before Pi selects a startup model.

Derived from [maplezzk/pi-extensions](https://github.com/maplezzk/pi-extensions/tree/main/packages/pi-models-discovery) at `c5cf4ab`, including the advertised metadata improvements from [PR #241](https://github.com/maplezzk/pi-extensions/pull/241) at `858660e`. This version keeps discovery, caching and refresh, with no configuration panel, translations, bundled skills or additional runtime dependencies.

## Install

Requires Node.js 22.19+; developed and tested against Pi 1.4.0.

From this directory:

```sh
pi install .
```

To try it for one invocation:

```sh
pi -e ./index.ts
```

Enable only one discovery extension for these providers. If the upstream extension is installed, disable it before loading this one.

## Configure

Add a provider to `~/.pi/agent/models.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

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

`baseUrl` and `api` are required. The catalog is fetched from `GET {baseUrl}/models`; trailing slashes are removed. Set `modelsUrl` to a complete URL when the catalog lives elsewhere. Both `{ "data": [{ "id": "model-id" }] }` and a top-level array are accepted. This extension treats catalog entries as chat models.

Discovery sends the provider's resolved headers and `Authorization: Bearer <apiKey>` when an API key is configured. `modelsUrl` receives the same credentials, so point it at a trusted endpoint. Unauthenticated discovery can omit `apiKey`; Pi may still require a dummy key to make a local model selectable.

Discovery supports literal credentials, `$NAME` / `${NAME}` interpolation, and `$$` / `$!` escapes. It does not execute `!command` credentials or read stored login credentials. Missing variables or unsupported credentials fail discovery with a warning. Pi continues to handle chat authentication normally.

The extension reads `models.json` without rewriting it. Line comments and trailing commas are supported. After editing discovery configuration, use `/reload` to load the changes.

## Cache and refresh

Successful discovery is saved to `<agent-dir>/cache/pi-model-discovery.json`. Subsequent startups with unchanged configuration register cached models without network requests. Endpoint, API, compatibility settings or resolved authentication changes invalidate the cache. Cache fingerprints are SHA-256 hashes; credentials are not stored in the cache.

Run this command to fetch fresh catalogs and update the cache:

```text
/model-discovery-refresh
```

Pi's online `refreshModels` hook also fetches a fresh catalog, honors cancellation and updates the cache. Offline refresh returns the last successful catalog. Discovery requests have a five-second timeout. Providers sharing a catalog URL, resolved headers and compatibility settings share one request during startup or a refresh command.

A failed initial discovery preserves handwritten `models` from `models.json`. A failed refresh keeps the last successful discovered list. One failing provider does not prevent the others from loading. The cache uses a separate location from upstream; the first startup of this extension fetches its own catalog.

## Advertised metadata

The first valid value in each row wins, following PR #241:

| Pi field | Catalog fields in precedence order |
| --- | --- |
| `name` | `name`, `display_name`, model ID |
| `contextWindow` | `context_window`, `contextWindow`, `max_model_len`, `context_length`, `max_context_length`, `max_input_tokens` |
| `maxTokens` | `max_tokens`, `maxTokens`, `max_output_tokens`, `max_completion_tokens` |
| Image input | Explicit `input` containing `text` and/or `image`, then `capabilities.vision`, then `capabilities.image_input` |
| `reasoning` | Provider `compat.reasoning`, model `reasoning`, `capabilities.reasoning`, `capabilities.thinking` |

Chat models always include text input. Capabilities accept booleans or objects such as `{ "supported": false }`; explicit `false` is preserved. Token limits must be positive safe integers. Invalid values fall through to the next alias.

Costs are prices per **one million tokens**, matching Pi:

| Pi cost field | Catalog fields in precedence order |
| --- | --- |
| `input` | `cost.input`, `pricing.input_per_million` |
| `output` | `cost.output`, `pricing.output_per_million` |
| `cacheRead` | `cost.cacheRead`, `cost.cache_read`, `pricing.cache_read_input_per_million` |
| `cacheWrite` | `cost.cacheWrite`, `cost.cache_write`, `pricing.cache_creation_input_per_million` |

Only finite, nonnegative numbers are accepted. Zero is valid. Other price units, pricing tiers and modality-specific prices are not converted.

When metadata is absent, upstream defaults apply: one million context tokens, 65,536 output tokens, text and image input, reasoning enabled and zero cost. Override these defaults when a catalog omits capabilities or limits.

Provider `compat` is forwarded to discovered models, with `supportsDeveloperRole: false` as the default. `compat.reasoning` and `compat.thinkingLevelMap` become top-level model fields. Extra thinking tiers `xhigh` and `max` default to `null`; enable them only when supported by the backend:

```json
{
  "compat": {
    "thinkingLevelMap": { "xhigh": "high", "max": "max" }
  },
  "modelOverrides": {
    "text-model": {
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  }
}
```

Use the fragment above inside a provider entry. Pi applies its normal `modelOverrides` layer to discovered models; provider names, authentication and chat headers also remain under Pi's control.

## Development

```sh
npm install --ignore-scripts
npm run check
npm pack --dry-run
```

Tests cover metadata aliases and validation, cached and offline startup, authentication, refresh and cancellation, failure fallback, composition with Pi's actual model runtime, and a local HTTP catalog. TypeScript loads directly through Pi; no build step is needed.

## License

MIT. Upstream copyright is preserved in [LICENSE](./LICENSE).
