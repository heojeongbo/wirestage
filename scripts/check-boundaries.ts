/** `pnpm fsd:check`: the rules of scripts/boundaries.ts, over `src`. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { checkBoundaries } from "./boundaries.js";

const root = resolve("src");
const files = new Map(
	readdirSync(root, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => [
			file.split(sep).join("/"),
			readFileSync(resolve(root, file), "utf8"),
		]),
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
