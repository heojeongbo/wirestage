import type { SseEvent } from "../model/types.js";

/**
 * Encode one event in the text/event-stream format. Multi-line data becomes
 * several `data:` lines — a single line with an embedded newline would end
 * the field early and the client would see half the payload.
 */
export function encodeSseEvent(event: SseEvent | string): string {
	if (typeof event === "string") return `${dataLines(event)}\n`;
	let out = "";
	if (event.comment !== undefined)
		for (const line of event.comment.split(/\r?\n/)) out += `: ${line}\n`;
	if (event.event !== undefined) out += `event: ${event.event}\n`;
	if (event.id !== undefined) out += `id: ${event.id}\n`;
	if (event.retry !== undefined) out += `retry: ${event.retry}\n`;
	if (event.data !== undefined)
		out += dataLines(
			typeof event.data === "string" ? event.data : JSON.stringify(event.data),
		);
	return `${out}\n`;
}

function dataLines(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `data: ${line}\n`)
		.join("");
}
