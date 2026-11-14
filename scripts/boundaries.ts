/**
 * Architecture rules, enforced rather than reviewed. See docs/architecture.md,
 * which numbers them the same way.
 *
 * Structure:
 *  S1. Every file under `src` is TypeScript (`.ts`, `.mts`, `.cts`, `.tsx`),
 *      and is a package entrypoint (`src/<name>.ts`) or sits in a unit: a
 *      slice `<layer>/<slice>/…`, or a shared module
 *      `shared/<api|lib>/<module>/…`.
 *  S2. A unit has one `index.ts`, at its root: its public API.
 *  S3. A slice holds `index.ts` and FSD segments (`api`, `config`, `lib`,
 *      `model`, `ui`); an entity may also hold `@x`.
 *
 * Feature-Sliced Design:
 *  1. Layers import downward only: app → widgets → features → entities → shared.
 *  2. Slices of one layer do not import each other, except through FSD's
 *     cross-import notation between entities: `entities/<a>` may import
 *     `entities/<b>/@x/<a>.js`, and nobody else may.
 *  3. Anything outside a unit goes through its `index.js`; anything inside
 *     goes around it. A unit re-exports only its own modules.
 *  4. In a slice, `model` (the types) does not import `lib` (the code).
 *  5. The core knows no protocol: only a package entrypoint imports a feature.
 *  6. `shared/lib` is pure: it does not import `shared/api`.
 *  7. An entrypoint is `export … from` statements and nothing else:
 *     `index.ts` re-exports what lies below the features, `playwright.ts`
 *     the fixture, `<name>.ts` the feature of that name.
 *
 * Clean architecture (the dependency rule for code that is not ours):
 *  8. Playwright is named only by `app/playwright`, and only as types.
 *  9. Connect and protobuf stay inside `features/connect`.
 * 10. log-palette stays inside `shared/lib/logger`.
 * 11. Node built-ins belong to `shared/api` and `features/connect`; a widget
 *     may name their types; nothing else names them at all.
 * 12. There is no other dependency.
 * 13. Below the stage, the only Playwright ports are `PagePort` and
 *     `CookieJarPort`, as types: a plugin is never handed the browser context.
 * 14. A module specifier is a string literal, and there is no `require`.
 *     `process.getBuiltinModule()` counts as an import.
 *
 * Tests and `__fixtures__` are not shipped and are not checked, but shipped
 * code may not import them.
 *
 * The checker reads syntax, not types: a type alias of a port, or a Node
 * global such as `Buffer`, is not traced.
 */
import { builtinModules } from "node:module";
import { posix } from "node:path";

import ts from "typescript";

const LAYERS = ["shared", "entities", "features", "widgets", "app"];
const SEGMENTS = new Set(["api", "config", "lib", "model", "ui"]);
const SHARED_SEGMENTS = new Set(["api", "lib"]);
/** The ports a plugin may be written against (rule 13). */
const PLUGIN_PORTS = new Set(["PagePort", "CookieJarPort"]);

const isTestCode = (path: string): boolean =>
	/\.test\.[cm]?[jt]sx?$/.test(path) ||
	path.split("/").includes("__fixtures__");

const isTypeScript = (path: string): boolean => /\.[cm]?tsx?$/.test(path);

/** Where a path lives: its unit, and what is left of the path inside it. */
interface Place {
	readonly layer: string;
	readonly slice: string;
	readonly unit: string;
	readonly inside: readonly string[];
}

function placeOf(path: string): Place | undefined {
	const parts = path.split("/");
	const [layer = "", second = ""] = parts;
	const depth = layer === "shared" ? 3 : 2;
	if (!LAYERS.includes(layer) || parts.length <= depth) return undefined;
	if (layer === "shared" && !SHARED_SEGMENTS.has(second)) return undefined;
	return {
		layer,
		slice: second,
		unit: parts.slice(0, depth).join("/"),
		inside: parts.slice(depth),
	};
}

/** One place a file names another module. */
interface Reference {
	/** `undefined` when the specifier is not a string literal. */
	readonly specifier: string | undefined;
	/** Erased by the compiler: nothing is loaded at runtime. */
	readonly typeOnly: boolean;
	/** The names taken from the module; `undefined` for all of it. */
	readonly names: readonly string[] | undefined;
	readonly require: boolean;
	/** `export … from`: the file hands the module on as its own. */
	readonly reexport: boolean;
}

const literal = (node: ts.Node | undefined): string | undefined =>
	node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/**
 * Every reference in a file, wherever it is written: `import` and `export …
 * from` statements, `import x = require()`, `import()` calls, `require()`
 * calls and `import("…")` types. The whole tree is walked, because the
 * references a statement-level scan misses are exactly the ones nobody reads.
 */
function referencesOf(source: ts.SourceFile): Reference[] {
	const found: Reference[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const named =
				clause?.name === undefined &&
				clause?.namedBindings !== undefined &&
				ts.isNamedImports(clause.namedBindings)
					? clause.namedBindings.elements
					: undefined;
			found.push({
				specifier: literal(node.moduleSpecifier),
				// `import { type A }` is not: under `verbatimModuleSyntax` it is
				// emitted as `import {} from`, which still loads the module.
				typeOnly: clause?.isTypeOnly === true,
				names:
					clause === undefined
						? []
						: named?.map(
								(element) => (element.propertyName ?? element.name).text,
							),
				require: false,
				reexport: false,
			});
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			const named =
				node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
					? node.exportClause.elements
					: undefined;
			found.push({
				specifier: literal(node.moduleSpecifier),
				typeOnly: node.isTypeOnly,
				names: named?.map(
					(element) => (element.propertyName ?? element.name).text,
				),
				require: false,
				reexport: true,
			});
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			found.push({
				specifier: literal(node.moduleReference.expression),
				typeOnly: node.isTypeOnly,
				names: undefined,
				require: true,
				reexport: false,
			});
		} else if (ts.isImportTypeNode(node)) {
			let qualifier = node.qualifier;
			while (qualifier !== undefined && ts.isQualifiedName(qualifier))
				qualifier = qualifier.left;
			found.push({
				specifier: ts.isLiteralTypeNode(node.argument)
					? literal(node.argument.literal)
					: undefined,
				typeOnly: true,
				names: qualifier === undefined ? undefined : [qualifier.text],
				require: false,
				reexport: false,
			});
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
			const required = ts.isIdentifier(callee) && callee.text === "require";
			// `process.getBuiltinModule("node:fs")` loads a module as surely as
			// an import does.
			const builtin =
				ts.isPropertyAccessExpression(callee) &&
				callee.name.text === "getBuiltinModule";
			if (dynamic || required || builtin)
				found.push({
					specifier: literal(node.arguments[0]),
					typeOnly: false,
					names: undefined,
					require: required,
					reexport: false,
				});
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

const packageOf = (specifier: string): string =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");

const isBuiltin = (specifier: string): boolean =>
	specifier.startsWith("node:") ||
	builtinModules.includes(packageOf(specifier));

/** Rules 8-12: what a file may take from outside the package. */
function checkPackage(
	from: Place | undefined,
	reference: Reference,
	specifier: string,
): string | undefined {
	const name = packageOf(specifier);
	if (from === undefined)
		return "an entrypoint only re-exports public APIs (rule 7)";
	if (isBuiltin(specifier)) {
		if (
			from.unit.startsWith("shared/api/") ||
			from.unit === "features/connect" ||
			(from.layer === "widgets" && reference.typeOnly)
		)
			return undefined;
		return from.layer === "widgets"
			? "a widget may name Node's types, not load its modules (rule 11)"
			: "Node built-ins belong to shared/api and features/connect (rule 11)";
	}
	if (["@playwright/test", "playwright", "playwright-core"].includes(name)) {
		if (from.unit !== "app/playwright")
			return "Playwright is named only by app/playwright (rule 8)";
		return reference.typeOnly
			? undefined
			: "Playwright is imported only as types (rule 8)";
	}
	if (name.startsWith("@connectrpc/") || name === "@bufbuild/protobuf")
		return from.unit === "features/connect"
			? undefined
			: "Connect and protobuf belong to features/connect (rule 9)";
	if (name === "@heojeongbo/log-palette")
		return from.unit === "shared/lib/logger"
			? undefined
			: "log-palette belongs to shared/lib/logger (rule 10)";
	return "not a dependency of the library (rule 12)";
}

/** Rule 7: which units an entrypoint is the public face of. */
function entrypointMay(entrypoint: string, to: Place): boolean {
	if (entrypoint === "index.ts")
		return to.layer !== "features" && to.layer !== "app";
	if (entrypoint === "playwright.ts") return to.unit === "app/playwright";
	return to.unit === `features/${entrypoint.replace(/\.ts$/, "")}`;
}

/** Rules 1-7 and 13: what a file may take from inside the package. */
function checkModule(
	file: string,
	from: Place | undefined,
	reference: Reference,
	target: string,
): string | undefined {
	if (target.startsWith("..")) return "leaves src";
	if (isTestCode(target)) return "shipped code may not import test code";
	const to = placeOf(target);
	const isIndex = to?.inside.length === 1 && to.inside[0] === "index.js";
	if (from === undefined) {
		if (to === undefined || !isIndex)
			return "an entrypoint imports a unit's index.js (rule 3)";
		return entrypointMay(file, to)
			? undefined
			: "not a unit this entrypoint is the public face of (rule 7)";
	}
	if (to === undefined) return "not a module of a unit (rule S1)";
	if (LAYERS.indexOf(to.layer) > LAYERS.indexOf(from.layer))
		return "upward dependency (rule 1)";
	const crossImport = to.inside[0] === "@x";
	if (from.unit === to.unit) {
		if (isIndex) return "a unit does not import its own index.js (rule 3)";
		if (crossImport)
			return "an @x file is for the entity it is named after (rule 2)";
		if (
			from.layer !== "shared" &&
			from.inside[0] === "model" &&
			to.inside[0] === "lib"
		)
			return "model does not import lib (rule 4)";
		return undefined;
	}
	if (reference.reexport)
		return "a unit re-exports only its own modules (rule 3)";
	if (crossImport)
		return from.layer === "entities" &&
			to.layer === "entities" &&
			to.inside.length === 2 &&
			to.inside[1] === `${from.slice}.js`
			? undefined
			: "an @x file is for the entity it is named after (rule 2)";
	if (from.layer === to.layer && from.layer !== "shared")
		return "cross-slice import (rule 2)";
	if (to.layer === "features")
		return "only a package entrypoint imports a feature (rule 5)";
	if (from.unit.startsWith("shared/lib/") && to.unit.startsWith("shared/api/"))
		return "shared/lib does not import shared/api (rule 6)";
	if (!isIndex) return "bypasses the public API: import index.js (rule 3)";
	if (
		to.unit === "shared/api/playwright" &&
		(from.layer === "entities" || from.layer === "features") &&
		!(
			reference.typeOnly &&
			reference.names?.every((name) => PLUGIN_PORTS.has(name))
		)
	)
		return "below the stage, only the PagePort and CookieJarPort types (rule 13)";
	return undefined;
}

/** Rules S1-S3: where files may be. */
function checkStructure(paths: readonly string[]): string[] {
	const errors: string[] = [];
	const units = new Set<string>();
	for (const path of paths) {
		if (!isTypeScript(path)) {
			errors.push(`${path} — src holds TypeScript only (rule S1)`);
			continue;
		}
		if (!path.includes("/")) continue;
		const place = placeOf(path);
		if (place === undefined) {
			errors.push(`${path} — not in a unit (rule S1)`);
			continue;
		}
		units.add(place.unit);
		const [first = "", ...rest] = place.inside;
		if (path.endsWith("/index.ts") && rest.length > 0)
			errors.push(`${path} — a unit has one index.ts, at its root (rule S2)`);
		if (place.layer === "shared" || (first === "index.ts" && rest.length === 0))
			continue;
		const crossImport =
			first === "@x" && place.layer === "entities" && rest.length === 1;
		if (!crossImport && !(SEGMENTS.has(first) && rest.length > 0))
			errors.push(
				`${path} — a slice holds index.ts and the segments ${[...SEGMENTS].join(", ")} (rule S3)`,
			);
	}
	for (const unit of units)
		if (!paths.includes(`${unit}/index.ts`))
			errors.push(`${unit} — has no index.ts (rule S2)`);
	return errors;
}

/**
 * Checks a source tree against the rules above.
 *
 * @param files source text by path, relative to `src`, with `/` separators.
 * @returns one line per violation; empty when the tree conforms.
 */
export function checkBoundaries(files: ReadonlyMap<string, string>): string[] {
	const shipped = [...files.keys()].filter((path) => !isTestCode(path)).sort();
	const errors = checkStructure(shipped);
	for (const file of shipped) {
		const from = placeOf(file);
		// A misplaced file was reported above; its imports have no rules to
		// be held to.
		if (!isTypeScript(file) || (from === undefined && file.includes("/")))
			continue;
		const source = ts.createSourceFile(
			file,
			files.get(file) as string,
			ts.ScriptTarget.Latest,
		);
		if (from === undefined)
			for (const statement of source.statements)
				if (
					!ts.isExportDeclaration(statement) ||
					statement.moduleSpecifier === undefined
				)
					errors.push(
						`${file} — an entrypoint is export … from statements only (rule 7)`,
					);
		for (const reference of referencesOf(source)) {
			const { specifier } = reference;
			const where = `${file}: ${specifier === undefined ? "(computed)" : `"${specifier}"`}`;
			if (reference.require) errors.push(`${where} — no require (rule 14)`);
			if (specifier === undefined) {
				errors.push(`${where} — a specifier is a string literal (rule 14)`);
				continue;
			}
			const error = specifier.startsWith(".")
				? checkModule(
						file,
						from,
						reference,
						posix.normalize(posix.join(posix.dirname(file), specifier)),
					)
				: checkPackage(from, reference, specifier);
			if (error !== undefined) errors.push(`${where} — ${error}`);
		}
	}
	return errors;
}
