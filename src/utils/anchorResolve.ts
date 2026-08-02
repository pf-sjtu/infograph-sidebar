import type {ResolvedAnchor, SourceAnchor} from "../types/pack";

/** Min quote length for reliable location (short slogans mis-match). */
const MIN_QUOTE_LEN = 10;
const MAX_QUOTE_LEN = 200;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Light normalize for flexible matching (does not alter offsets in original). */
export function softNormalize(s: string): string {
	return s
		.replace(/\r\n/g, "\n")
		.replace(/[\u00a0\u3000]/g, " ")
		.replace(/[“”「」]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

export interface TextMatch {
	start: number;
	end: number;
}

/** Exact substring matches. */
export function findExactMatches(haystack: string, needle: string): TextMatch[] {
	const out: TextMatch[] = [];
	if (!needle) return out;
	let from = 0;
	while (from < haystack.length) {
		const i = haystack.indexOf(needle, from);
		if (i < 0) break;
		out.push({start: i, end: i + needle.length});
		from = i + Math.max(1, needle.length);
	}
	return out;
}

/**
 * Whitespace-flexible match: quote tokens may have different whitespace in file.
 * Returns matches in original haystack coordinates.
 */
export function findFlexibleMatches(haystack: string, needle: string): TextMatch[] {
	const exact = findExactMatches(haystack, needle);
	if (exact.length) return exact;

	const trimmed = needle.trim();
	if (trimmed.length < MIN_QUOTE_LEN) return [];

	const tokens = trimmed.split(/\s+/).filter(Boolean).map(escapeRegExp);
	if (!tokens.length) return [];
	// Allow flexible whitespace / optional zero-width between CJK (no spaces)
	const pattern = tokens.join("\\s*");
	const re = new RegExp(pattern, "g");
	const out: TextMatch[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(haystack)) !== null) {
		out.push({start: m.index, end: m.index + m[0].length});
		if (m[0].length === 0) re.lastIndex++;
	}
	return out;
}

/**
 * Soft-normalize search when punctuation/spaces differ.
 * Maps back approximately via exact indexOf of a stable core substring.
 */
export function findSoftNormalizedMatches(haystack: string, needle: string): TextMatch[] {
	const flex = findFlexibleMatches(haystack, needle);
	if (flex.length) return flex;

	const n = softNormalize(needle);
	if (n.length < MIN_QUOTE_LEN) return [];

	// Try a distinctive core: longest run of non-space chars ≥ 8, or middle 24 chars
	const cores: string[] = [];
	const runs = n.split(" ").filter((x) => x.length >= 8);
	cores.push(...runs.slice(0, 3));
	if (n.length >= 12) cores.push(n.slice(0, 24), n.slice(Math.max(0, n.length - 24)));

	const out: TextMatch[] = [];
	const seen = new Set<number>();
	for (const core of cores) {
		if (core.length < 6) continue;
		// Prefer exact core in original
		for (const hit of findExactMatches(haystack, core)) {
			if (seen.has(hit.start)) continue;
			seen.add(hit.start);
			out.push(hit);
		}
		// Also try without spaces for CJK
		const cjk = core.replace(/\s+/g, "");
		if (cjk.length >= 8 && cjk !== core) {
			for (const hit of findExactMatches(haystack, cjk)) {
				if (seen.has(hit.start)) continue;
				seen.add(hit.start);
				out.push(hit);
			}
		}
	}
	return out;
}

function scoreWithContext(haystack: string, match: TextMatch, context?: string): number {
	if (!context?.trim()) return 0;
	const windowStart = Math.max(0, match.start - 120);
	const windowEnd = Math.min(haystack.length, match.end + 120);
	const win = haystack.slice(windowStart, windowEnd);
	const ctx = context.trim();
	if (win.includes(ctx)) return 10;
	const softWin = softNormalize(win);
	const softCtx = softNormalize(ctx);
	if (softWin.includes(softCtx)) return 8;
	// token overlap
	const tokens = softCtx.split(" ").filter((t) => t.length >= 2);
	let hit = 0;
	for (const t of tokens) if (softWin.includes(t)) hit++;
	return tokens.length ? (hit / tokens.length) * 5 : 0;
}

/**
 * Resolve one LLM anchor against full note text at render time.
 */
export function resolveAnchor(fullText: string, anchor: SourceAnchor): ResolvedAnchor {
	const quote = (anchor.quote || anchor.query || "").trim();
	const base: ResolvedAnchor = {
		...anchor,
		quote,
		status: "empty",
		start: -1,
		end: -1,
		matchCount: 0,
	};

	if (!quote) {
		return {...base, status: "empty", message: "无 quote 原文标记"};
	}
	if (quote.length < MIN_QUOTE_LEN) {
		return {
			...base,
			status: "too_short",
			message: `quote 过短（<${MIN_QUOTE_LEN}字），无法可靠定位`,
		};
	}

	const clipped = quote.length > MAX_QUOTE_LEN ? quote.slice(0, MAX_QUOTE_LEN) : quote;

	let matches = findSoftNormalizedMatches(fullText, clipped);

	// If still empty, try progressive shortening from the start (LLM may append paraphrase)
	if (!matches.length && clipped.length > 20) {
		for (const len of [Math.min(60, clipped.length), 40, 28, 20, 12]) {
			if (len > clipped.length) continue;
			matches = findSoftNormalizedMatches(fullText, clipped.slice(0, len));
			if (matches.length) break;
		}
	}

	if (!matches.length) {
		return {
			...base,
			quote: clipped,
			status: "missing",
			message: "正文中未找到该 quote（可能已改写或生成时截断幻觉）",
		};
	}

	// Disambiguate with context
	let best = matches[0]!;
	let bestScore = -1;
	for (const m of matches) {
		const s = scoreWithContext(fullText, m, anchor.context) + (m.end - m.start) * 0.01;
		if (s > bestScore) {
			bestScore = s;
			best = m;
		}
	}

	const ambiguous = matches.length > 1 && bestScore < 6;
	// If multiple exact same and no context, still jump to first but mark ambiguous
	return {
		...base,
		quote: clipped,
		status: ambiguous ? "ambiguous" : "ok",
		start: best.start,
		end: best.end,
		matchCount: matches.length,
		message: ambiguous
			? `匹配到 ${matches.length} 处，已跳到首个/上下文最佳处（建议加 context）`
			: undefined,
	};
}

export function resolveAnchors(fullText: string, anchors: SourceAnchor[]): ResolvedAnchor[] {
	return anchors.map((a) => resolveAnchor(fullText, a));
}

export function offsetToLineCh(
	fullText: string,
	offset: number
): {line: number; ch: number} {
	const safe = Math.max(0, Math.min(offset, fullText.length));
	const before = fullText.slice(0, safe);
	const lines = before.split("\n");
	const line = Math.max(0, lines.length - 1);
	const ch = lines[line]?.length ?? 0;
	return {line, ch};
}
