# pi-model-discovery

Single-file Pi extension (`model-discovery.ts`) that discovers chat models from compatible model catalogs. It reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json` and registers their models before Pi selects a startup model.

Derived from [maplezzk/pi-extensions](https://github.com/maplezzk/pi-extensions/tree/main/packages/pi-models-discovery) (`c5cf4ab`) with the advertised metadata improvements from [PR #241](https://github.com/maplezzk/pi-extensions/pull/241) (`858660e`), simplified into a single self-contained file without the configuration panel or i18n.

## Install

Place `model-discovery.ts` in `~/.pi/agent/extensions/`:

```sh
# Option 1: symlink from a local clone
ln -s "$PWD/model-discovery.ts" ~/.pi/agent/extensions/model-discovery.ts

# Option 2: copy the file
cp model-discovery.ts ~/.pi/agent/extensions/

# Option 3: download directly from GitHub
curl -fsSL https://raw.githubusercontent.com/erning/pi-model-discovery/master/model-discovery.ts \
  -o ~/.pi/agent/extensions/model-discovery.ts
```

Or load it for a single run:

```sh
pi -e ./model-discovery.ts
```

If the upstream `pi-models-discovery` package is installed, disable or remove it first so the same providers are not registered twice.

## Configure

Add `"discoverModels": true` to a provider in `~/.pi/agent/models.json`:

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

- `baseUrl` and `api` are required.
- Discovery fetches `GET {baseUrl}/models` by default (trailing slashes stripped), or `modelsUrl` when set to a full URL.
- Both `{ "data": [{ "id": "model-id" }] }` and a top-level array are accepted.
- Discovery sends resolved `headers` and `Authorization: Bearer <apiKey>` when `apiKey` is set. Literal keys, `$NAME` / `${NAME}` interpolation, and `$$` / `$!` escapes are supported; `!command` credentials are not executed during discovery.
- After editing `models.json`, run `/reload` inside Pi.

## Cache and refresh

Discovered models are cached in `~/.pi/agent/cache/pi-model-discovery.json`. Subsequent startups with unchanged configuration load from cache without network requests. Endpoint, API, compatibility settings, or resolved credential changes invalidate the cache automatically.

To force a refresh and update the cache:

```text
/model-discovery-refresh
```

Opening `/model` also triggers Pi's `refreshModels` hook. If initial discovery fails, handwritten `models` in `models.json` are preserved as a fallback; if a refresh fails, the last successful model list is kept.

## Advertised metadata

The first valid value in each row wins:

| Pi field | Catalog fields in precedence order |
| --- | --- |
| `name` | `name`, `display_name`, model ID |
| `contextWindow` | `context_window`, `contextWindow`, `max_model_len`, `context_length`, `max_context_length`, `max_input_tokens` |
| `maxTokens` | `max_tokens`, `maxTokens`, `max_output_tokens`, `max_completion_tokens` |
| Image input | Explicit `input` containing `text` and/or `image`, then `capabilities.vision`, then `capabilities.image_input` |
| `reasoning` | Provider `compat.reasoning`, model `reasoning`, `capabilities.reasoning`, `capabilities.thinking` |
| `cost.input` | `cost.input`, `pricing.input_per_million` |
| `cost.output` | `cost.output`, `pricing.output_per_million` |
| `cost.cacheRead` | `cost.cacheRead`, `cost.cache_read`, `pricing.cache_read_input_per_million` |
| `cost.cacheWrite` | `cost.cacheWrite`, `cost.cache_write`, `pricing.cache_creation_input_per_million` |

Capabilities accept booleans or `{ "supported": boolean }` objects, and explicit `false` is preserved. When metadata is absent, models default to `contextWindow: 1_000_000`, `maxTokens: 65_536`, `input: ["text", "image"]`, `reasoning: true`, zero cost, `compat.supportsDeveloperRole: false`, and `thinkingLevelMap: { xhigh: null, max: null }`.

Provider-level `compat` is merged into discovered models (`compat.reasoning` and `compat.thinkingLevelMap` are lifted to model fields), and Pi's `modelOverrides` can override individual models by ID.

## License

[MIT](./LICENSE)
