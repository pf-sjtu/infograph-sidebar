export type ColorMode = "light" | "dark";

/**
 * Light: black → orange (high contrast on light bg)
 * Dark: cream/off-white → orange (high contrast on dark bg; avoid near-black)
 */
export const PALETTE_LIGHT = ["#1a1a1a", "#3f3f46", "#e7e5e4", "#d97757"] as const;
export const PALETTE_DARK = ["#f5f0e6", "#e7e0d4", "#c4b8a5", "#e8a87c"] as const;

export function paletteForMode(mode: ColorMode): readonly string[] {
	return mode === "dark" ? PALETTE_DARK : PALETTE_LIGHT;
}

export function themeBlockForMode(mode: ColorMode): string {
	const p = paletteForMode(mode);
	return `theme
  palette ${p.join(" ")}
`;
}

/** Strip existing theme/palette then inject mode-appropriate muted palette. */
export function ensureMutedTheme(dsl: string, mode: ColorMode = "light"): string {
	const text = dsl.trim();
	if (!text || text.startsWith("{")) return text;

	const lines = text.split("\n");
	const out: string[] = [];
	let inTheme = false;
	for (const line of lines) {
		if (/^theme\b/i.test(line.trim())) {
			inTheme = true;
			continue;
		}
		if (inTheme) {
			if (/^\s/.test(line) || /^\s*palette\b/i.test(line)) continue;
			inTheme = false;
		}
		if (/^\s*palette\b/i.test(line)) continue;
		out.push(line);
	}
	return (out.join("\n").trimEnd() + "\n\n" + themeBlockForMode(mode)).trim() + "\n";
}
