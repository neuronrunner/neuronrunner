# Changelog

All notable changes to NeuronRunner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added
- Initial open-source release of NeuronRunner under the GNU Affero General Public License v3.0 (AGPL-3.0).
- Isolated local Docker sandbox runtime per workspace with persistent `/workspace` mounts, resource/PID limits, and encrypted workspace secret injection.
- Interactive browser PTY terminal over Django Channels WebSockets with one-time signed tickets.
- Isolated-origin local HTTP port preview proxy (`python manage.py run_preview_proxy`).
- Multi-model streaming LLM chat with tool calling, reasoning tiers, attachments, and persistent agent memory/notes.
- BYOK (Bring Your Own Key) workspace provider routing and OpenAI-compatible `/v1/chat/completions` gateway.
- Model Context Protocol (MCP) connector management and OAuth support.
- Integrated Git & GitHub Pull Request studio, file explorer, and code/document editors.
- Self-hosting Docker Compose stack (`docker-compose.yml` + `Dockerfile.sandbox`) and GitHub Actions CI.
