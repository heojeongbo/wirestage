# Testing

Five levels, each catching what the others cannot.

| Level | Command | Runs | Catches |
| --- | --- | --- | --- |
| Unit | `pnpm test` | every module against fakes of the Playwright ports, real Node servers and real Connect clients; the boundary checker against a tree of violations | logic, every branch: **coverage is 100% per file** for statements, branches, functions and lines, enforced by `pnpm test:coverage` |
| Types | `pnpm type:check` | `tests/types/*.ts` | API inference (`stage.<plugin>`, `named`, `use`), misuse that must not compile, and that real Playwright objects satisfy the ports |
| Browser | `pnpm test:browser` | `tests/browser` in real Chromium through the Playwright library | that the fakes were right about Playwright and Chromium: concurrent requests, `continue({ url })`, more open streams than a browser allows one host, WebSocket closes against a real server, iframes, data channels |
| E2E | `pnpm e2e` | `e2e/` in the Playwright Test runner, importing the package by name | the published build (`dist/`, through `exports`) where users run it — including the page code as tsc emits it; doubles as examples |
| Performance | `pnpm perf:check`, `pnpm bench` | `scripts/perf.ts`, `bench/` | regressions against budgets ([performance.md](performance.md)) |

Coverage does not depend on a browser, so `pnpm check` stays meaningful on a
machine without one; `pnpm check:browser` runs the three browser levels.
`pnpm e2e` builds first: it tests what would be published, not the source.

`pnpm check` also runs `pnpm docs:check`, which type-checks every `ts` block
in the README and `docs/` against the built package, and `pnpm package:check`,
which installs the packed tarball into an empty project and loads it with
`import` and with `require`, with and without the optional peers.

## Rules

- Comment an assertion with the bug it prevents when that is not obvious.
- A fake is only as good as its agreement with the browser. When a browser
  test shows a fake was wrong, fix the fake first, then the code.
- A branch only a real browser can reach is a sign the logic belongs behind a
  port. Unreachable defensive code is deleted, not covered with contortions.
- Code that runs in the page is tested twice: called directly (so it counts
  for coverage) and rebuilt from its source (so it is proven self-contained).
- Timing goes through a `Clock`; tests use `createManualClock()` instead of
  sleeping.

## In the devcontainer

The devcontainer is the Playwright image matching the pinned version, so every
level runs there with no download:

```sh
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . pnpm check
devcontainer exec --workspace-folder . pnpm check:browser
```

Its `node_modules` is a volume, so a host install and the container's never
overwrite each other. Run `pnpm install` on the host too if you want the
editor's type-checking and the git hooks (`lint-staged`, `commitlint`) to work
there.
