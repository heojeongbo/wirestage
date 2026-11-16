/**
 * @heojeongbo/wirestage — the core: the stage, its timeline, and the plugin
 * contract every protocol is written against. Protocols live in subpaths:
 * `/connect`, `/rest`, `/sse`, `/websocket`, `/webrtc`; the Playwright
 * fixture in `/playwright`.
 */

// The timeline: what every plugin writes and every test reads.
export type {
	Direction,
	Frame,
	FrameFilter,
	FrameInit,
	FrameKind,
	FrameSource,
	Payload,
	PayloadInput,
	SnapshotFrame,
	SnapshotOptions,
	Timeline,
	TimelineCursor,
	TimelineOptions,
	TimelineSnapshot,
} from "./entities/frame/index.js";
export { createTimeline } from "./entities/frame/index.js";
// The plugin contract: what a protocol is written against.
export type {
	AbortErrorCode,
	AnyWirePlugin,
	Attachment,
	HttpOutcome,
	HttpRequestView,
	HttpRouter,
	HttpRule,
	HttpRuleHandle,
	PageEntry,
	PageHost,
	PageInstaller,
	PageModule,
	PageModuleEnv,
	PageSource,
	PassthroughResponse,
	PluginApis,
	PluginContext,
	PluginRuntime,
	ResponseStream,
	SocketPeer,
	SocketRouter,
	SocketRule,
	SocketRuleHandle,
	SocketView,
	StreamEnd,
	WaitForOptions,
	WirePlugin,
} from "./entities/plugin/index.js";
export { definePlugin, named } from "./entities/plugin/index.js";
// The ports served fakes listen on (`PluginContext.ports`): plain requests
// and WebSockets, shared between plugins on one port.
export type {
	Listening,
	OpenResponse,
	OpenResponseEnd,
	PortOptions,
	PortShare,
	Ports,
	RequestHandler,
	ServedRequest,
	ServedResponse,
	ServedStream,
	ServedUpgrade,
	ServedWebSocket,
	ServedWebSocketEnd,
	UpgradeResponse,
	WebSocketHandler,
} from "./shared/api/http-server/index.js";
// What the stage is handed: a browser context, its pages, its cookie jar.
export type {
	ContextPort,
	CookieJarPort,
	FramePort,
	PagePort,
} from "./shared/api/playwright/index.js";
// For plugin authors: the pieces every built-in plugin is made of.
export type {
	Arrivals,
	ArrivalsOptions,
	AsyncQueue,
	Deferred,
} from "./shared/lib/async/index.js";
export {
	createArrivals,
	createAsyncQueue,
	createDeferred,
} from "./shared/lib/async/index.js";
export type { Clock, ManualClock } from "./shared/lib/clock/index.js";
export {
	createManualClock,
	createSystemClock,
} from "./shared/lib/clock/index.js";
export type { CookieInit } from "./shared/lib/cookies/index.js";
// The length-prefixed framing gRPC, gRPC-web and Connect streams share, for
// a test that builds or reads a frame by hand.
export type { Envelope } from "./shared/lib/envelope/index.js";
export {
	createEnvelopeReader,
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	encodeEnvelopes,
	parseTrailerBlock,
} from "./shared/lib/envelope/index.js";
export type { WirestageErrorCode } from "./shared/lib/errors/index.js";
export { isWirestageError, WirestageError } from "./shared/lib/errors/index.js";
export type {
	LogScope,
	LogThreshold,
	ScopedLogger,
} from "./shared/lib/logger/index.js";
export { getLogThreshold, setLogThreshold } from "./shared/lib/logger/index.js";
export type { UrlMatcher } from "./shared/lib/match/index.js";
export { compileUrlMatcher } from "./shared/lib/match/index.js";
export type {
	AttachOptions,
	MarkOptions,
	ReportOptions,
	Stage,
	StageCore,
	StageCursor,
	StageOptions,
	StageReport,
} from "./widgets/stage/index.js";
export { createStage } from "./widgets/stage/index.js";
