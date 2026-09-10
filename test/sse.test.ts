// HAL-ID: #HAL-20260910-2119-NH-PC
// Description: T13 + T20 — incremental SSE decoder framing and caps (spec v2 § Response, § Security/NFR)
import { describe, expect, test } from "bun:test";
import { SseDecoder, SseTooLargeError } from "../src/sse";

const enc = new TextEncoder();

/** The T3 byte stream as one string (LF endings). */
const T3_STREAM = [
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra"}}\n\n',
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"}}\n\n',
	'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"po"}\n\n',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"ng"}\n\n',
	'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"pong"}],"role":"assistant"}}\n\n',
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":2}}}\n\n',
];

function decodeAll(chunks: (string | Uint8Array)[]) {
	const d = new SseDecoder();
	const out = [];
	for (const c of chunks) out.push(...d.push(c));
	const tail = d.end();
	return { events: out.concat(tail.events), unterminated: tail.unterminated };
}

const expectedTypes = [
	"response.created",
	"response.output_item.added",
	"response.content_part.added",
	"response.output_text.delta",
	"response.output_text.delta",
	"response.output_item.done",
	"response.completed",
];

describe("T13 SSE framing", () => {
	test("whole events, one per chunk", () => {
		const { events, unterminated } = decodeAll(T3_STREAM);
		expect(events.map((e) => e.event)).toEqual(expectedTypes);
		expect(JSON.parse(events[3]?.data ?? "").delta).toBe("po");
		expect(unterminated).toBe(false);
	});

	test("(a) split mid-JSON across chunks, as bytes", () => {
		const whole = T3_STREAM.join("");
		const bytes = enc.encode(whole);
		const cut = whole.indexOf('"delta":"po') + 5; // inside the JSON of event 4
		const { events } = decodeAll([bytes.slice(0, cut), bytes.slice(cut)]);
		expect(events.map((e) => e.event)).toEqual(expectedTypes);
		expect(JSON.parse(events[3]?.data ?? "").delta).toBe("po");
	});

	test("(b) two events in one chunk", () => {
		const { events } = decodeAll([
			(T3_STREAM[0] ?? "") + (T3_STREAM[1] ?? ""),
			...T3_STREAM.slice(2),
		]);
		expect(events.map((e) => e.event)).toEqual(expectedTypes);
	});

	test("(c) CRLF line endings", () => {
		const crlf = T3_STREAM.map((s) => s.replace(/\n/g, "\r\n"));
		const { events } = decodeAll(crlf);
		expect(events.map((e) => e.event)).toEqual(expectedTypes);
		expect(JSON.parse(events[6]?.data ?? "").response.usage.output_tokens).toBe(2);
	});

	test("(d) multi-line data joined with \\n", () => {
		const { events } = decodeAll(["event: x\ndata: line1\ndata: line2\n\n"]);
		expect(events).toEqual([{ event: "x", data: "line1\nline2" }]);
	});

	test("(e) comment lines ignored, blank-only frames dispatch nothing", () => {
		const { events } = decodeAll([": keepalive\n\n", ": another\n", T3_STREAM[0] ?? ""]);
		expect(events.map((e) => e.event)).toEqual(["response.created"]);
	});

	test("(f) EOF with unterminated final frame → complete events then unterminated=true", () => {
		const last = T3_STREAM[6] ?? "";
		const { events, unterminated } = decodeAll([
			...T3_STREAM.slice(0, 6),
			last.slice(0, last.length - 2),
		]);
		expect(events.length).toBe(6);
		expect(unterminated).toBe(true);
	});

	test("multi-byte UTF-8 split across chunks survives", () => {
		const s = 'data: {"delta":"é✓"}\n\n';
		const bytes = enc.encode(s);
		const cut = bytes.indexOf(0xc3) + 1; // split inside "é"
		const { events } = decodeAll([bytes.slice(0, cut), bytes.slice(cut)]);
		expect(JSON.parse(events[0]?.data ?? "").delta).toBe("é✓");
	});
});

describe("T20 upstream caps", () => {
	test("a single data line over the cap throws SseTooLargeError", () => {
		const d = new SseDecoder({ maxLineBytes: 1024 });
		const big = `data: ${"x".repeat(5000)}\n\n`;
		expect(() => d.push(big)).toThrow(SseTooLargeError);
	});

	test("cap applies across chunks (no unbounded buffering)", () => {
		const d = new SseDecoder({ maxLineBytes: 1024 });
		expect(() => {
			for (let i = 0; i < 10; i++) d.push("y".repeat(300)); // 3000 bytes, no newline yet
		}).toThrow(SseTooLargeError);
	});
});
