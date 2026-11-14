# Agent contract

Read [`CLAUDE.md`](CLAUDE.md) first — it holds the rules. This file is what an
agent has to *do*.

## Before changing anything

1. Read `CLAUDE.md` and the doc for the area: [`docs/architecture.md`](docs/architecture.md)
   for any new file, the protocol's page under [`docs/protocols/`](docs/protocols/),
   [`docs/plugins.md`](docs/plugins.md) for plugin work.
2. Work in the devcontainer: `devcontainer up --workspace-folder .`, then
   `devcontainer exec --workspace-folder . <command>`.

## The gate — run all of it before reporting done

```sh
pnpm check            # lint, boundaries, types, coverage 100%, build, docs, package
pnpm check:browser    # browser tests, e2e against the build, performance budgets
```

Do not report success on a partial run. If a step fails and you cannot fix it,
say which step, paste the output, and say what you tried.

## Releasing

1. Bump `version` in `package.json` and add the `CHANGELOG.md` entry.
2. `pnpm check` and `pnpm check:browser` in the devcontainer, then push and
   wait for CI to pass on that commit.
3. From a clean checkout of exactly that commit, with the built `dist`:
   `npm publish --ignore-scripts` (the gates already ran; `.npmrc` reads the
   token from `NPM_TOKEN`).
4. Tag the published commit and push the tag:
   `git tag -a vX.Y.Z <sha> -m "wirestage X.Y.Z"`, `git push origin vX.Y.Z`.
   Every release gets its tag; check it against `npm view
   @heojeongbo/wirestage@X.Y.Z gitHead`.

## Adding a protocol

1. `src/features/<name>/` with `model/types.ts` (the public API), `lib/`
   (the plugin, built only from `PluginContext`) and `index.ts`. Record
   frames under `context.name`, so `named()` works.
2. `src/<name>.ts` re-exporting the slice, a `./<name>` entry in
   `package.json` `exports`, and an import in `scripts/check-package.mjs`.
3. Unit tests to 100% against `src/__fixtures__`; a case in
   `tests/browser/protocols.test.ts`; a test in `e2e/`; a scenario in
   `scripts/perf.ts` if the protocol has a hot path.
4. `docs/protocols/<name>.md`, the table in `README.md`, `CHANGELOG.md`.

A capability the protocol needs from the browser that no service gives is a
change to the contract (`src/entities/plugin`) and its engine
(`src/widgets/stage`), not a way around them.

## Things not to do

- Do not import Playwright outside `src/app/playwright`, or Connect outside
  `src/features/connect`.
- Do not hand a plugin the browser context, a `Route`, or a Node type.
- Do not hand-encode a protocol a library already implements; stubs reuse
  connect-es's handlers for exactly this reason.
- Do not add a branch to reach coverage; restructure instead.
- Do not change a fake to make a unit test pass; check what the browser does
  (`tests/browser`) and make the fake agree with it.
- Do not silence a lint or a boundary rule. The one exception in the code
  carries its reason; meet that standard or fix the code.
- Do not commit `.npmrc`; publishing reads the token from `NPM_TOKEN`
  (`.npmrc.example`).
- Do not edit `src/__fixtures__/gen` by hand; run `pnpm gen:proto`.
