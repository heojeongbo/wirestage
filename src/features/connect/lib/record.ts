import type { DescService } from "@bufbuild/protobuf";

import type { HttpRuleHandle } from "../../../entities/plugin/index.js";
import type { StubHandle } from "../model/types.js";
import { endpointOf } from "./recorder.js";
import type { RpcRules } from "./rules.js";

/**
 * Record and decode a service's calls without answering them: the request
 * as it leaves, the real backend's messages and status as they come back,
 * or the fault when the connection fails.
 *
 * A call a stub answers is recorded by that stub. Where this rule sits among
 * the stubs does not matter: a request is one exchange however many rules
 * see it, so it lands once either way.
 */
export async function recordService(
	rules: RpcRules,
	service: DescService,
): Promise<StubHandle> {
	const added: HttpRuleHandle[] = [];
	for (const method of service.methods) {
		// A page cannot call the others; there is nothing of theirs to record.
		if (
			method.methodKind !== "unary" &&
			method.methodKind !== "server_streaming"
		)
			continue;
		added.push(
			await rules.add({
				method,
				label: `record ${endpointOf(method)}`,
				options: {},
				anyProtocol: true,
				observe: true,
				respond: () => ({ type: "fallback" }),
			}),
		);
	}
	return {
		get hits() {
			return added.reduce((sum, rule) => sum + rule.hits, 0);
		},
		async remove() {
			await Promise.all(added.map((rule) => rule.remove()));
		},
	};
}
