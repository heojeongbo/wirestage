import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { RestPath } from "../model/types.js";

export interface PathMatcher {
	/** The `:name` params when `url` matches, undefined when it does not. */
	match(url: URL): Record<string, string> | undefined;
}

const SPECIAL = /[.+?^${}()|[\]\\]/g;

/**
 * `/rooms/:id/files/*` against a URL's path, or — for a pattern that starts
 * with a scheme — against origin plus path. `*` is one segment and `**` any
 * number of them, as in every other pattern the library takes. The query
 * never takes part: a route for `/search` should answer `/search?q=x`.
 */
export function compilePath(
	path: RestPath,
	baseURL: string | undefined,
): PathMatcher {
	if (path instanceof RegExp)
		return {
			match(url) {
				path.lastIndex = 0;
				const found = path.exec(url.pathname);
				return found === null ? undefined : { ...found.groups };
			},
		};
	if (path.includes("?"))
		// It would compile, and then never match anything.
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`route "${path}" names a query, and a route matches the path alone: drop the "?…" and check \`request.query\` in the resolver or in \`match\``,
		);
	const full = joinBase(baseURL, path);
	const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(full);
	const keys: string[] = [];
	const source = full
		.replace(SPECIAL, (char) => `\\${char}`)
		.replace(/\*\*|\*|:([A-Za-z_]\w*)/g, (token, key: string | undefined) => {
			if (token === "**") return ".*";
			if (key === undefined) return "[^/]*";
			keys.push(key);
			return "([^/]+)";
		});
	const pattern = new RegExp(`^${source}/?$`);
	return {
		match(url) {
			const subject = absolute ? `${url.origin}${url.pathname}` : url.pathname;
			const found = pattern.exec(subject);
			if (found === null) return undefined;
			const params: Record<string, string> = {};
			keys.forEach((key, index) => {
				params[key] = decode(found[index + 1] as string);
			});
			return params;
		},
	};
}

/**
 * A path segment, percent-decoded. A malformed escape is kept as it came:
 * this runs for every request of the context, and must not throw for one
 * odd URL.
 */
function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function joinBase(baseURL: string | undefined, path: string): string {
	if (baseURL === undefined || /^[a-z][a-z\d+.-]*:\/\//i.test(path))
		return path;
	return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
