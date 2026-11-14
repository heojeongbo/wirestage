/**
 * Conventional Commits, enforced by the `commit-msg` hook.
 *
 * `scope-enum` stays open: scopes follow the subpaths (`connect`, `webrtc`, ...)
 * and a closed list would be a second place to update for every new protocol.
 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// The default 72 truncates bodies that name the failure they fix.
		"body-max-line-length": [1, "always", 100],
	},
};
