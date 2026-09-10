#!/usr/bin/env bash
# HAL-ID: #HAL-20260910-2126-NH-D6
# Description: Self-test for claude-code-codex-bridge — offline by default; --live makes real calls on your ChatGPT subscription.
# Command: #HAL-20260910-2116-NH-SI  (read it FIRST — resolve: rg -l 'HAL-20260910-2116-NH-SI' ~/.claude/commands/)
#
# Usage:  bash selftest.sh          # unit tests + launcher dry-run, no network
#         bash selftest.sh --live   # + one text reply and one tool round-trip on gpt-6-astra
# Exit:   0 = all checks passed, non-zero = the first failing check
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LIVE=0; [ "${1:-}" = "--live" ] && LIVE=1
pass() { printf '  ✅ %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*" >&2; exit 1; }

echo "claude-code-codex-bridge self-test"
command -v bun >/dev/null 2>&1 || fail "bun not installed"
pass "bun $(bun --version)"

echo "• unit tests"
(cd "$DIR" && bun test >/tmp/ccb-selftest.log 2>&1) || { tail -20 /tmp/ccb-selftest.log; fail "bun test failed"; }
pass "$(grep -E '^ *[0-9]+ pass' /tmp/ccb-selftest.log | tr -s ' ')"

echo "• launcher dry-run (fresh HOME, fake Codex login, no claude needed)"
FAKE="$(mktemp -d)"
mkdir -p "$FAKE/codex" "$FAKE/bin"
printf '{"tokens":{"access_token":"x","account_id":"y"}}' >"$FAKE/codex/auth.json"
chmod 600 "$FAKE/codex/auth.json"
printf '#!/bin/sh\necho fake-claude "$@"\n' >"$FAKE/bin/claude"; chmod +x "$FAKE/bin/claude"
OUT="$(env -i HOME="$FAKE" PATH="$FAKE/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
	CODEX_HOME="$FAKE/codex" CCB_DRY_RUN=1 ANTHROPIC_API_KEY=should-be-removed \
	bash "$DIR/cc-astra" 2>/dev/null)" || fail "launcher dry-run exited non-zero"
echo "$OUT" | grep -q '^ANTHROPIC_BASE_URL=http://127.0.0.1:[0-9]*$' || fail "ANTHROPIC_BASE_URL not set to loopback"
echo "$OUT" | grep -q '^ANTHROPIC_AUTH_TOKEN=<token>$' || fail "ANTHROPIC_AUTH_TOKEN missing"
echo "$OUT" | grep -q '^ANTHROPIC_MODEL=gpt-6-astra$' || fail "ANTHROPIC_MODEL wrong"
echo "$OUT" | grep -q '^ANTHROPIC_API_KEY=' && fail "inherited ANTHROPIC_API_KEY leaked into the session"
pass "launcher sets the gateway env and scrubs inherited keys"
# The bridge must not outlive the launcher.
sleep 1
pgrep -f "CCB_PARENT_PID" >/dev/null 2>&1 && true
if pgrep -f "$DIR/src/bridge.ts" >/dev/null 2>&1; then
	sleep 3
	pgrep -f "$DIR/src/bridge.ts" >/dev/null 2>&1 && fail "a bridge process outlived its launcher"
fi
pass "no orphaned bridge after the launcher exited"
rm -rf "$FAKE"

if [ "$LIVE" = "1" ]; then
	echo "• live: text reply on ${CCB_MODEL:-gpt-6-astra} (uses your ChatGPT subscription quota)"
	R="$(bash "$DIR/cc-astra" -p "Reply with exactly the single word: pong" 2>/dev/null)" || fail "live call failed"
	echo "$R" | grep -qi 'pong' || { echo "$R"; fail "expected 'pong' in the reply"; }
	pass "text reply: $(echo "$R" | tr -d '\n' | cut -c1-60)"

	echo "• live: tool round-trip (Bash tool → result → final answer)"
	R="$(bash "$DIR/cc-astra" -p "Use the Bash tool to run exactly: echo ccb-tool-ok . Then reply with only the command's output." --allowedTools "Bash(echo:*)" 2>/dev/null)" || fail "live tool call failed"
	echo "$R" | grep -q 'ccb-tool-ok' || { echo "$R"; fail "tool result did not reach the final answer"; }
	pass "tool round-trip: $(echo "$R" | tr -d '\n' | cut -c1-60)"
fi
echo "all checks passed"
