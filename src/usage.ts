// HAL-ID: #HAL-20260911-2128-NH-US
// Description: Subscription usage as reported by the Codex backend's x-codex-* response headers — parse, format, and a minimal-cost CLI check.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageWindow {
	usedPercent: number;
	windowMinutes: number;
	resetAfterSeconds: number;
	resetAt: number | null; // unix seconds
}

export interface CodexUsage {
	plan: string;
	activeLimit: string;
	primary: UsageWindow;
	secondary: UsageWindow | null;
	creditsBalance: number | null;
	observedAt: number; // unix ms
}

function num(headers: Headers, name: string): number | null {
	const v = headers.get(name);
	if (v === null || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function window(headers: Headers, prefix: string): UsageWindow | null {
	const windowMinutes = num(headers, `${prefix}-window-minutes`) ?? 0;
	if (windowMinutes <= 0) return null; // window 0 = this limit is not in force for the plan
	return {
		usedPercent: num(headers, `${prefix}-used-percent`) ?? 0,
		windowMinutes,
		resetAfterSeconds: num(headers, `${prefix}-reset-after-seconds`) ?? 0,
		resetAt: num(headers, `${prefix}-reset-at`),
	};
}

/** Null when the response carries no usage headers (only real completions carry them — errors and /models don't). */
export function parseCodexUsage(headers: Headers, now = Date.now()): CodexUsage | null {
	const primary = window(headers, "x-codex-primary");
	if (!primary) return null;
	return {
		plan: headers.get("x-codex-plan-type") ?? "unknown",
		activeLimit: headers.get("x-codex-active-limit") ?? "",
		primary,
		secondary: window(headers, "x-codex-secondary"),
		creditsBalance: num(headers, "x-codex-credits-balance"),
		observedAt: now,
	};
}

function humanDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	return `${m}m`;
}

function windowName(w: UsageWindow): string {
	if (w.windowMinutes % 10080 === 0) return `${w.windowMinutes / 10080}-week`;
	if (w.windowMinutes % 1440 === 0) return `${w.windowMinutes / 1440}-day`;
	if (w.windowMinutes % 60 === 0) return `${w.windowMinutes / 60}-hour`;
	return `${w.windowMinutes}-minute`;
}

/** One line a human can read at the end of a session. */
export function formatUsage(u: CodexUsage): string {
	const part = (w: UsageWindow) =>
		`${w.usedPercent}% of the ${windowName(w)} window (resets in ${humanDuration(w.resetAfterSeconds)})`;
	const parts = [part(u.primary)];
	if (u.secondary) parts.push(part(u.secondary));
	return `ChatGPT ${u.plan} usage: ${parts.join(" · ")}`;
}

/** The threshold a usage reading has crossed (for a one-time warning), or null. */
export function usageThreshold(u: CodexUsage): 80 | 95 | null {
	const worst = Math.max(u.primary.usedPercent, u.secondary?.usedPercent ?? 0);
	if (worst >= 95) return 95;
	if (worst >= 80) return 80;
	return null;
}

// ---------- CLI check: `bun run src/usage.ts [--json]` — one minimal completion (a few tokens) ----------
if (import.meta.main) {
	const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	let auth: { tokens?: { access_token?: string; account_id?: string } };
	try {
		auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
	} catch {
		console.error(`no Codex login at ${join(codexHome, "auth.json")} — run: codex login`);
		process.exit(1);
	}
	const token = auth.tokens?.access_token;
	if (!token) {
		console.error("auth.json has no tokens.access_token — log in with ChatGPT (codex login)");
		process.exit(1);
	}
	// Only a real completion carries the usage headers (verified: /models and validation 400s don't),
	// so this sends the smallest prompt that works and discards the body.
	const upstream = process.env.CCB_UPSTREAM ?? "https://chatgpt.com/backend-api/codex";
	const os = process.platform === "darwin" ? "macos" : process.platform;
	const res = await fetch(`${upstream}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-ID": auth.tokens?.account_id ?? "",
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			originator: "claude-code-codex-bridge",
			"User-Agent": `claude-code-codex-bridge/0.1.0 (${os}; ${process.arch})`,
		},
		body: JSON.stringify({
			model: process.env.CCB_SMALL_MODEL ?? "gpt-5.6-luna",
			input: [{ role: "user", content: [{ type: "input_text", text: "." }] }],
			instructions: "Reply with a single character.",
			stream: true,
			store: false,
		}),
	});
	await res.body?.cancel().catch(() => undefined);
	const usage = parseCodexUsage(res.headers);
	if (!usage) {
		const hint = res.status === 401 ? " — run: codex login" : "";
		console.error(`no usage headers in the response (HTTP ${res.status})${hint}`);
		process.exit(2);
	}
	if (process.argv.includes("--json")) console.log(JSON.stringify(usage, null, 2));
	else console.log(formatUsage(usage));
}
