# Design patterns

Each pattern here is used because of a concrete problem, named next to it.

| Pattern | Where | Why |
| --- | --- | --- |
| **Plugin (Strategy + Registry)** | `WirePlugin`, `createStage({ plugins })` | The stage knows no protocol. A new protocol is a new plugin, not a change to the stage (open/closed). `PluginApis<P>` types `stage.<name>` from the list. |
| **Ports and Adapters** | `shared/api/playwright/ports.ts`; `ResponseStream` with its Node adapter in `widgets/stage/lib/response-stream.ts` | Playwright and Node are reached through ports, so every branch is unit-testable with fakes, the library has no runtime Playwright import, and the plugin contract names neither. |
| **Composition root** | `widgets/stage/lib/create-stage.ts`, `app/playwright` | The only places engines and plugins are constructed; nothing reaches for a global. |
| **Facade** | `Stage` | One object for attach, read and dispose, over the timeline, the routers, the page host, the stream servers and the plugins. |
| **Chain of Responsibility** | the rule chain in `http-router.ts` | Newest rule first; a rule that does not match, or answers `fallback`, hands the request to the next. Overrides need no priority numbers, and the chain shares one view of the request. |
| **Command (closed union) with table dispatch** | `HttpOutcome` and the router's `Executors`; `RestReply` | A rule *returns* what to do; the router does it. The table is typed by the union, so a new outcome is a compile error until it is handled. |
| **Observer** | `timeline.subscribe` | Synchronous fan-out of appended frames; a listener that throws does not stop the others. |
| **Late binding** | one route per context whose predicate asks the live rule list | Rules come and go without a browser round trip, a context attached later is covered by the same list, and a WebSocket route — which Playwright cannot remove — simply stops matching. |
| **Decorator** | `named(name, plugin)` | The same plugin under another name: two instances of one protocol on one stage, without the plugin knowing. |
| **Composite** | `PluginContext.use(plugin)` | A protocol layered on others is built from their APIs; the stage runs the inner plugin's hooks with the outer's. |
| **Lazy evaluation + memoization** | `Payload` | Frames are written far more than read: bytes, text and decodes are computed on first use and cached per decoder. |
| **Null Object** | `ANONYMOUS` in `features/connect/lib/recorder.ts` | An unidentified RPC still records, instead of every reader guarding `undefined`. |
| **Proxy** | `recordingRouter` in `features/connect/lib/serve.ts` | Callers write ordinary Connect routes; recording wraps their implementations without leaking into their code. |
| **Mediator** | the page host's binding | One binding per context carries every module's entries and commands, routed by module id. |
| **Factory with shared policy** | `createRpcRules` in `features/connect/lib/rules.ts` | Every stub — unary, stream, fail, abort, hold — is built by one function, so protocol fit, `match`, `times` and recording are checked the same way for all of them. |

Single responsibility is kept at the file level: a file that needs a second
reason to change is split — `features/connect/lib` is twelve files (recorder,
protocol, rules, stubs, faults, client, serve, …), one concern each — and
each engine owns exactly one browser hook.

Patterns deliberately not used: classes with inheritance (factories return
interfaces; Biome bans parameter properties), a dependency-injection
container (constructor arguments are enough at this size), and an event bus
between plugins (plugins share only the timeline, and build on each other
through `use`).
