// HAL-ID: #HAL-20260910-2121-NH-PX
// Description: T6–T10, T19, T20 — bridge server behaviour against a mock upstream (spec v2 § Security/NFR)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../src/bridge";

const ACCESS = "ACCESS-SECRET";
const ACCOUNT = "acct_123";
const LOCAL = "local-token-abc";

const T3_SSE = [
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra"}}\n\n',
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"}}\n\n',
	'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"pong"}\n\n',
	'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"pong"}],"role":"assistant"}}\n\n',
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":2}}}\n\n',
].join("");

type Mode = "ok" | "401" | "huge" | "400msg" | "429" | "usage85";
let mode: Mode = "ok";
let lastHeaders: Record<string, string> = {};
let lastBody: Record<string, unknown> = {};

const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		lastHeaders = Object.fromEntries(req.headers.entries());
		lastBody = (await req.json()) as Record<string, unknown>;
		if (mode === "401") return new Response(`invalid token ${ACCESS}`, { status: 401 });
		if (mode === "400msg")
			return Response.json(
				{ error: { message: `Unsupported model gpt-typo for Bearer ${ACCESS}` } },
				{ status: 400 },
			);
		if (mode === "429")
			return Response.json(
				{ error: { message: "usage limit reached" } },
				{ status: 429, headers: { "retry-after": "120" } },
			);
		if (mode === "huge")
			return new Response(`data: ${"x".repeat(5 * 1024 * 1024)}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		return new Response(T3_SSE, {
			headers: {
				"Content-Type": "text/event-stream",
				"x-codex-plan-type": "pro",
				"x-codex-primary-used-percent": mode === "usage85" ? "85" : "3",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-after-seconds": "300000",
				"x-codex-secondary-window-minutes": "0",
			},
		});
	},
});

let codexHome = "";
let bridge: Awaited<ReturnType<typeof startBridge>>;
const stderr: string[] = [];

beforeAll(async () => {
	codexHome = mkdtempSync(join(tmpdir(), "ccb-"));
	writeFileSync(
		join(codexHome, "auth.json"),
		JSON.stringify({ tokens: { access_token: ACCESS, account_id: ACCOUNT } }),
	);
	chmodSync(join(codexHome, "auth.json"), 0o644); // T8: deliberately wrong
	bridge = await startBridge({
		host: "127.0.0.1",
		port: 0,
		localToken: LOCAL,
		upstream: `http://127.0.0.1:${upstream.port}/backend-api/codex`,
		codexHome,
		model: "gpt-6-astra",
		smallModel: "gpt-6-astra",
		debug: true,
		log: (line: string) => stderr.push(line),
		maxBodyBytes: 32 * 1024 * 1024,
		maxLineBytes: 1024 * 1024,
	});
});

afterAll(() => {
	bridge.stop();
	upstream.stop(true);
});

const url = (p: string) => `http://127.0.0.1:${bridge.port}${p}`;
const BODY = {
	model: "claude-opus-5",
	max_tokens: 100,
	stream: true,
	messages: [{ role: "user", content: "ping" }],
};
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(url(p), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("T6 local token + loopback", () => {
	test("binds 127.0.0.1", () => {
		expect(bridge.hostname).toBe("127.0.0.1");
	});
	test("no auth → 401; wrong → 401; right → 200 SSE", async () => {
		mode = "ok";
		expect((await post("/v1/messages", BODY)).status).toBe(401);
		expect((await post("/v1/messages", BODY, { Authorization: "Bearer nope" })).status).toBe(401);
		const ok = await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("text/event-stream");
		const text = await ok.text();
		expect(text).toContain("event: message_start");
		expect(text).toContain('"text":"pong"');
		expect(text).toContain("event: message_stop");
	});
});

describe("T7 token redaction", () => {
	test("upstream 401 body and access token never reach the client or the log", async () => {
		mode = "401";
		const before = stderr.length; // keep the startup warning for T8
		const r = await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		expect(r.status).toBe(401);
		const j = (await r.json()) as { error: { type: string; message: string } };
		expect(j.error.type).toBe("authentication_error");
		expect(j.error.message).toContain("codex login");
		expect(JSON.stringify(j)).not.toContain(ACCESS);
		const logged = stderr.slice(before).join("\n");
		expect(logged).not.toContain(ACCESS);
		expect(logged).not.toContain("invalid token");
		mode = "ok";
	});
});

describe("T8 auth.json mode warning", () => {
	test("warns about non-0600 and still serves", async () => {
		expect(stderr.some((l) => l.includes("not 0600"))).toBe(true);
		mode = "ok";
		expect((await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` })).status).toBe(
			200,
		);
	});
});

describe("T9 header whitelist + single host", () => {
	test("only the six headers reach upstream; honest identity; no beta/custom relay", async () => {
		mode = "ok";
		await post("/v1/messages", BODY, {
			Authorization: `Bearer ${LOCAL}`,
			"X-Evil": "1",
			"anthropic-beta": "x",
			"anthropic-version": "2023-06-01",
		});
		const keys = Object.keys(lastHeaders)
			.filter(
				(k) =>
					!["host", "content-length", "connection", "accept-encoding", "user-agent"].includes(k),
			)
			.sort();
		expect(keys).toEqual([
			"accept",
			"authorization",
			"chatgpt-account-id",
			"content-type",
			"originator",
		]);
		expect(lastHeaders.authorization).toBe(`Bearer ${ACCESS}`);
		expect(lastHeaders["chatgpt-account-id"]).toBe(ACCOUNT);
		expect(lastHeaders.originator).toBe("claude-code-codex-bridge");
		expect(lastHeaders["user-agent"]?.startsWith("claude-code-codex-bridge/")).toBe(true);
		expect("version" in lastHeaders).toBe(false);
		expect(lastBody.stream).toBe(true);
		expect(lastBody.store).toBe(false);
		expect(lastBody.instructions).toBe("");
	});
});

describe("T10 inbound cap + non-stream aggregation", () => {
	test("(a) oversized body → 413 Anthropic error", async () => {
		const big = { ...BODY, messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }] };
		const r = await post("/v1/messages", big, { Authorization: `Bearer ${LOCAL}` });
		expect(r.status).toBe(413);
		expect(((await r.json()) as { error: { type: string } }).error.type).toBe(
			"invalid_request_error",
		);
	});
	test("(b) stream:false → aggregated Message JSON", async () => {
		mode = "ok";
		const r = await post(
			"/v1/messages",
			{ ...BODY, stream: false },
			{ Authorization: `Bearer ${LOCAL}` },
		);
		expect(r.status).toBe(200);
		const m = (await r.json()) as {
			role: string;
			content: unknown[];
			stop_reason: string;
			usage: Record<string, number>;
		};
		expect(m.role).toBe("assistant");
		expect(m.content).toEqual([{ type: "text", text: "pong" }]);
		expect(m.stop_reason).toBe("end_turn");
		expect(m.usage.input_tokens).toBe(40);
		expect(m.usage.cache_read_input_tokens).toBe(60);
	});
	test("count_tokens and health", async () => {
		const r = await post("/v1/messages/count_tokens", BODY, { Authorization: `Bearer ${LOCAL}` });
		expect(r.status).toBe(200);
		expect(((await r.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
		expect((await fetch(url("/health"))).status).toBe(200);
	});
});

describe("T20 upstream caps", () => {
	test("5 MB data line → terminal error event, no hang", async () => {
		mode = "huge";
		const r = await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		const text = await r.text();
		expect(text).toContain("event: error");
		expect(text).toContain("too large");
		expect(text).not.toContain("event: message_stop");
		mode = "ok";
	});
});

describe("T19 parent-PID watchdog", () => {
	test("bridge exits when its parent process disappears", async () => {
		const parent = Bun.spawn(["sleep", "30"]);
		const child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "bridge.ts")], {
			env: {
				...process.env,
				CCB_HOST: "127.0.0.1",
				CCB_PORT: "0",
				CCB_LOCAL_TOKEN: LOCAL,
				CCB_PARENT_PID: String(parent.pid),
				CCB_WATCHDOG_MS: "200",
				CODEX_HOME: codexHome,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		await Bun.sleep(600); // let it start
		parent.kill();
		const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => -1)]);
		expect(code).toBe(0);
	}, 10_000);
});

describe("review fixes: what the user is told", () => {
	test("upstream 400 with a message → 502 that relays the reason, token redacted", async () => {
		mode = "400msg";
		const r = await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		expect(r.status).toBe(502);
		const j = (await r.json()) as { error: { message: string } };
		expect(j.error.message).toContain("HTTP 400");
		expect(j.error.message).toContain("Unsupported model gpt-typo");
		expect(j.error.message).not.toContain(ACCESS);
		mode = "ok";
	});
	test("upstream 429 → 429 with the reason and retry-after forwarded", async () => {
		mode = "429";
		const r = await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		expect(r.status).toBe(429);
		expect(r.headers.get("retry-after")).toBe("120");
		expect(
			((await r.json()) as { error: { type: string; message: string } }).error.message,
		).toContain("usage limit reached");
		mode = "ok";
	});
	test("unreachable backend → 502 naming the cause, not 'bridge internal error'", async () => {
		const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
		const port = closed.port;
		closed.stop(true);
		const dead = await startBridge({
			host: "127.0.0.1",
			port: 0,
			localToken: LOCAL,
			upstream: `http://127.0.0.1:${port}`,
			codexHome,
			model: "m",
			smallModel: "m",
			debug: false,
			log: () => undefined,
			maxBodyBytes: 1024 * 1024,
			maxLineBytes: 1024 * 1024,
		});
		const r = await fetch(`http://127.0.0.1:${dead.port}/v1/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOCAL}` },
			body: JSON.stringify(BODY),
		});
		expect(r.status).toBe(502);
		expect(((await r.json()) as { error: { message: string } }).error.message).toContain(
			"Could not reach the Codex backend",
		);
		dead.stop();
	});
	test("a JSON body that is not an object → 400, not 500", async () => {
		const r = await fetch(url("/v1/messages"), {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOCAL}` },
			body: "null",
		});
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: { message: string } }).error.message).toContain(
			"JSON object",
		);
	});
	test("auth.json without an access token explains itself", async () => {
		const home = mkdtempSync(join(tmpdir(), "ccb-noauth-"));
		writeFileSync(
			join(home, "auth.json"),
			JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
		);
		const b = await startBridge({
			host: "127.0.0.1",
			port: 0,
			localToken: LOCAL,
			upstream: `http://127.0.0.1:${upstream.port}`,
			codexHome: home,
			model: "m",
			smallModel: "m",
			debug: false,
			log: () => undefined,
			maxBodyBytes: 1024 * 1024,
			maxLineBytes: 1024 * 1024,
		});
		const r = await fetch(`http://127.0.0.1:${b.port}/v1/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOCAL}` },
			body: JSON.stringify(BODY),
		});
		expect(r.status).toBe(401);
		expect(((await r.json()) as { error: { message: string } }).error.message).toContain(
			"tokens.access_token",
		);
		b.stop();
	});
	test("non-streaming reply over the aggregate cap → 502, no hang", async () => {
		mode = "ok";
		const small = await startBridge({
			host: "127.0.0.1",
			port: 0,
			localToken: LOCAL,
			upstream: `http://127.0.0.1:${upstream.port}/backend-api/codex`,
			codexHome,
			model: "m",
			smallModel: "m",
			debug: false,
			log: () => undefined,
			maxBodyBytes: 1024 * 1024,
			maxLineBytes: 1024 * 1024,
			maxAggregateBytes: 64,
		});
		const r = await fetch(`http://127.0.0.1:${small.port}/v1/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOCAL}` },
			body: JSON.stringify({ ...BODY, stream: false }),
		});
		expect(r.status).toBe(502);
		expect(((await r.json()) as { error: { message: string } }).error.message).toContain("exceeds");
		small.stop();
	});
});

describe("usage tracking", () => {
	test("/usage needs the local token; after a request it reports what the backend said (JSON and text)", async () => {
		mode = "ok";
		expect((await fetch(url("/usage"))).status).toBe(401);
		await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		const j = (await (
			await fetch(url("/usage"), { headers: { Authorization: `Bearer ${LOCAL}` } })
		).json()) as {
			plan: string;
			primary: { usedPercent: number; windowMinutes: number };
			secondary: unknown;
		};
		expect(j.plan).toBe("pro");
		expect(j.primary.usedPercent).toBe(3);
		expect(j.primary.windowMinutes).toBe(10080);
		expect(j.secondary).toBeNull();
		const t = await (
			await fetch(url("/usage?format=text"), { headers: { Authorization: `Bearer ${LOCAL}` } })
		).text();
		expect(t).toContain("3% of the 1-week window");
	});
	test("crossing 80% logs one warning with the usage line", async () => {
		mode = "usage85";
		const before = stderr.length;
		await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		await post("/v1/messages", BODY, { Authorization: `Bearer ${LOCAL}` });
		const warnings = stderr.slice(before).filter((l) => l.includes("85% of the 1-week window"));
		expect(warnings.length).toBe(1);
		mode = "ok";
	});
});

describe("usage snapshot file", () => {
	test("CCB_USAGE_FILE gets the latest reading after each reply (atomic, 0600)", async () => {
		mode = "ok";
		const dir = mkdtempSync(join(tmpdir(), "ccb-snap-"));
		const file = join(dir, "nested", "codex-usage.json");
		const b = await startBridge({
			host: "127.0.0.1",
			port: 0,
			localToken: LOCAL,
			upstream: `http://127.0.0.1:${upstream.port}/backend-api/codex`,
			codexHome,
			model: "m",
			smallModel: "m",
			debug: false,
			log: () => undefined,
			maxBodyBytes: 1024 * 1024,
			maxLineBytes: 1024 * 1024,
			usageFile: file,
		});
		await fetch(`http://127.0.0.1:${b.port}/v1/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOCAL}` },
			body: JSON.stringify(BODY),
		});
		const snap = (await Bun.file(file).json()) as {
			plan: string;
			primary: { usedPercent: number };
			observedAt: number;
		};
		expect(snap.plan).toBe("pro");
		expect(snap.primary.usedPercent).toBe(3);
		expect(typeof snap.observedAt).toBe("number");
		expect(JSON.stringify(snap)).not.toContain(ACCESS);
		b.stop();
	});
});
