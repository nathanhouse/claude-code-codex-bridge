# claude-code-codex-bridge

Run **Claude Code** on **GPT-6 Astra** (or any model your ChatGPT plan gives Codex), billed to your
**ChatGPT subscription** — not a per-token API key.

It is a small localhost bridge: Anthropic Messages API in (what Claude Code speaks), OpenAI
Responses API out (what the Codex backend speaks), authenticated with the login your **Codex CLI**
already holds. Same Claude Code — your skills, `CLAUDE.md`, subagents, tools — different brain.

```
claude ──► http://127.0.0.1:PORT (this bridge) ──► chatgpt.com/backend-api/codex
           per-session token                       your Codex CLI login
```

## Why this and not a router app

Router/proxy apps hold every prompt and every credential you give them. Source audits of two popular
ones found plaintext credential storage and disabled TLS verification. This bridge is built so there
is nothing to trust:

- **No API key. No token storage.** It reads `~/.codex/auth.json` (Codex CLI's own file) and never writes it.
- **127.0.0.1 only**, and every request needs a random per-session token — other local processes can't ride your session.
- **No dashboard, no tunnel, no root certificate, no telemetry, no dependencies.** Two source files and a Bun runtime.
- **Honest identity.** It tells OpenAI it is `claude-code-codex-bridge`. It does not impersonate Codex CLI.
- **Nothing is ever logged** except event *types* (and only with `CCB_DEBUG=1`). Tokens never appear in errors.
- **Only one upstream host.** Headers from Claude Code are never relayed; only six fixed headers go out.

Read it in an afternoon: `src/sse.ts` (SSE decoder), `src/translate.ts` (the mapping), `src/bridge.ts` (the server).

## Requirements

- [Bun](https://bun.sh) ≥ 1.2
- [Codex CLI](https://github.com/openai/codex) logged in with **ChatGPT Plus or Pro** (`codex login`). Free plans authenticate but the model call fails.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Install

```bash
git clone https://github.com/nathanhouse/claude-code-codex-bridge.git ~/claude-code-codex-bridge
ln -s ~/claude-code-codex-bridge/cc-astra ~/.local/bin/cc-astra   # or any dir on your PATH
```

## Run

```bash
cc-astra                       # interactive Claude Code on gpt-6-astra
cc-astra -p "explain this repo" # one-shot
CCB_MODEL=gpt-5.6-terra cc-astra
```

Your normal `claude` command is untouched and still uses Anthropic. One provider per session: the
bridge is bound at launch; start a new session to go back.

| Env | Default | Meaning |
|---|---|---|
| `CCB_MODEL` | `gpt-6-astra` | model for Opus/Sonnet-class requests |
| `CCB_SMALL_MODEL` | `gpt-5.6-luna` | model for Haiku-class requests (titles, summaries, subagents) — the cheap tier, to protect the Astra window |
| `CCB_CONTEXT_TOKENS` | `272000` | the context window Claude Code should assume (it guesses 200K for unknown model ids; the Codex backend lists these models at 272K) |
| `CODEX_HOME` | `~/.codex` | where Codex CLI keeps `auth.json` |
| `CCB_DEBUG` | unset | `1` logs upstream event types to stderr (never bodies) |

Three harmless notices to expect from Claude Code: "not a model this version of Claude Code
recognizes" and "claude.ai connectors are disabled" on launch, and on exit "gpt-6-astra isn't
described by this version's model catalog… auto-compact keeps this session within…". The first two
are cosmetic. The third is Claude Code saying it had to *assume* a context window — the launcher
sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the real one (272K), which is the remedy the notice asks
for; it keeps printing the catalog part regardless.

## Usage and limits

The backend reports your subscription usage on every reply (`x-codex-*` headers). The bridge
keeps the latest reading:

- `cc-astra` prints one line when the session ends — e.g. `ChatGPT pro usage: 7% of the 1-week window (resets in 4d 3h)`.
- It warns on stderr the first time you cross **80%** and **95%**.
- `bun run src/usage.ts` (or `--json`) checks without starting a session — it costs one minimal
  completion (a few tokens), because only real completions carry the headers.
- `GET http://127.0.0.1:PORT/usage` (with the session token) while the bridge is running.
- Set `CCB_USAGE_FILE=/path/to/usage.json` and the bridge writes the latest reading there
  (atomically, numbers only, mode 0600) so a dashboard can show it without spending anything.

When the limit is hit the backend answers 429; the bridge passes on `retry-after` and the reset time.

## Verify it

```bash
bash selftest.sh          # unit tests + launcher dry-run on a simulated clean machine; no network
bash selftest.sh --live   # + one text reply and one tool round-trip on your subscription
```

## What it does and doesn't do

- **Does:** streaming, tool use (parallel calls included), tool results, images in user turns (base64
  JPEG/PNG/GIF/WebP), thinking → `reasoning`, usage accounting (cached tokens mapped so Claude Code's
  context tracking works), refusals, clean errors on every failure path.
- **Doesn't:** enforce `max_tokens` (the Codex backend rejects an output ceiling — you get
  `stop_reason: "max_tokens"` only when the backend stops itself); relay images inside tool results
  (`[image omitted]`); refresh the login (the token lives ~10 days and Codex CLI refreshes it whenever
  you use Codex — if you see *"Run: codex login"*, run it); `/v1/messages/count_tokens` is a deliberate
  over-estimate.

## The honest caveats

- **OpenAI does not officially support relaying a ChatGPT subscription through a non-OpenAI client.**
  This is personal, local use. Consider running it on a **separate ChatGPT account** from the one your
  work lives on.
- The Codex backend endpoint is **undocumented** and can change any week. The self-test tells you the
  moment it does.
- GPT-6 Astra is a frontier model: on a Plus plan you will hit the 5-hour window faster than you expect.
  `CCB_SMALL_MODEL` helps.

## Licence

MIT — Nathan House.
