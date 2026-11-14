# Logging

wirestage logs through [`@heojeongbo/log-palette`](https://github.com/HeoJeongBo/log-palette),
behind one module (`src/shared/lib/logger`). The default level is `warn`: a
test run's output is for its results, and the library speaks up only when
something is wrong.

```sh
WIRESTAGE_LOG=debug pnpm exec playwright test   # debug | log | info | warn | error | silent
```

```ts
import { setLogThreshold } from "@heojeongbo/wirestage";

setLogThreshold("info");
```

The built-in scopes are `Stage`, `Http`, `Socket`, `Stream`, `Page`,
`Connect`, `Rest`, `Sse`, `Ws`, `Rtc` and `Fixture`; a plugin of your own
names its scope (`definePlugin({ scope })`, `Plugin` by default). Eight
characters fit the badge column. Lines read
`[....Http] 12:00:00.000 rule failed { rule, url } Error`.

The loggers are the library's own: setting its threshold never changes the
level of log-palette loggers your app or tests use, and theirs never changes
it.

What lands at which level:

| Level | Examples |
| --- | --- |
| `error` | A rule threw (the page got a 500 naming it); a page module's receiver, or a timeline subscriber, threw. |
| `warn` | A passed-through response could not be read; a frame that did not answer a flush in time; an unknown `WIRESTAGE_REPORT` or `WIRESTAGE_LOG`. |
| `debug` | Attach and detach, page flushes skipped during navigation, undecodable RPC payloads, streams ended by a closed connection. |

Inside the library, `console` is banned by Biome and log-palette may only be
imported by the logger module.
