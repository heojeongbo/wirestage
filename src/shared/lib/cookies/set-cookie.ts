/** A cookie the way a browser context stores one: Playwright's `addCookies` shape. */
export interface CookieInit {
	readonly name: string;
	readonly value: string;
	/** A leading dot covers subdomains, as Playwright spells it; none is host-only. */
	readonly domain: string;
	readonly path: string;
	/** Seconds since the epoch; absent for a session cookie. */
	readonly expires?: number;
	readonly httpOnly: boolean;
	readonly secure: boolean;
	readonly sameSite?: "Strict" | "Lax" | "None";
}

/** The latest expiry a browser context accepts: 9999-12-31, in seconds. */
const MAX_EXPIRES = 253_402_300_799;

/**
 * One `Set-Cookie` line, stored the way a browser would store it for a response
 * from `url` (RFC 6265 §5.2-5.3): `Domain` covers subdomains and no `Domain`
 * is host-only, no `Path` is the request path's directory, and `Max-Age` beats
 * `Expires`. Undefined for a line a browser would ignore: one with no cookie
 * name, or with a `Domain` the responding host does not belong to.
 */
export function parseSetCookie(
	line: string,
	url: string,
	now: number = Date.now(),
): CookieInit | undefined {
	const [pair = "", ...attributes] = line.split(";");
	const eq = pair.indexOf("=");
	const name = eq < 0 ? "" : pair.slice(0, eq).trim();
	if (name === "") return undefined;
	const target = new URL(url);
	let domain = target.hostname;
	let path = defaultPath(target.pathname);
	let expires: number | undefined;
	let maxAge: number | undefined;
	let httpOnly = false;
	let secure = false;
	let sameSite: CookieInit["sameSite"];
	for (const attribute of attributes) {
		const at = attribute.indexOf("=");
		const key = (at < 0 ? attribute : attribute.slice(0, at))
			.trim()
			.toLowerCase();
		const value = at < 0 ? "" : attribute.slice(at + 1).trim();
		if (key === "domain" && value !== "") {
			const covered = value.replace(/^\./, "").toLowerCase();
			const host = target.hostname.toLowerCase();
			// A server may not set a cookie for a site it is not part of.
			if (host !== covered && !host.endsWith(`.${covered}`)) return undefined;
			domain = `.${covered}`;
		} else if (key === "path" && value.startsWith("/")) path = value;
		// A date names its month; a bare number is not one, though
		// `Date.parse` would take "1" for the year 2001.
		else if (
			key === "expires" &&
			/[a-z]{3}/i.test(value) &&
			!Number.isNaN(Date.parse(value))
		)
			expires = Math.floor(Date.parse(value) / 1000);
		else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
		else if (key === "httponly") httpOnly = true;
		else if (key === "secure") secure = true;
		else if (key === "samesite") sameSite = sameSiteOf(value) ?? sameSite;
	}
	const wanted =
		maxAge === undefined ? expires : Math.floor(now / 1000) + maxAge;
	// A context takes a positive timestamp only: one second past the epoch
	// is "long expired", which is how a server deletes a cookie.
	const until =
		wanted === undefined
			? undefined
			: Math.min(Math.max(wanted, 1), MAX_EXPIRES);
	return {
		name,
		value: pair.slice(eq + 1).trim(),
		domain,
		path,
		...(until === undefined ? {} : { expires: until }),
		httpOnly,
		secure,
		...(sameSite === undefined ? {} : { sameSite }),
	};
}

function sameSiteOf(value: string): CookieInit["sameSite"] {
	switch (value.toLowerCase()) {
		case "strict":
			return "Strict";
		case "lax":
			return "Lax";
		case "none":
			return "None";
		default:
			return undefined;
	}
}

/** RFC 6265 §5.1.4: the request path up to, and not including, its last "/". */
function defaultPath(pathname: string): string {
	const last = pathname.lastIndexOf("/");
	return last <= 0 ? "/" : pathname.slice(0, last);
}
