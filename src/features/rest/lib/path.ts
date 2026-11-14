import { WirestageError } from "../../../shared/lib/errors/index.js";
import { globSource } from "../../../shared/lib/match/index.js";
import type { RestPath } from "../model/types.js";

export interface PathMatcher {
	/** The `:name` params when `url` matches, undefined when it does not. */
	match(url: URL): Record<string, string> | undefined;
}

/**
 * `/rooms/:id/files/*` against a URL's path, or — for a pattern that starts
 * with a scheme — against origin plus path. The glob is the one every other
 * pattern of the library takes (`*` one segment, `**` any number, none
 * included, `{a,b}` either), plus `:name` params. The query never takes
 * part: a route for `/search` should answer `/search?q=x`.
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
	const { source, params: keys } = globSource(full, { params: true });
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
