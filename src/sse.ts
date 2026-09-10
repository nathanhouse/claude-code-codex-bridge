// HAL-ID: #HAL-20260910-2122-NH-7L
// Description: Incremental Server-Sent Events decoder (WHATWG framing: LF/CR/CRLF, multi-line data, comments) with a hard line cap.

export class SseTooLargeError extends Error {
	constructor(bytes: number, max: number) {
		super(`upstream event too large (${bytes} > ${max} bytes)`);
		this.name = "SseTooLargeError";
	}
}

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface SseDecoderOptions {
	/** Maximum bytes a single line (or a partial line waiting for its end) may hold. */
	maxLineBytes?: number;
}

/**
 * Feed chunks (bytes or text) with `push()`; complete events come back as they are framed.
 * Call `end()` at EOF — it reports whether a frame was left unterminated (never dispatches it).
 */
export class SseDecoder {
	private readonly max: number;
	private readonly decoder = new TextDecoder("utf-8");
	private buf = "";
	private eventName: string | undefined;
	private id: string | undefined;
	private dataLines: string[] = [];

	constructor(opts: SseDecoderOptions = {}) {
		this.max = opts.maxLineBytes ?? 1024 * 1024;
	}

	push(chunk: string | Uint8Array): SseEvent[] {
		this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		const out: SseEvent[] = [];
		for (;;) {
			const cut = this.nextLineEnd();
			if (cut === null) break;
			const line = this.buf.slice(0, cut.at);
			this.buf = this.buf.slice(cut.at + cut.len);
			this.guard(line);
			const ev = this.line(line);
			if (ev) out.push(ev);
		}
		this.guard(this.buf); // a partial line must not grow without bound
		return out;
	}

	end(): { events: SseEvent[]; unterminated: boolean } {
		const tail = this.decoder.decode(); // flush any dangling multi-byte sequence
		if (tail) this.buf += tail;
		const unterminated = this.buf.length > 0 || this.dataLines.length > 0;
		this.buf = "";
		this.dataLines = [];
		return { events: [], unterminated };
	}

	private guard(s: string): void {
		const bytes = Buffer.byteLength(s, "utf8");
		if (bytes > this.max) throw new SseTooLargeError(bytes, this.max);
	}

	/** Index of the next line terminator; holds back a trailing CR that may be half of CRLF. */
	private nextLineEnd(): { at: number; len: number } | null {
		for (let i = 0; i < this.buf.length; i++) {
			const c = this.buf.charCodeAt(i);
			if (c === 10) return { at: i, len: 1 };
			if (c === 13) {
				if (i + 1 >= this.buf.length) return null;
				return { at: i, len: this.buf.charCodeAt(i + 1) === 10 ? 2 : 1 };
			}
		}
		return null;
	}

	private line(line: string): SseEvent | null {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return null;
		const colon = line.indexOf(":");
		// A line with no colon is a field name with an empty value.
		const field = colon === -1 ? line : line.slice(0, colon);
		const rest = colon === -1 ? "" : line.slice(colon + 1);
		const value = rest.startsWith(" ") ? rest.slice(1) : rest;
		switch (field) {
			case "event":
				this.eventName = value;
				break;
			case "data":
				this.dataLines.push(value);
				break;
			case "id":
				this.id = value;
				break;
			default:
				break; // retry + unknown fields ignored
		}
		return null;
	}

	private dispatch(): SseEvent | null {
		const eventName = this.eventName;
		const dataLines = this.dataLines;
		// Per spec the event name resets at every dispatch, data included or not; `id` persists.
		this.eventName = undefined;
		this.dataLines = [];
		if (dataLines.length === 0) return null;
		const ev: SseEvent = { data: dataLines.join("\n") };
		if (eventName !== undefined) ev.event = eventName;
		if (this.id !== undefined) ev.id = this.id;
		return ev;
	}
}
