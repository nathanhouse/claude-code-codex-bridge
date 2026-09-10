// HAL-ID: #HAL-20260910-2124-NH-D0
// Description: Localhost bridge — Anthropic Messages API in, Codex backend (OpenAI Responses) out, using the Codex CLI's stored login. Zero dependencies.
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SseDecoder } from "./sse";
import {
	type AnthropicEvent,
	aggregate,
	estimateTokens,
	InvalidRequestError,
	ResponsesToAnthropic,
	toResponsesRequest,
	UpstreamError,
} from "./translate";

export const VERSION = "0.1.0";

export interface BridgeConfig {
	host: string;
	port: number;
	/** Per-session shared secret Claude Code must present as `Authorization: Bearer`. */
	localToken: string;
	/** Base URL of the Codex backend (`…/backend-api/codex`). Override only for tests. */
	upstream: string;
	/** Directory holding Codex CLI's `auth.json`. */
	codexHome: string;
	model: string;
	smallModel: string;
	debug: boolean;
	/** Warning/debug sink — never receives bodies, headers or tokens. */
	log: (line: string) => void;
	maxBodyBytes: number;
	maxLineBytes: number;
	upstreamIdleMs?: number;
	parentPid?: number;
	watchdogMs?: number;
}

const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const JSON_HEADERS = { "Content-Type": "application/json" };

function anthropicError(status: number, type: string, message: string): Response {
	// A 413 also closes the socket, so a keep-alive reuse can't stall on anything left unread.
	const headers = status === 413 ? { ...JSON_HEADERS, Connection: "close" } : JSON_HEADERS;
	return Response.json({ type: "error", error: { type, message } }, { status, headers });
}

function sse(ev: AnthropicEvent): string {
	return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function tokenMatches(header: string | null, expected: string): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice(7), "utf8");
	const want = Buffer.from(expected, "utf8");
	return given.length === want.length && timingSafeEqual(given, want);
}

interface CodexAuth {
	accessToken: string;
	accountId: string;
}

function readCodexAuth(codexHome: string): CodexAuth | null {
	try {
		const raw = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as {
			tokens?: { access_token?: string; account_id?: string };
		};
		const accessToken = raw.tokens?.access_token;
		if (!accessToken) return null;
		return { accessToken, accountId: raw.tokens?.account_id ?? "" };
	} catch {
		return null;
	}
}

function warnIfLoosePermissions(codexHome: string, log: (l: string) => void): void {
	try {
		const mode = statSync(join(codexHome, "auth.json")).mode & 0o777;
		if (mode !== 0o600)
			log(`warning: ${join(codexHome, "auth.json")} is not 0600 (mode ${mode.toString(8)})`);
	} catch {
		log(`warning: ${join(codexHome, "auth.json")} not found — run: codex login`);
	}
}

/** Reads one chunk with an idle timeout; the timer is cleared as soon as data arrives. */
async function readIdle(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	ms: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("upstream idle timeout")), ms);
	});
	try {
		return await Promise.race([reader.read(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function startBridge(cfg: BridgeConfig) {
	const upstreamIdleMs = cfg.upstreamIdleMs ?? 10 * 60 * 1000;
	const cacheKey = crypto.randomUUID();
	const warned = new Set<string>();
	const warnOnce = (msg: string) => {
		if (warned.has(msg)) return;
		warned.add(msg);
		cfg.log(`warning: ${msg}`);
	};
	warnIfLoosePermissions(cfg.codexHome, cfg.log);

	async function callUpstream(
		body: unknown,
		auth: CodexAuth,
		signal: AbortSignal,
	): Promise<Response> {
		return fetch(`${cfg.upstream}/responses`, {
			method: "POST",
			signal,
			headers: {
				Authorization: `Bearer ${auth.accessToken}`,
				"ChatGPT-Account-ID": auth.accountId,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				originator: "claude-code-codex-bridge",
				"User-Agent": `claude-code-codex-bridge/${VERSION} (${process.platform === "darwin" ? "macos" : process.platform}; ${process.arch})`,
			},
			body: JSON.stringify(body),
		});
	}

	/** Pull the upstream SSE body through the decoder + mapper, yielding Anthropic events. Always terminates exactly once. */
	async function* translateStream(
		res: Response,
		abort: AbortController,
	): AsyncGenerator<AnthropicEvent> {
		const mapper = new ResponsesToAnthropic();
		const decoder = new SseDecoder({ maxLineBytes: cfg.maxLineBytes });
		const reader = res.body?.getReader();
		if (!reader) {
			yield* mapper.finish("upstream returned no body");
			return;
		}
		try {
			for (;;) {
				const { value, done } = await readIdle(reader, upstreamIdleMs);
				if (done) break;
				for (const frame of decoder.push(value)) {
					if (frame.data === "[DONE]") continue;
					let parsed: unknown;
					try {
						parsed = JSON.parse(frame.data);
					} catch {
						continue; // a malformed frame is skipped, not fatal
					}
					if (cfg.debug)
						cfg.log(`upstream event ${String((parsed as { type?: string })?.type ?? "?")}`);
					for (const ev of mapper.push(parsed)) yield ev;
					if (mapper.done) return;
				}
			}
			const tail = decoder.end();
			yield* mapper.finish(
				tail.unterminated ? "upstream ended mid-event" : "upstream ended before completion",
			);
		} catch (err) {
			// SseTooLargeError is an Error too — both surface their own message.
			yield* mapper.finish(err instanceof Error ? err.message : "upstream stream error");
		} finally {
			abort.abort();
			try {
				reader.releaseLock();
			} catch {
				/* already released */
			}
		}
	}

	async function messages(
		req: Request,
		server: { timeout(req: Request, s: number): void },
	): Promise<Response> {
		const tooLarge = () =>
			anthropicError(
				413,
				"invalid_request_error",
				`request body exceeds ${cfg.maxBodyBytes} bytes`,
			);

		const len = Number(req.headers.get("content-length") ?? 0);
		if (len > cfg.maxBodyBytes) {
			// Drain the upload before refusing: an early reply leaves the keep-alive socket half-read and the
			// client's NEXT request stalls on it (measured). Bun's maxRequestBodySize (2× cap) bounds this read.
			await req.arrayBuffer().catch(() => undefined);
			return tooLarge();
		}
		const text = await req.text();
		if (Buffer.byteLength(text, "utf8") > cfg.maxBodyBytes) return tooLarge();
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(text);
		} catch {
			return anthropicError(400, "invalid_request_error", "body is not valid JSON");
		}

		let upstreamBody: Record<string, unknown>;
		try {
			upstreamBody = toResponsesRequest(body, {
				model: cfg.model,
				smallModel: cfg.smallModel,
				cacheKey,
				warn: warnOnce,
			});
		} catch (err) {
			if (err instanceof InvalidRequestError)
				return anthropicError(400, "invalid_request_error", err.message);
			throw err;
		}

		let auth = readCodexAuth(cfg.codexHome);
		if (!auth)
			return anthropicError(401, "authentication_error", "No Codex login found. Run: codex login");

		const abort = new AbortController();
		let res = await callUpstream(upstreamBody, auth, abort.signal);
		if (res.status === 401) {
			// Codex CLI may have rotated the token since we last read the file.
			auth = readCodexAuth(cfg.codexHome);
			if (auth) res = await callUpstream(upstreamBody, auth, abort.signal);
		}
		if (res.status === 401) {
			if (cfg.debug) cfg.log("upstream 401");
			return anthropicError(
				401,
				"authentication_error",
				"Codex login rejected or expired. Run: codex login",
			);
		}
		if (res.status === 429)
			return anthropicError(
				429,
				"rate_limit_error",
				"ChatGPT subscription rate limit reached. Try again later.",
			);
		if (!res.ok) {
			if (cfg.debug) cfg.log(`upstream ${res.status}`);
			return anthropicError(502, "api_error", `upstream returned HTTP ${res.status}`);
		}

		if (body.stream === false) {
			const events: AnthropicEvent[] = [];
			for await (const ev of translateStream(res, abort)) events.push(ev);
			try {
				return Response.json(aggregate(events), { headers: JSON_HEADERS });
			} catch (err) {
				return anthropicError(
					502,
					"api_error",
					err instanceof UpstreamError ? err.message : "upstream error",
				);
			}
		}

		server.timeout(req, 0); // SSE can be quiet between events
		const stream = translateStream(res, abort);
		// Bun accepts an async generator as a streaming body; the DOM lib types don't know that yet.
		const sseBody = (async function* () {
			for await (const ev of stream) yield sse(ev);
		})() as unknown as BodyInit;
		return new Response(sseBody, {
			headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
		});
	}

	const server = Bun.serve({
		hostname: cfg.host,
		port: cfg.port,
		maxRequestBodySize: cfg.maxBodyBytes * 2, // we enforce our own cap with an Anthropic-shaped error
		async fetch(req, srv) {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname === "/health")
				return Response.json({ ok: true, version: VERSION });
			if (!tokenMatches(req.headers.get("authorization"), cfg.localToken)) {
				return anthropicError(401, "authentication_error", "missing or invalid local bridge token");
			}
			if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
				try {
					return Response.json({ input_tokens: estimateTokens(await req.json()) });
				} catch {
					return anthropicError(400, "invalid_request_error", "body is not valid JSON");
				}
			}
			if (req.method === "POST" && url.pathname === "/v1/messages") {
				try {
					return await messages(req, srv);
				} catch (err) {
					cfg.log(`error: ${err instanceof Error ? err.name : "unknown"}`);
					return anthropicError(500, "api_error", "bridge internal error");
				}
			}
			return anthropicError(404, "not_found_error", `no route for ${req.method} ${url.pathname}`);
		},
	});

	let watchdog: ReturnType<typeof setInterval> | undefined;
	if (cfg.parentPid) {
		watchdog = setInterval(() => {
			try {
				process.kill(cfg.parentPid as number, 0);
			} catch {
				server.stop(true);
				process.exit(0);
			}
		}, cfg.watchdogMs ?? 2000);
	}

	return {
		server,
		port: server.port,
		hostname: server.hostname,
		stop() {
			if (watchdog) clearInterval(watchdog);
			server.stop(true);
		},
	};
}

// ---------- CLI entry (used by the cc-astra launcher) ----------
if (import.meta.main) {
	const env = process.env;
	const token = env.CCB_LOCAL_TOKEN;
	if (!token) {
		console.error("CCB_LOCAL_TOKEN is required (the launcher sets it)");
		process.exit(2);
	}
	const bridge = await startBridge({
		host: env.CCB_HOST ?? "127.0.0.1",
		port: Number(env.CCB_PORT ?? 0),
		localToken: token,
		upstream: env.CCB_UPSTREAM ?? DEFAULT_UPSTREAM,
		codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
		model: env.CCB_MODEL ?? "gpt-6-astra",
		smallModel: env.CCB_SMALL_MODEL ?? env.CCB_MODEL ?? "gpt-6-astra",
		debug: env.CCB_DEBUG === "1",
		log: (line) => console.error(`[ccb] ${line}`),
		maxBodyBytes: 32 * 1024 * 1024,
		maxLineBytes: 1024 * 1024,
		parentPid: env.CCB_PARENT_PID ? Number(env.CCB_PARENT_PID) : undefined,
		watchdogMs: env.CCB_WATCHDOG_MS ? Number(env.CCB_WATCHDOG_MS) : undefined,
	});
	console.log(JSON.stringify({ port: bridge.port }));
}
