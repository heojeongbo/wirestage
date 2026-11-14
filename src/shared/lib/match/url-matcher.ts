import { WirestageError } from "../errors/index.js";

/**
 * What a rule matches: a glob, a RegExp over the full URL, or a predicate.
 *
 * Globs follow Playwright's routing semantics (`*` stops at `/`, `**` does
 * not, a `**` directory may be absent, `{a,b}` alternates), with one
 * addition: a glob that starts with `/` matches the PATH on any origin, and
 * so ignores the query. A stub for `/api/...` means the same thing on the
 * dev server, the preview build and CI, whose origins all differ.
 */
export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

export function compileUrlMatcher(matcher: UrlMatcher): (url: URL) => boolean {
	if (typeof matcher === "function") return matcher;
	if (matcher instanceof RegExp) {
		return (url) => {
			// A /g or /y RegExp is stateful: without the reset every other
			// request to the same URL would miss.
			matcher.lastIndex = 0;
			return matcher.test(url.href);
		};
	}
	const pattern = globToRegExp(matcher);
	if (!matcher.startsWith("/")) return (url) => pattern.test(url.href);
	if (matcher.includes("?"))
		// It would compile, and then never match anything.
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`"${matcher}" matches the path, which has no query: drop the "?…", or match the whole URL ("**${matcher}")`,
		);
	return (url) => pattern.test(url.pathname);
}

/** Characters with a meaning in a RegExp: escaped wherever a glob means them literally. */
const SPECIAL = /[.*+?^${}()|[\]\\/]/;

/** Translate a glob into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${globSource(glob).source}$`);
}

/** A glob as RegExp source (unanchored), and the params it captures, in order. */
export interface GlobSource {
	readonly source: string;
	readonly params: readonly string[];
}

/**
 * The RegExp source of a glob. With `params`, a `:name` (a letter or `_`,
 * then word characters) matches one segment and captures it: the routes of a
 * REST plugin, in the same glob language as every other pattern.
 */
export function globSource(
	glob: string,
	options: { readonly params?: boolean } = {},
): GlobSource {
	const params: string[] = [];
	let source = "";
	let inGroup = false;
	for (let i = 0; i < glob.length; i++) {
		const char = glob.charAt(i);
		if (char === "\\" && i + 1 < glob.length) {
			source += escapeChar(glob.charAt(++i));
		} else if (char === "*") {
			if (glob.charAt(i + 1) !== "*") {
				source += "[^/]*";
			} else if (glob.charAt(i + 2) === "/") {
				// `a/**/b` matches `a/b` too: the directories may be none.
				source += "(?:.+/)?";
				i += 2;
			} else {
				source += ".*";
				i++;
			}
		} else if (char === "{") {
			inGroup = true;
			source += "(?:";
		} else if (char === "}" && inGroup) {
			inGroup = false;
			source += ")";
		} else if (char === "," && inGroup) {
			source += "|";
		} else if (char === ":" && options.params) {
			// `:8080` in an origin is not a param: a name starts with a letter.
			const name = /^[A-Za-z_]\w*/.exec(glob.slice(i + 1))?.[0];
			if (name === undefined) source += char;
			else {
				params.push(name);
				source += "([^/]+)";
				i += name.length;
			}
		} else {
			source += escapeChar(char);
		}
	}
	if (inGroup)
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`glob "${glob}" opens a "{" it never closes; write a literal brace as "\\{"`,
		);
	return { source, params };
}

function escapeChar(char: string): string {
	return SPECIAL.test(char) ? `\\${char}` : char;
}
