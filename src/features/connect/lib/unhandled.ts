import {
	create,
	createFileRegistry,
	type DescMethod,
	type DescService,
} from "@bufbuild/protobuf";
import {
	FileDescriptorSetSchema,
	MethodOptions_IdempotencyLevel,
} from "@bufbuild/protobuf/wkt";

/** How the call came in, which decides the method a handler is built for. */
export interface UnhandledShape {
	/** Enveloped: every protocol's streaming form, and gRPC's every call. */
	readonly streaming: boolean;
	/** A Connect GET, which connect-es serves only for side-effect-free methods. */
	readonly get: boolean;
}

/** `/<package>.<Service>/<Method>`, the package optional. */
const RPC_PATH = /^\/((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\/([A-Za-z_]\w*)$/;

/**
 * A method nobody declared, made from the path a call came in on, so that
 * connect-es's own handler can answer it and the bytes are exactly a
 * server's. It takes and gives a message with no fields: the caller's fields
 * survive as unknown fields, so its request still lands on the timeline as
 * sent. Undefined for a path that names no method.
 */
export function methodFromPath(
	path: string,
	shape: UnhandledShape,
): DescMethod | undefined {
	const match = RPC_PATH.exec(path);
	if (match === null) return undefined;
	// Every group takes part in a match; the package's may be empty.
	const [prefix, service, method] = match.slice(1) as [string, string, string];
	const empty = `.${prefix}Unhandled`;
	// A set of one file that imports nothing: no resolver to give.
	const registry = createFileRegistry(
		create(FileDescriptorSetSchema, {
			file: [
				{
					name: `wirestage/unhandled/${prefix}${service}.proto`,
					package: prefix.slice(0, -1),
					syntax: "proto3",
					messageType: [{ name: "Unhandled" }],
					service: [
						{
							name: service,
							method: [
								{
									name: method,
									inputType: empty,
									outputType: empty,
									serverStreaming: shape.streaming,
									...(shape.get
										? {
												options: {
													idempotencyLevel:
														MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS,
												},
											}
										: {}),
								},
							],
						},
					],
				},
			],
		}),
	);
	return (registry.getService(`${prefix}${service}`) as DescService).methods[0];
}
