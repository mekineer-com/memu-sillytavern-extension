export function estimateTokenUsage(text: string): number {
	const length = (text ?? "").length;
	return Math.max(1, Math.ceil(length / 4));
}
