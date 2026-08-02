/** SHA-256 hex when Web Crypto is available; otherwise a stable djb2-based fallback. */
export async function hashText(text: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
		return Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h) ^ text.charCodeAt(i);
	}
	return `djb2_${(h >>> 0).toString(16)}`;
}
