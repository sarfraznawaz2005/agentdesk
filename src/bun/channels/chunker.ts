/**
 * Split a message into chunks suitable for channel delivery.
 *
 * Priority: paragraph boundaries (\n\n) → single newlines → spaces → hard cut.
 * Falls back to hard-splitting at maxLength if no natural break is found.
 */
export function chunkMessage(text: string, maxLength = 1800): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Try paragraph break first, then single newline, then space, then hard cut
		let breakAt = remaining.lastIndexOf("\n\n", maxLength);
		if (breakAt <= 0) breakAt = remaining.lastIndexOf("\n", maxLength);
		if (breakAt <= 0) breakAt = remaining.lastIndexOf(" ", maxLength);
		if (breakAt <= 0) breakAt = maxLength;

		chunks.push(remaining.slice(0, breakAt));
		remaining = remaining.slice(breakAt).trimStart();
	}

	return chunks;
}
