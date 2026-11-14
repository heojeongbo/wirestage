/** `pnpm fsd:check`: the rules of scripts/boundaries.ts, over `src`. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { checkBoundaries } from "./boundaries.js";

const root = resolve("src");
// Every file, not every `.ts` file: a module the checker never reads is a
// module it lets through.
const files = new Map(
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return [
				relative(root, path).split(sep).join("/"),
				readFileSync(path, "utf8"),
			];
		}),
);
const errors = checkBoundaries(files);

if (errors.length > 0) {
	process.stderr.write(
		`Architecture boundaries failed:\n${errors.map((error) => `  ${error}`).join("\n")}\n`,
	);
	process.exitCode = 1;
} else {
	process.stdout.write(
		`Architecture boundaries passed (${files.size} source files).\n`,
	);
}
