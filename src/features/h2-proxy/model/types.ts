import type { H2ProxyServerOptions } from "../../../shared/api/h2-proxy/index.js";

/**
 * Where the proxy listens, its certificate, and what it does to the
 * documents it carries. Every field is optional.
 */
export type H2ProxyOptions = H2ProxyServerOptions;

export interface H2Proxy {
	/** `https://<host>:<port>`: the proxy speaks TLS, as Chromium wants of an h2 proxy. */
	readonly url: string;
	readonly port: number;
	/** The flags that send a Chromium's requests here: {@link h2ProxyArgs} for this proxy. */
	readonly chromiumArgs: readonly string[];
	/** Stop, dropping open connections at once. */
	close(): Promise<void>;
}
