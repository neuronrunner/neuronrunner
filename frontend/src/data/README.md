# MCP catalog

`connectors.json` contains 100 entries kept for provenance. The public directory exposes 37 remote integrations, with 12 marked as recommended; package-only stdio entries, placeholder-only endpoints, third-party gateways, and the built-in browser are hidden. This is a curated selection, not a measured global usage ranking: the official MCP Registry does not supply comparable per-server usage counts.

Server identifiers, versions, transports, package settings, and credential requirements come from the official MCP Registry (`source`) and publisher npm/PyPI metadata (`metadataSource` on supplemental entries). Supplemental npm entries use stable `npm/…` IDs; these do not imply registration in the official MCP Registry. Each entry links to its implementation's setup guide. Published logos and publisher avatars are bundled locally. A service logo identifies the integration, not an endorsement or an assertion that its MCP implementation is vendor maintained.

When updating the snapshot, preserve server IDs (installed connections use them), retain package versions and required arguments, and include a local logo plus its original `logoSource`. Run the catalog tests and browser checks after changing entries or categories.

Local launch corrections may supplement registry metadata with `additionalPackages` and `executable`. Docker MCP 0.2.4 needs the pinned `ajv@8.17.1` package alongside its published package to satisfy `ajv-formats` at startup. This does not provide a Docker daemon; Docker tools still require a Docker engine reachable from the workspace sandbox.

Codebase Memory MCP pins npm and PyPI to `0.12.1`. The publisher’s `0.12.0` installers reject their own native binary because it exceeds the archive member size limit; [release 0.12.1 fixes this](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1). Keep this correction when refreshing the registry snapshot.

ElevenLabs defaults to its official hosted OAuth MCP endpoint, `https://api.us.elevenlabs.io/v1/mcp`, verified against [the publisher’s MCP page](https://elevenlabs.io/mcp). The published `elevenlabs-mcp` Python package remains an optional legacy local method with a required API key. `ELEVENLABS_MCP_BASE_PATH` defaults to the workspace directory rather than a host Desktop folder.


The ChatGPT directory snapshot in `chatgpt-apps.json` retains provenance for the 40 matching entries within the 100-MCP catalog. Three skill-only plugins are excluded. Searches are not an account-independent global export; the snapshot states this scope explicitly. Existing server IDs and launch configurations remain intact.

`chatgptDirectory` identifies a service listed in ChatGPT, not a claim that the local MCP implementation has identical capabilities or authentication. Entries without a verified public connection use `availability: "provider-setup"` with empty transports. Their detail view links to the provider and offers adding a user-supplied endpoint; it never saves or activates a fabricated connection.
