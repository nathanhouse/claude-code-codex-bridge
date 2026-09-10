# claude-code-codex-bridge

Run Claude Code on GPT-6 Astra (or any Codex-available model) billed to your ChatGPT
subscription. A ~single-file localhost bridge: Anthropic Messages API in, OpenAI Responses
API out, using the login your Codex CLI already holds.

- No API key. No token storage. No dashboard. No tunnel. No root certificate. No telemetry.
- Binds to 127.0.0.1 only. Tells OpenAI honestly who it is.
- Zero dependencies (Bun).

**Status: in development — not yet usable.**

Requires: [Bun](https://bun.sh), [Codex CLI](https://github.com/openai/codex) logged in
with a ChatGPT Plus/Pro account, Claude Code.

> Relaying a ChatGPT subscription through a non-OpenAI client is not officially supported by
> OpenAI. Personal, local use only. Consider a separate ChatGPT account.
