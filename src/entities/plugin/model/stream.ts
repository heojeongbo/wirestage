/** How an open response ended. */
export type StreamEnd =
	/** The rule ended it cleanly. */
	| "ended"
	/** The rule reset the connection. */
	| "cut"
	/** The page went away: it closed the stream, navigated, or was closed. */
	| "cancelled";

/**
 * A response that stays open, written at the test's pace: what a server
 * stream, an event stream or a long poll is made of. A rule gets one by
 * answering `{ type: "stream" }`.
 */
export interface ResponseStream {
	/**
	 * The request's headers as the server received them, names lower-cased.
	 * They include what the browser's network stack adds after Playwright's
	 * route has seen the request, such as `last-event-id`.
	 */
	readonly requestHeaders: Readonly<Record<string, string>>;
	/**
	 * Set the status and headers. They go out with the first `write`, or at
	 * once on `flush`. Without a call the response is a bare 200.
	 */
	head(status: number, headers?: Readonly<Record<string, string>>): void;
	/** Send the head now, before any body: an EventSource opens on it. */
	flush(): void;
	/**
	 * Write a chunk. Resolves once it is handed to the socket; rejects with
	 * `CLOSED` when the response is over.
	 */
	write(chunk: Uint8Array | string): Promise<void>;
	/** End the response cleanly. Resolves once it is closed. */
	end(): Promise<void>;
	/**
	 * Reset the connection mid-response: no terminator, no trailer — what a
	 * network drop looks like to the page.
	 */
	cut(): void;
	/** Resolves when the response is over, with how. */
	readonly closed: Promise<StreamEnd>;
}
