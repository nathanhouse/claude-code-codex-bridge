// HAL-ID: #HAL-20260910-2120-NH-PV
// Description: T1–T5, T11, T12, T14–T18 — Anthropic ⇄ Responses translation (spec v2 § Data model)
import { describe, expect, test } from "bun:test";
import {
	aggregate,
	decodeEnvelope,
	estimateTokens,
	InvalidRequestError,
	ResponsesToAnthropic,
	toResponsesRequest,
} from "../src/translate";

const OPTS = { model: "gpt-6-astra", smallModel: "gpt-5.6-luna", cacheKey: "k" };

describe("T1 request: text-only conversation", () => {
	test("maps roles, instructions, mandatory fields; drops unsupported", () => {
		const out = toResponsesRequest(
			{
				model: "claude-opus-5",
				system: "You are HAL",
				max_tokens: 1024,
				temperature: 0,
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "hello" },
					{ role: "user", content: [{ type: "text", text: "again" }] },
				],
			},
			OPTS,
		);
		expect(out.model).toBe("gpt-6-astra");
		expect(out.instructions).toBe("You are HAL");
		expect(out.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: [{ type: "input_text", text: "again" }] },
		]);
		expect(out.stream).toBe(true);
		expect(out.store).toBe(false);
		expect(out.prompt_cache_key).toBe("k");
		for (const k of ["max_output_tokens", "temperature", "parallel_tool_calls", "top_p"]) {
			expect(k in out).toBe(false);
		}
	});

	test("haiku-class model names route to smallModel; unknown names pass through", () => {
		const base = { max_tokens: 1, messages: [{ role: "user", content: "x" }] };
		expect(toResponsesRequest({ ...base, model: "claude-haiku-4-5-20251001" }, OPTS).model).toBe(
			"gpt-5.6-luna",
		);
		expect(toResponsesRequest({ ...base, model: "claude-sonnet-5" }, OPTS).model).toBe(
			"gpt-6-astra",
		);
		expect(toResponsesRequest({ ...base, model: "gpt-5.6-terra" }, OPTS).model).toBe(
			"gpt-5.6-terra",
		);
	});

	test("system blocks are joined; empty system → instructions ''", () => {
		const base = {
			model: "claude-opus-5",
			max_tokens: 1,
			messages: [{ role: "user", content: "x" }],
		};
		const a = toResponsesRequest(
			{
				...base,
				system: [
					{ type: "text", text: "A" },
					{ type: "text", text: "B", cache_control: { type: "ephemeral" } },
				],
			},
			OPTS,
		);
		expect(a.instructions).toBe("A\n\nB");
		expect(toResponsesRequest(base, OPTS).instructions).toBe("");
	});

	test("messages that become empty are skipped, never content: []", () => {
		const out = toResponsesRequest(
			{
				model: "claude-opus-5",
				max_tokens: 1,
				messages: [
					{ role: "user", content: "x" },
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "t", signature: "garbage" }],
					},
					{ role: "user", content: "y" },
				],
			},
			OPTS,
		);
		expect(out.input.length).toBe(2);
	});
});

describe("T2 request: tools round-trip", () => {
	test("tools, function_call, function_call_output, tool_choice", () => {
		const out = toResponsesRequest(
			{
				model: "claude-opus-5",
				max_tokens: 1,
				tools: [
					{
						name: "Bash",
						description: "run",
						input_schema: { type: "object", properties: { cmd: { type: "string" } } },
					},
					{ type: "web_search_20250305", name: "web_search" },
				],
				tool_choice: { type: "any" },
				messages: [
					{ role: "user", content: "ls please" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Running." },
							{ type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_1",
								is_error: true,
								content: [
									{ type: "text", text: "a" },
									{ type: "text", text: "b" },
								],
							},
						],
					},
				],
			},
			OPTS,
		);
		expect(out.tools).toEqual([
			{
				type: "function",
				name: "Bash",
				description: "run",
				parameters: { type: "object", properties: { cmd: { type: "string" } } },
				strict: false,
			},
		]);
		expect(out.tool_choice).toBe("required");
		expect(out.input[1]).toEqual({ role: "assistant", content: "Running." });
		expect(out.input[2]).toEqual({
			type: "function_call",
			call_id: "toolu_1",
			name: "Bash",
			arguments: '{"cmd":"ls"}',
		});
		expect(out.input[3]).toEqual({
			type: "function_call_output",
			call_id: "toolu_1",
			output: "[tool error] a\nb",
		});
	});

	test("tool_choice variants", () => {
		const base = {
			model: "claude-opus-5",
			max_tokens: 1,
			messages: [{ role: "user", content: "x" }],
		};
		expect(toResponsesRequest({ ...base, tool_choice: { type: "auto" } }, OPTS).tool_choice).toBe(
			"auto",
		);
		expect(toResponsesRequest({ ...base, tool_choice: { type: "none" } }, OPTS).tool_choice).toBe(
			"none",
		);
		expect(
			toResponsesRequest({ ...base, tool_choice: { type: "tool", name: "Bash" } }, OPTS)
				.tool_choice,
		).toEqual({
			type: "function",
			name: "Bash",
		});
	});

	test("thinking config → reasoning effort + include", () => {
		const base = {
			model: "claude-opus-5",
			max_tokens: 1,
			messages: [{ role: "user", content: "x" }],
		};
		const lo = toResponsesRequest(
			{ ...base, thinking: { type: "enabled", budget_tokens: 2000 } },
			OPTS,
		);
		expect(lo.reasoning).toEqual({ effort: "low", summary: "auto" });
		expect(lo.include).toEqual(["reasoning.encrypted_content"]);
		expect(
			toResponsesRequest({ ...base, thinking: { type: "enabled", budget_tokens: 8000 } }, OPTS)
				.reasoning?.effort,
		).toBe("medium");
		expect(
			toResponsesRequest({ ...base, thinking: { type: "enabled", budget_tokens: 32000 } }, OPTS)
				.reasoning?.effort,
		).toBe("high");
	});
});

// ---------- streaming fixtures (exact wire names) ----------
const created = { type: "response.created", response: { id: "resp_1", model: "gpt-6-astra" } };
const msgAdded = {
	type: "response.output_item.added",
	output_index: 0,
	item: {
		id: "msg_1",
		type: "message",
		status: "in_progress",
		content: [],
		role: "assistant",
		phase: "final_answer",
	},
};
const partText = {
	type: "response.content_part.added",
	item_id: "msg_1",
	output_index: 0,
	content_index: 0,
	part: { type: "output_text", text: "" },
};
const delta = (d: string) => ({
	type: "response.output_text.delta",
	item_id: "msg_1",
	output_index: 0,
	content_index: 0,
	delta: d,
});
const msgDone = {
	type: "response.output_item.done",
	output_index: 0,
	item: {
		id: "msg_1",
		type: "message",
		status: "completed",
		content: [{ type: "output_text", text: "pong" }],
		role: "assistant",
		phase: "final_answer",
	},
};
const completed = (usage: unknown) => ({
	type: "response.completed",
	response: { id: "resp_1", status: "completed", usage },
});
const USAGE = { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 2 };

function run(events: unknown[], eof = true) {
	const m = new ResponsesToAnthropic();
	const out = [];
	for (const e of events) out.push(...m.push(e));
	if (eof) out.push(...m.finish());
	return out;
}

describe("T3 stream: text", () => {
	test("exact Anthropic sequence and usage mapping", () => {
		const out = run([
			created,
			msgAdded,
			partText,
			delta("po"),
			delta("ng"),
			msgDone,
			completed(USAGE),
		]);
		expect(out.map((e) => e.type)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const start = out[0] as unknown as {
			message: { id: string; model: string; usage: Record<string, number> };
		};
		expect(start.message.id).toBe("resp_1");
		expect(start.message.usage).toEqual({
			input_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: 0,
		});
		expect(out[1]).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		expect(out[2]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "po" },
		});
		expect(out[5]).toEqual({
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: {
				input_tokens: 40,
				cache_read_input_tokens: 60,
				cache_creation_input_tokens: 0,
				output_tokens: 2,
			},
		});
	});
});

describe("T4 stream: function call", () => {
	const fcAdded = {
		type: "response.output_item.added",
		output_index: 0,
		item: {
			id: "fc_1",
			type: "function_call",
			call_id: "call_9",
			name: "Bash",
			arguments: "",
			status: "in_progress",
		},
	};
	const argDelta = (d: string) => ({
		type: "response.function_call_arguments.delta",
		item_id: "fc_1",
		output_index: 0,
		delta: d,
	});
	const fcDone = {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			id: "fc_1",
			type: "function_call",
			call_id: "call_9",
			name: "Bash",
			arguments: '{"cmd":"ls"}',
			status: "completed",
		},
	};
	test("tool_use block with streamed JSON and stop_reason tool_use", () => {
		const out = run([
			created,
			fcAdded,
			argDelta('{"cmd":'),
			argDelta('"ls"}'),
			fcDone,
			completed(USAGE),
		]);
		expect(out[1]).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call_9", name: "Bash", input: {} },
		});
		expect(out[2]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"cmd":' },
		});
		expect(out[3]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '"ls"}' },
		});
		expect(out[4]).toEqual({ type: "content_block_stop", index: 0 });
		expect((out[5] as unknown as { delta: { stop_reason: string } }).delta.stop_reason).toBe(
			"tool_use",
		);
	});
});

describe("T5 stream: failures terminate exactly once", () => {
	test("(a) response.failed envelope", () => {
		const out = run([
			created,
			{
				type: "response.failed",
				response: {
					id: "resp_1",
					status: "failed",
					error: { code: "server_error", message: "boom" },
				},
			},
		]);
		expect(out.at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
		expect(out.filter((e) => e.type === "message_stop").length).toBe(0);
		expect(out.filter((e) => e.type === "error").length).toBe(1);
	});
	test("(b) standalone error event", () => {
		const m = new ResponsesToAnthropic();
		const out = [
			...m.push(created),
			...m.push({ type: "error", code: "x", message: "bad" }),
			...m.finish(),
			...m.finish(),
		];
		expect(out.filter((e) => e.type === "error")).toEqual([
			{ type: "error", error: { type: "api_error", message: "bad" } },
		]);
		expect(m.done).toBe(true);
	});
});

describe("T11 thinking envelope", () => {
	const rsAdded = {
		type: "response.output_item.added",
		output_index: 0,
		item: { id: "rs_1", type: "reasoning", summary: [] },
	};
	const rsDelta = {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 0,
		delta: "think",
	};
	const rsItem = {
		id: "rs_1",
		type: "reasoning",
		summary: [{ type: "summary_text", text: "think" }],
		encrypted_content: "ENC",
	};
	const rsDone = { type: "response.output_item.done", output_index: 0, item: rsItem };
	const msg2Added = { ...msgAdded, output_index: 1 };
	const part2 = { ...partText, output_index: 1 };
	const d2 = { ...delta("ok"), output_index: 1 };
	const msg2Done = {
		...msgDone,
		output_index: 1,
		item: { ...msgDone.item, content: [{ type: "output_text", text: "ok" }] },
	};

	test("stream → thinking block with ccb1 signature; replay reconstructs exact items in order", () => {
		const out = run([
			created,
			rsAdded,
			rsDelta,
			rsDone,
			msg2Added,
			part2,
			d2,
			msg2Done,
			completed(USAGE),
		]);
		expect(out[1]).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		});
		expect(out[2]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "think" },
		});
		const sig = out[3] as unknown as { delta: { type: string; signature: string } };
		expect(sig.delta.type).toBe("signature_delta");
		expect(sig.delta.signature.startsWith("ccb1.")).toBe(true);
		expect(decodeEnvelope(sig.delta.signature)).toEqual({ items: [rsItem] });

		const msg = aggregate(out);
		const back = toResponsesRequest(
			{
				model: "claude-opus-5",
				max_tokens: 1,
				messages: [
					{ role: "user", content: "q" },
					{ role: "assistant", content: msg.content },
				],
			},
			OPTS,
		);
		expect(back.input.slice(1)).toEqual([rsItem, { role: "assistant", content: "ok" }]);
	});

	test("garbage signature → block dropped, no throw", () => {
		expect(decodeEnvelope("garbage")).toBeNull();
		expect(decodeEnvelope("ccb1.!!!")).toBeNull();
		const back = toResponsesRequest(
			{
				model: "claude-opus-5",
				max_tokens: 1,
				messages: [
					{ role: "user", content: "q" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "t", signature: "garbage" },
							{ type: "text", text: "ok" },
						],
					},
				],
			},
			OPTS,
		);
		expect(back.input.slice(1)).toEqual([{ role: "assistant", content: "ok" }]);
	});
});

describe("T12 count_tokens estimate", () => {
	test("ceil(chars/3) over serialised system+messages+tools", () => {
		const body = {
			model: "m",
			system: "s".repeat(1000),
			messages: [{ role: "user", content: "u".repeat(1000) }],
			tools: [{ name: "t".repeat(1000) }],
		};
		const chars = JSON.stringify({
			system: body.system,
			messages: body.messages,
			tools: body.tools,
		}).length;
		expect(estimateTokens(body)).toBe(Math.ceil(chars / 3));
	});
});

describe("T14 parallel tool calls with interleaved deltas", () => {
	const add = (id: string, call: string, idx: number) => ({
		type: "response.output_item.added",
		output_index: idx,
		item: {
			id,
			type: "function_call",
			call_id: call,
			name: "Bash",
			arguments: "",
			status: "in_progress",
		},
	});
	const ad = (id: string, d: string) => ({
		type: "response.function_call_arguments.delta",
		item_id: id,
		delta: d,
	});
	const done = (id: string, call: string, idx: number, args: string) => ({
		type: "response.output_item.done",
		output_index: idx,
		item: {
			id,
			type: "function_call",
			call_id: call,
			name: "Bash",
			arguments: args,
			status: "completed",
		},
	});
	test("routes by item_id, stops in upstream order, aggregate parses both", () => {
		const out = run([
			created,
			add("fc_A", "call_A", 0),
			add("fc_B", "call_B", 1),
			ad("fc_B", '{"x":1}'),
			ad("fc_A", '{"y":2}'),
			done("fc_B", "call_B", 1, '{"x":1}'),
			done("fc_A", "call_A", 0, '{"y":2}'),
			completed(USAGE),
		]);
		const idxOf = (t: string, i: number) =>
			out.filter((e) => e.type === t)[i] as unknown as { index: number };
		expect((out[1] as unknown as { content_block: { id: string } }).content_block.id).toBe(
			"call_A",
		);
		expect((out[2] as unknown as { content_block: { id: string } }).content_block.id).toBe(
			"call_B",
		);
		expect(out[3]).toEqual({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"x":1}' },
		});
		expect(out[4]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"y":2}' },
		});
		expect(idxOf("content_block_stop", 0).index).toBe(1);
		expect(idxOf("content_block_stop", 1).index).toBe(0);
		const msg = aggregate(out);
		expect(msg.stop_reason).toBe("tool_use");
		expect(msg.content).toEqual([
			{ type: "tool_use", id: "call_A", name: "Bash", input: { y: 2 } },
			{ type: "tool_use", id: "call_B", name: "Bash", input: { x: 1 } },
		]);
	});
});

describe("T15 refusal", () => {
	test("refusal part streams as text, stop_reason refusal", () => {
		const partRef = { ...partText, part: { type: "refusal", refusal: "" } };
		const refDelta = {
			type: "response.refusal.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: "no",
		};
		const out = run([created, msgAdded, partRef, refDelta, msgDone, completed(USAGE)]);
		expect(out[2]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "no" },
		});
		expect(
			(out.find((e) => e.type === "message_delta") as unknown as { delta: { stop_reason: string } })
				.delta.stop_reason,
		).toBe("refusal");
	});
});

describe("T16 incomplete + EOF single finalisation", () => {
	test("(a) incomplete max_tokens → stop_reason max_tokens once", () => {
		const out = run([
			created,
			msgAdded,
			partText,
			delta("po"),
			{
				type: "response.incomplete",
				response: {
					id: "resp_1",
					status: "incomplete",
					incomplete_details: { reason: "max_tokens" },
					usage: USAGE,
				},
			},
		]);
		const deltas = out.filter((e) => e.type === "message_delta") as unknown as {
			delta: { stop_reason: string };
		}[];
		expect(deltas.length).toBe(1);
		expect(deltas[0]?.delta.stop_reason).toBe("max_tokens");
		expect(out.filter((e) => e.type === "message_stop").length).toBe(1);
		// an open block is closed before the terminal
		expect(out.findIndex((e) => e.type === "content_block_stop")).toBeLessThan(
			out.findIndex((e) => e.type === "message_delta"),
		);
	});
	test("(b) EOF with no terminal → one error, then nothing", () => {
		const m = new ResponsesToAnthropic();
		const out = [...m.push(created), ...m.finish(), ...m.finish(), ...m.push(completed(USAGE))];
		expect(out.filter((e) => e.type === "error").length).toBe(1);
		expect(out.filter((e) => e.type === "message_stop").length).toBe(0);
	});
});

describe("T17 usage with reasoning tokens", () => {
	test("output_tokens includes reasoning; cached 0", () => {
		const out = run([
			created,
			completed({
				input_tokens: 10,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: 50,
				output_tokens_details: { reasoning_tokens: 40 },
			}),
		]);
		expect(
			(out.find((e) => e.type === "message_delta") as unknown as { usage: unknown }).usage,
		).toEqual({
			input_tokens: 10,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 50,
		});
	});
});

describe("T18 images", () => {
	const base = { model: "claude-opus-5", max_tokens: 1 };
	test("(a) base64 png → input_image data URL", () => {
		const out = toResponsesRequest(
			{
				...base,
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
						],
					},
				],
			},
			OPTS,
		);
		expect(out.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" }],
		});
	});
	test("(b) url source and (c) bmp media type → InvalidRequestError naming the field", () => {
		expect(() =>
			toResponsesRequest(
				{
					...base,
					messages: [
						{
							role: "user",
							content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
						},
					],
				},
				OPTS,
			),
		).toThrow(InvalidRequestError);
		try {
			toResponsesRequest(
				{
					...base,
					messages: [
						{
							role: "user",
							content: [
								{ type: "image", source: { type: "base64", media_type: "image/bmp", data: "A" } },
							],
						},
					],
				},
				OPTS,
			);
		} catch (e) {
			expect((e as Error).message).toContain("media_type");
		}
	});
});

describe("review fixes: tool-call state machine", () => {
	const add = (name: string) => ({
		type: "response.output_item.added",
		output_index: 0,
		item: {
			id: "fc_1",
			type: "function_call",
			call_id: "call_1",
			name,
			arguments: "",
			status: "in_progress",
		},
	});
	const argDelta = (d: string) => ({
		type: "response.function_call_arguments.delta",
		item_id: "fc_1",
		output_index: 0,
		delta: d,
	});
	const done = (name: string) => ({
		type: "response.output_item.done",
		output_index: 0,
		item: {
			id: "fc_1",
			type: "function_call",
			call_id: "call_1",
			name,
			arguments: '{"x":1}',
			status: "completed",
		},
	});
	test("name empty at added, filled at done → block emitted at done with the real name and buffered args", () => {
		const out = run([
			created,
			add(""),
			argDelta('{"x":'),
			argDelta("1}"),
			done("Bash"),
			completed(USAGE),
		]);
		const start = out.find((e) => e.type === "content_block_start") as unknown as {
			content_block: { name: string };
		};
		expect(start.content_block.name).toBe("Bash");
		const deltas = out.filter((e) => e.type === "content_block_delta") as unknown as {
			delta: { partial_json: string };
		}[];
		expect(deltas.map((d) => d.delta.partial_json).join("")).toBe('{"x":1}');
		expect(aggregate(out).content).toEqual([
			{ type: "tool_use", id: "call_1", name: "Bash", input: { x: 1 } },
		]);
	});
	test("name changed between added and done → one error, no message_stop", () => {
		const out = run([created, add("Read"), argDelta("{}"), done("Bash"), completed(USAGE)]);
		expect(out.filter((e) => e.type === "error").length).toBe(1);
		expect(out.filter((e) => e.type === "message_stop").length).toBe(0);
	});
	test("duplicate output_item.added for a message keeps its open blocks", () => {
		const out = run([
			created,
			msgAdded,
			partText,
			delta("po"),
			msgAdded,
			delta("ng"),
			msgDone,
			completed(USAGE),
		]);
		expect(out.filter((e) => e.type === "content_block_delta").length).toBe(2);
		expect(out.filter((e) => e.type === "content_block_stop").length).toBe(1);
		expect(aggregate(out).content).toEqual([{ type: "text", text: "pong" }]);
	});
	test("non-JSON tool arguments → aggregate throws UpstreamError", () => {
		const out = run([created, add("Bash"), argDelta("{not json"), done("Bash"), completed(USAGE)]);
		expect(() => aggregate(out)).toThrow(/not valid JSON/);
	});
	test("message_delta without usage keeps the zero usage object", () => {
		const msg = aggregate([
			{ type: "message_start", message: { id: "m", model: "x" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		]);
		expect(msg.usage).toEqual({
			input_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: 0,
		});
	});
	test("warn fires on missing usage and on an unknown incomplete reason", () => {
		const warnings: string[] = [];
		const m = new ResponsesToAnthropic({ warn: (w) => warnings.push(w) });
		m.push(created);
		m.push({
			type: "response.incomplete",
			response: { id: "r", status: "incomplete", incomplete_details: { reason: "weird" } },
		});
		expect(warnings.some((w) => w.includes("no usage"))).toBe(true);
		expect(warnings.some((w) => w.includes("weird"))).toBe(true);
	});
});

describe("review fixes: request mapping", () => {
	const base = {
		model: "claude-opus-5",
		max_tokens: 1,
		messages: [{ role: "user", content: "x" }],
	};
	test("a tool without input_schema is kept with an empty schema; a server tool type is dropped", () => {
		const warnings: string[] = [];
		const out = toResponsesRequest(
			{
				...base,
				tools: [
					{ name: "NoArgs", description: "d" },
					{ type: "web_search_20250305", name: "web_search" },
				],
			},
			{ ...OPTS, warn: (w) => warnings.push(w) },
		);
		expect(out.tools).toEqual([
			{
				type: "function",
				name: "NoArgs",
				description: "d",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("web_search_20250305");
	});
	test("a foreign thinking signature warns once via opts.warn", () => {
		const warnings: string[] = [];
		toResponsesRequest(
			{
				...base,
				messages: [
					{ role: "user", content: "q" },
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "t", signature: "sig_from_anthropic" }],
					},
				],
			},
			{ ...OPTS, warn: (w) => warnings.push(w) },
		);
		expect(warnings.some((w) => w.includes("foreign or invalid signature"))).toBe(true);
	});
});

describe("speed: reasoning effort + service tier", () => {
	const base = {
		model: "claude-opus-5",
		max_tokens: 1,
		messages: [{ role: "user", content: "x" }],
	};
	test("thinking without a budget → the model's default (medium), not high", () => {
		const out = toResponsesRequest({ ...base, thinking: { type: "adaptive" } }, OPTS);
		expect(out.reasoning?.effort).toBe("medium");
	});
	test("an explicit effort overrides any budget", () => {
		const out = toResponsesRequest(
			{ ...base, thinking: { type: "enabled", budget_tokens: 32000 } },
			{ ...OPTS, reasoningEffort: "low" },
		);
		expect(out.reasoning?.effort).toBe("low");
	});
	test("service tier is sent only when configured", () => {
		expect("service_tier" in toResponsesRequest(base, OPTS)).toBe(false);
		expect(toResponsesRequest(base, { ...OPTS, serviceTier: "priority" }).service_tier).toBe(
			"priority",
		);
	});
	test("a [1m] suffix is a client hint and is stripped from the upstream model id", () => {
		expect(toResponsesRequest({ ...base, model: "gpt-6-astra[1m]" }, OPTS).model).toBe(
			"gpt-6-astra",
		);
		expect(toResponsesRequest({ ...base, model: "claude-opus-5[1m]" }, OPTS).model).toBe(
			"gpt-6-astra",
		);
	});
});
