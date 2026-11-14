/**
 * Every ```ts block in README.md and docs/ is type-checked against the built
 * declarations, imported by package name exactly as a user would write it.
 * A renamed option or a changed signature breaks the docs build instead of a
 * reader's first copy-paste. Run after `pnpm build`.
 *
 * The blocks of one document are the files of one folder:
 *  - a block whose first line is `// <name>.ts` is that file, so later
 *    blocks can import what it exports (`./fixtures.js`);
 *  - `./gen/echo_pb.js` is the service generated from
 *    tests/proto/wirestage/test/v1/echo.proto, standing in for the reader's
 *    own generated code.
 *
 * A block that is deliberately partial starts with `// not checked`, and
 * says why: an unchecked example is a claim nobody verifies.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import ts from "typescript";

const GENERATED = resolve("src/__fixtures__/gen/wirestage/test/v1/echo_pb.js");

const sources = [
	"README.md",
	...readdirSync("docs", { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".md"))
		.map((name) => `docs/${name}`),
];
const virtual = new Map();
let unchecked = 0;
for (const source of sources) {
	// Inside the package root, so the package name resolves through its own
	// `exports` to dist/ — the user's view, not the source tree's.
	const folder = resolve(".docs-check", source.replaceAll("/", "_"));
	const content = readFileSync(source, "utf8");
	let index = 0;
	for (const match of content.matchAll(/```ts\n([\s\S]*?)```/g)) {
		const code = match[1];
		index += 1;
		if (code.startsWith("// not checked")) {
			unchecked += 1;
			continue;
		}
		const named = /^\/\/ ([\w-]+\.ts)\n/.exec(code)?.[1];
		virtual.set(resolve(folder, named ?? `block-${index}.ts`), code);
	}
	const generated = resolve(folder, "gen/echo_pb.ts");
	virtual.set(
		generated,
		`export * from "${relative(dirname(generated), GENERATED).replaceAll("\\", "/")}";`,
	);
}
const options = {
	strict: true,
	noEmit: true,
	skipLibCheck: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	moduleDetection: ts.ModuleDetectionKind.Force,
	lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
	types: ["node"],
};
// The folders exist only here: without them the compiler does not look for
// the files a block imports from beside it.
const folders = new Set();
for (const file of virtual.keys())
	for (
		let folder = dirname(file);
		folder.startsWith(resolve(".docs-check"));
		folder = dirname(folder)
	)
		folders.add(folder);
const host = ts.createCompilerHost(options);
const read = host.readFile.bind(host);
const exists = host.fileExists.bind(host);
const directoryExists = host.directoryExists?.bind(host);
host.readFile = (file) => virtual.get(file) ?? read(file);
host.fileExists = (file) => virtual.has(file) || exists(file);
host.directoryExists = (folder) =>
	folders.has(folder) || (directoryExists?.(folder) ?? true);
const program = ts.createProgram([...virtual.keys()], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
	console.error(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => "\n",
		}),
	);
	process.exitCode = 1;
} else
	console.log(
		`Documentation examples passed (${virtual.size - sources.length} TypeScript blocks, ${unchecked} not checked).`,
	);
