/** `prefix1`, `prefix2`, ... — short ids that read well in a frame dump. */
export function createSequence(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}${++next}`;
}

/**
 * A stable id per object, without holding the object alive: a closed page
 * must be collectable even though its frames still name it.
 */
export function createObjectIds<T extends object>(
	prefix: string,
): (value: T) => string {
	const ids = new WeakMap<T, string>();
	const nextId = createSequence(prefix);
	return (value) => {
		let id = ids.get(value);
		if (id === undefined) {
			id = nextId();
			ids.set(value, id);
		}
		return id;
	};
}

/** An unguessable token, for URLs a page could otherwise stumble onto. */
export function randomToken(): string {
	return crypto.randomUUID().replaceAll("-", "");
}
