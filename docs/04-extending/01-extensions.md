---
title: Extensions
description: Add apps, routes, runtimes and UI to NeuronRunner without forking the core.
---

NeuronRunner has a small extension system so a separate package can add features without patching the core. Without an extension, everything uses the self-hosted defaults: local Docker sandboxes and no plan limits.

## Backend plugins

Point `NEURONRUNNER_EXTENSION_PLUGIN` at a function that receives the registry:

```bash
NEURONRUNNER_EXTENSION_PLUGIN=my_extension.plugin:register
```

```python
# my_extension/plugin.py
def register(registry, settings):
    # Mount an extra Django app and its URLs
    registry.app.extra_installed_apps.append("my_extension")
    registry.app.extra_urlpatterns.append(("api/my-extension/", "my_extension.urls"))

    # Add a value to the public /config payload
    registry.app.extra_config_payload = lambda s: {"my_feature": True}
```

The plugin is loaded once while Django reads its settings, so it can also change settings through the `settings` dict. URL entries are expanded lazily after apps are loaded; an entry can be a `(prefix, "module.urls")` tuple, a callable that returns patterns, or a ready `path(...)`.

### Hook groups

| Group | Purpose |
| --- | --- |
| `registry.app` | Extra Django apps, URL patterns (root, sandbox, user, model), CORS and host settings, extra fields in config, user and admin payloads. |
| `registry.runtime` | Extra sandbox runtime providers, e.g. remote VMs instead of local Docker. |
| `registry.quota` | Workspace resolution, usage metering and quota checks. |

See `backend/core/extensions.py` for every hook and its default.

## Frontend extensions

The frontend imports its extension from the `@cloud` alias. By default this points to `frontend/src/extensions/noop`, which renders nothing. To build with your own extension, set `CLOUD_FRONTEND_DIR` to a folder whose `index.ts` exports a `NeuronRunnerFrontendExtension`:

```bash
CLOUD_FRONTEND_DIR=../my-extension/frontend npm run build
```

An extension can add routes, settings tabs, workspace toolbar actions and panels, and can hook into runtime selection and API error handling. The interface is in `frontend/src/extensions/types.ts`. Packages your extension imports are resolved from the core `frontend/node_modules`, so it does not need its own copy of React.

> [!NOTE]
> Extensions are a code-level integration. Keep them in step with the NeuronRunner version you build against; the interfaces may change between releases.
