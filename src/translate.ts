// HAL-ID: #HAL-20260910-2123-NH-PR
// Description: Pure translation between the Anthropic Messages API (what Claude Code speaks) and the OpenAI Responses API (what the Codex backend speaks).

// ---------- loose wire types (both APIs are open-ended; we narrow at the edges) ----------
type Json = Record<string, unknown>;
type Block = Json & { type: string };

export interface MapOptions {
	/** Codex model for claude-opus/sonnet-class requests. */
	model: string;
	/** Codex model for claude-haiku-class requests (titles, summaries, subagents). */
	smallModel: string;
	/** Stable key so the backend's prompt cache hits across turns. */
	cacheKey: string;
	/** Optional sink for one-off warnings (unsupported tool types etc.). */
	warn?: (msg: string) => void;
}

/** The Responses-API body we send upstream (index signature: unknown extras are allowed but never added by us). */
export interface ResponsesRequest {
	model: string;
	instructions: string;
	input: Json[];
	stream: true;
	store: false;
	prompt_cache_key: string;
	tools?: Json[];
	tool_choice?: unknown;
	reasoning?: { effort: "low" | "medium" | "high"; summary: "auto" };
	include?: string[];
	[extra: string]: unknown;
}

export class InvalidRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidRequestError";
	}
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ENVELOPE_PREFIX = "ccb1.";

// ---------- envelope: exact Responses reasoning items carried inside Anthropic thinking.signature ----------
export function encodeEnvelope(items: Json[]): string {
	return ENVELOPE_PREFIX + Buffer.from(JSON.stringify({ items }), "utf8").toString("base64url");
}

export function decodeEnvelope(signature: unknown): { items: Json[] } | null {
	if (typeof signature !== "string" || !signature.startsWith(ENVELOPE_PREFIX)) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(signature.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"),
		);
		if (!parsed || !Array.isArray(parsed.items)) return null;
		return { items: parsed.items as Json[] };
	} catch {
		return null;
	}
}

// ---------- request: Anthropic → Responses ----------
function mapModel(name: unknown, opts: MapOptions): string {
	const m = typeof name === "string" ? name : "";
	if (/haiku/i.test(m)) return opts.smallModel;
	if (/^claude/i.test(m)) return opts.model;
	return m || opts.model;
}

function textOf(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) {
		return system
			.filter((b): b is Block => !!b && typeof b === "object" && (b as Block).type === "text")
			.map((b) => String(b.text ?? ""))
			.join("\n\n");
	}
	return "";
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content))
		return content.filter(
			(b): b is Block => !!b && typeof b === "object" && typeof (b as Block).type === "string",
		);
	return [];
}

function toolResultText(block: Block): string {
	const c = block.content;
	let text = "";
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		text = c
			.map((p: Block) => {
				switch (p.type) {
					case "text":
						return String(p.text ?? "");
					case "image":
						return "[image omitted]";
					default:
						return "";
				}
			})
			.filter(Boolean)
			.join("\n");
	}
	return block.is_error ? `[tool error] ${text}` : text;
}

function imagePart(block: Block, where: string): Json {
	const src = (block.source ?? {}) as Json;
	if (src.type !== "base64")
		throw new InvalidRequestError(`${where}.source.type: only "base64" is supported`);
	const media = String(src.media_type ?? "");
	if (!IMAGE_TYPES.has(media))
		throw new InvalidRequestError(`${where}.source.media_type: unsupported "${media}"`);
	return {
		type: "input_image",
		image_url: `data:${media};base64,${String(src.data ?? "")}`,
		detail: "auto",
	};
}

function userItems(blocks: Block[], where: string): Json[] {
	const items: Json[] = [];
	const parts: Json[] = [];
	blocks.forEach((b, j) => {
		if (b.type === "tool_result") {
			items.push({
				type: "function_call_output",
				call_id: String(b.tool_use_id ?? ""),
				output: toolResultText(b),
			});
		} else if (b.type === "text") {
			parts.push({ type: "input_text", text: String(b.text ?? "") });
		} else if (b.type === "image") {
			parts.push(imagePart(b, `${where}.content[${j}]`));
		}
	});
	if (parts.length) items.push({ role: "user", content: parts });
	return items;
}

function assistantItems(blocks: Block[], warn?: (msg: string) => void): Json[] {
	const items: Json[] = [];
	let text: string[] = [];
	const flush = () => {
		if (text.length) items.push({ role: "assistant", content: text.join("\n") });
		text = [];
	};
	for (const b of blocks) {
		if (b.type === "text") {
			text.push(String(b.text ?? ""));
		} else if (b.type === "tool_use") {
			flush();
			items.push({
				type: "function_call",
				call_id: String(b.id ?? ""),
				name: String(b.name ?? ""),
				arguments: JSON.stringify(b.input ?? {}),
			});
		} else if (b.type === "thinking") {
			flush();
			const env = decodeEnvelope(b.signature);
			if (env) items.push(...env.items);
			// e.g. a session resumed from real Claude: its signatures aren't ours, so the reasoning is lost.
			else warn?.("dropped a thinking block with a foreign or invalid signature");
		}
	}
	flush();
	return items;
}

function mapToolChoice(tc: unknown): unknown {
	if (!tc || typeof tc !== "object") return undefined;
	const choice = tc as Json;
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { type: "function", name: String(choice.name ?? "") };
		default:
			return undefined;
	}
}

function effortOf(budget: unknown): "low" | "medium" | "high" {
	const n = typeof budget === "number" ? budget : 16000;
	if (n < 4000) return "low";
	if (n < 16000) return "medium";
	return "high";
}

export function toResponsesRequest(body: Json, opts: MapOptions): ResponsesRequest {
	const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
	const input: Json[] = [];
	messages.forEach((m, i) => {
		const blocks = blocksOf(m.content);
		if (m.role === "assistant") input.push(...assistantItems(blocks, opts.warn));
		else input.push(...userItems(blocks, `messages[${i}]`));
	});

	const out: ResponsesRequest = {
		model: mapModel(body.model, opts),
		instructions: textOf(body.system),
		input,
		stream: true,
		store: false,
		prompt_cache_key: opts.cacheKey,
	};

	if (Array.isArray(body.tools)) {
		const tools: Json[] = [];
		for (const t of body.tools as Json[]) {
			const isFunction =
				t &&
				typeof t === "object" &&
				typeof t.name === "string" &&
				(!t.type || t.type === "custom");
			if (isFunction) {
				tools.push({
					type: "function",
					name: t.name,
					description: String(t.description ?? ""),
					// A tool with no schema is a zero-argument tool, not an invalid one.
					parameters: t.input_schema ?? { type: "object", properties: {} },
					strict: false,
				});
			} else {
				opts.warn?.(
					`dropping unsupported tool type "${String((t as Json)?.type ?? "?")}" (${String((t as Json)?.name ?? "")})`,
				);
			}
		}
		if (tools.length) out.tools = tools;
	}
	const choice = mapToolChoice(body.tool_choice);
	if (choice !== undefined) out.tool_choice = choice;

	const thinking = body.thinking as Json | undefined;
	if (thinking && thinking.type !== "disabled") {
		out.reasoning = { effort: effortOf(thinking.budget_tokens), summary: "auto" };
		out.include = ["reasoning.encrypted_content"];
	}
	return out;
}

/** Conservative context estimate for /v1/messages/count_tokens (an over-estimate by design). */
export function estimateTokens(body: Json): number {
	const s = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools });
	return Math.ceil(s.length / 3);
}

// ---------- response: Responses SSE events → Anthropic SSE events ----------
export type AnthropicEvent = Json & { type: string };

interface OpenBlock {
	index: number;
	kind: "text" | "tool_use" | "thinking";
	args: number; // bytes of tool arguments streamed so far
	name?: string; // tool_use only — the name the block was opened with
}

/** A function_call whose name hasn't arrived yet: arguments are buffered until `output_item.done`. */
interface PendingCall {
	callId: string;
	args: string[];
	bytes: number;
}

interface ItemState {
	kind: string;
	blocks: Map<number, OpenBlock>;
	pending?: PendingCall;
}

/** An item's open blocks in content_index order — the order they must be closed in. */
function inContentOrder(blocks: Map<number, OpenBlock>): OpenBlock[] {
	return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
}

export interface MapperOptions {
	/** Cap on streamed tool-call argument bytes per call. */
	maxArgBytes?: number;
	/** Sink for conditions that don't stop the stream but the operator should know about. */
	warn?: (msg: string) => void;
}

function usageOf(u: unknown): Json {
	const usage = (u ?? {}) as Json;
	const details = (usage.input_tokens_details ?? {}) as Json;
	const cached = Number(details.cached_tokens ?? 0);
	return {
		input_tokens: Math.max(0, Number(usage.input_tokens ?? 0) - cached),
		cache_read_input_tokens: cached,
		cache_creation_input_tokens: 0,
		output_tokens: Number(usage.output_tokens ?? 0),
	};
}

export class ResponsesToAnthropic {
	private started = false;
	private finished = false;
	private nextIndex = 0;
	/** item_id → the item's kind and its open blocks keyed by content_index (0 for non-message items). */
	private readonly items = new Map<string, ItemState>();
	private sawToolUse = false;
	private sawRefusal = false;
	private droppedDeltas = 0;
	private readonly maxArgBytes: number;
	private readonly warn: (msg: string) => void;

	constructor(opts: MapperOptions = {}) {
		this.maxArgBytes = opts.maxArgBytes ?? 4 * 1024 * 1024;
		this.warn = opts.warn ?? (() => undefined);
	}

	get done(): boolean {
		return this.finished;
	}

	/** Deltas that arrived for a block we never opened — a sign the upstream event shape changed. */
	get dropped(): number {
		return this.droppedDeltas;
	}

	push(raw: unknown): AnthropicEvent[] {
		if (this.finished || !raw || typeof raw !== "object") return [];
		const ev = raw as Json;
		const out: AnthropicEvent[] = [];
		switch (ev.type) {
			case "response.created":
				this.start(out, ev.response as Json);
				break;
			case "response.output_item.added":
				this.ensureStarted(out);
				this.itemAdded(out, ev.item as Json);
				break;
			case "response.content_part.added":
				this.ensureStarted(out);
				this.partAdded(
					out,
					String(ev.item_id ?? ""),
					Number(ev.content_index ?? 0),
					ev.part as Json,
				);
				break;
			case "response.output_text.delta":
			case "response.refusal.delta":
				this.delta(out, String(ev.item_id ?? ""), Number(ev.content_index ?? 0), {
					type: "text_delta",
					text: String(ev.delta ?? ""),
				});
				break;
			case "response.function_call_arguments.delta": {
				const itemId = String(ev.item_id ?? "");
				const chunk = String(ev.delta ?? "");
				const bytes = Buffer.byteLength(chunk, "utf8");
				const entry = this.items.get(itemId);
				const pending = entry?.pending;
				if (pending && !entry.blocks.has(0)) {
					pending.bytes += bytes;
					if (pending.bytes > this.maxArgBytes)
						return this.fail(out, "tool call arguments too large");
					pending.args.push(chunk); // name not known yet — replayed at output_item.done
					break;
				}
				const block = entry?.blocks.get(0);
				if (block) {
					block.args += bytes;
					if (block.args > this.maxArgBytes) return this.fail(out, "tool call arguments too large");
				}
				this.delta(out, itemId, 0, { type: "input_json_delta", partial_json: chunk });
				break;
			}
			case "response.reasoning_summary_text.delta":
				this.delta(out, String(ev.item_id ?? ""), 0, {
					type: "thinking_delta",
					thinking: String(ev.delta ?? ""),
				});
				break;
			case "response.output_item.done":
				this.itemDone(out, ev.item as Json);
				break;
			case "response.completed":
			case "response.incomplete":
				this.complete(out, ev.response as Json);
				break;
			case "response.failed": {
				const err = ((ev.response as Json | undefined)?.error ?? {}) as Json;
				this.fail(out, String(err.message ?? "upstream response failed"));
				break;
			}
			case "error":
				this.fail(out, String(ev.message ?? "upstream error"));
				break;
			default:
				break; // unknown event types are ignored by contract
		}
		return out;
	}

	/** Call at upstream EOF. Emits a terminal error if the stream never completed. Idempotent. */
	finish(reason = "upstream ended before completion"): AnthropicEvent[] {
		if (this.finished) return [];
		const out: AnthropicEvent[] = [];
		const detail = this.droppedDeltas
			? ` (${this.droppedDeltas} deltas had no block to land in)`
			: "";
		this.fail(out, reason + detail);
		return out;
	}

	// ----- internals -----
	private start(out: AnthropicEvent[], response: Json | undefined): void {
		if (this.started) return;
		this.started = true;
		out.push({
			type: "message_start",
			message: {
				id: String(response?.id ?? "msg_bridge"),
				type: "message",
				role: "assistant",
				model: String(response?.model ?? ""),
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 0,
				},
			},
		});
	}

	private ensureStarted(out: AnthropicEvent[]): void {
		if (!this.started) this.start(out, undefined);
	}

	private open(
		out: AnthropicEvent[],
		itemId: string,
		contentIndex: number,
		kind: OpenBlock["kind"],
		contentBlock: Json,
	): OpenBlock {
		const entry = this.entry(itemId, kind);
		const block: OpenBlock = { index: this.nextIndex++, kind, args: 0 };
		entry.blocks.set(contentIndex, block);
		out.push({ type: "content_block_start", index: block.index, content_block: contentBlock });
		return block;
	}

	/** The state for an item — created on first sight, never replaced (upstreams do re-emit `added`). */
	private entry(itemId: string, kind: string): ItemState {
		let entry = this.items.get(itemId);
		if (!entry) {
			entry = { kind, blocks: new Map() };
			this.items.set(itemId, entry);
		}
		return entry;
	}

	private openToolUse(
		out: AnthropicEvent[],
		itemId: string,
		callId: string,
		name: string,
	): OpenBlock {
		const block = this.open(out, itemId, 0, "tool_use", {
			type: "tool_use",
			id: callId,
			name,
			input: {},
		});
		block.name = name;
		return block;
	}

	private itemAdded(out: AnthropicEvent[], item: Json | undefined): void {
		if (!item) return;
		const id = String(item.id ?? "");
		const type = String(item.type ?? "");
		if (type === "function_call") {
			this.sawToolUse = true;
			if (this.items.get(id)?.blocks.has(0) || this.items.get(id)?.pending) return; // duplicate `added`
			const callId = String(item.call_id ?? item.id ?? "");
			const name = String(item.name ?? "");
			if (name) this.openToolUse(out, id, callId, name);
			// The name may arrive empty on `added` and be filled on `done`; Anthropic can't rename an open block,
			// so hold the block (and its argument deltas) until we know it.
			else this.entry(id, type).pending = { callId, args: [], bytes: 0 };
		} else if (type === "reasoning") {
			if (!this.items.get(id)?.blocks.has(0))
				this.open(out, id, 0, "thinking", { type: "thinking", thinking: "" });
		} else {
			this.entry(id, type);
		}
	}

	private partAdded(
		out: AnthropicEvent[],
		itemId: string,
		contentIndex: number,
		part: Json | undefined,
	): void {
		const type = String(part?.type ?? "");
		if (type === "refusal") this.sawRefusal = true;
		if (type === "output_text" || type === "refusal")
			this.open(out, itemId, contentIndex, "text", { type: "text", text: "" });
	}

	private delta(out: AnthropicEvent[], itemId: string, contentIndex: number, delta: Json): void {
		const block = this.items.get(itemId)?.blocks.get(contentIndex);
		if (!block) {
			this.droppedDeltas++;
			return;
		}
		out.push({ type: "content_block_delta", index: block.index, delta });
	}

	private itemDone(out: AnthropicEvent[], item: Json | undefined): void {
		if (!item) return;
		const id = String(item.id ?? "");
		const entry = this.items.get(id);
		if (!entry) return;
		if (entry.pending && !entry.blocks.has(0)) {
			// Deferred function_call: now we have the authoritative name — emit the whole block at once.
			const name = String(item.name ?? "");
			if (!name) {
				this.fail(out, "upstream tool call arrived without a name");
				return;
			}
			this.openToolUse(out, id, entry.pending.callId, name);
			const args = entry.pending.args.length
				? entry.pending.args.join("")
				: String(item.arguments ?? "");
			if (args) this.delta(out, id, 0, { type: "input_json_delta", partial_json: args });
			entry.pending = undefined;
		}
		for (const block of inContentOrder(entry.blocks)) {
			if (block.kind === "tool_use" && item.name && block.name !== String(item.name)) {
				// Anthropic's wire format has no way to rename an already-started tool_use block.
				this.fail(
					out,
					`upstream renamed a tool call mid-stream (${block.name} → ${String(item.name)})`,
				);
				return;
			}
			if (block.kind === "thinking")
				out.push({
					type: "content_block_delta",
					index: block.index,
					delta: { type: "signature_delta", signature: encodeEnvelope([item]) },
				});
			out.push({ type: "content_block_stop", index: block.index });
		}
		entry.blocks.clear();
	}

	private closeAll(out: AnthropicEvent[]): void {
		for (const entry of this.items.values()) {
			for (const block of inContentOrder(entry.blocks))
				out.push({ type: "content_block_stop", index: block.index });
			entry.blocks.clear();
		}
	}

	/** An incomplete response's reason wins where it maps to an Anthropic stop_reason; otherwise the content decides. */
	private stopReason(response: Json | undefined): string {
		if (response?.status === "incomplete") {
			const reason = String(((response.incomplete_details ?? {}) as Json).reason ?? "");
			if (reason === "max_tokens") return "max_tokens";
			if (reason === "content_filter") return "refusal";
			this.warn(
				`upstream reported an incomplete response (reason "${reason}") — passed on as end_turn`,
			);
		}
		if (this.sawToolUse) return "tool_use";
		if (this.sawRefusal) return "refusal";
		return "end_turn";
	}

	private complete(out: AnthropicEvent[], response: Json | undefined): void {
		this.ensureStarted(out);
		this.closeAll(out);
		if (!response?.usage)
			this.warn("upstream reported no usage — Claude Code's context accounting will be wrong");
		out.push({
			type: "message_delta",
			delta: { stop_reason: this.stopReason(response), stop_sequence: null },
			usage: usageOf(response?.usage),
		});
		out.push({ type: "message_stop" });
		this.finished = true;
	}

	private fail(out: AnthropicEvent[], message: string): AnthropicEvent[] {
		if (this.finished) return out;
		this.finished = true;
		out.push({ type: "error", error: { type: "api_error", message } });
		return out;
	}
}

// ---------- aggregate a streamed sequence into one Message (non-stream clients) ----------
export class UpstreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpstreamError";
	}
}

/** Streamed tool arguments must be JSON; a malformed call is an upstream failure, not an empty call. */
function parseInput(name: string, json: string): unknown {
	if (!json) return {};
	try {
		return JSON.parse(json);
	} catch {
		throw new UpstreamError(`tool call "${name}" returned arguments that are not valid JSON`);
	}
}

export function aggregate(events: AnthropicEvent[]): Json {
	let id = "msg_bridge";
	let model = "";
	let stop_reason: unknown = null;
	let usage: Json = {
		input_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 0,
	};
	const blocks = new Map<
		number,
		{ type: string; text: string; json: string; name?: string; id?: string; signature?: string }
	>();
	for (const ev of events) {
		switch (ev.type) {
			case "error":
				throw new UpstreamError(String(((ev.error ?? {}) as Json).message ?? "upstream error"));
			case "message_start": {
				const m = ev.message as Json;
				id = String(m.id);
				model = String(m.model);
				break;
			}
			case "content_block_start": {
				const cb = ev.content_block as Json;
				blocks.set(Number(ev.index), {
					type: String(cb.type),
					text: "",
					json: "",
					name: cb.name as string | undefined,
					id: cb.id as string | undefined,
				});
				break;
			}
			case "content_block_delta": {
				const b = blocks.get(Number(ev.index));
				if (!b) break;
				const d = ev.delta as Json;
				switch (d.type) {
					case "text_delta":
						b.text += String(d.text);
						break;
					case "thinking_delta":
						b.text += String(d.thinking);
						break;
					case "input_json_delta":
						b.json += String(d.partial_json);
						break;
					case "signature_delta":
						b.signature = String(d.signature);
						break;
					default:
						break;
				}
				break;
			}
			case "message_delta":
				stop_reason = (ev.delta as Json).stop_reason;
				if (ev.usage) usage = ev.usage as Json;
				break;
			default:
				break;
		}
	}
	const content: Json[] = [...blocks.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, b]) => {
			if (b.type === "tool_use")
				return {
					type: "tool_use",
					id: b.id ?? "",
					name: b.name ?? "",
					input: parseInput(b.name ?? "", b.json),
				};
			if (b.type === "thinking")
				return { type: "thinking", thinking: b.text, signature: b.signature ?? "" };
			return { type: "text", text: b.text };
		});
	return {
		id,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason,
		stop_sequence: null,
		usage,
	};
}
