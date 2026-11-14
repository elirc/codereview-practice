/** The `code` of whatever `work` throws, or undefined if it does not throw. */
export function codeOf(work: () => unknown): string | undefined {
	try {
		work();
	} catch (err) {
		return (err as { code?: string }).code;
	}
	return undefined;
}
