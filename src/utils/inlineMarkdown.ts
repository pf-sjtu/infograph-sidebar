/**
 * Minimal safe inline markdown for sidebar text blocks (logic / takeaways).
 * Supports **bold** only — no HTML, no full markdown (prevents XSS / full-line bold bugs).
 *
 * AntV Infographic treats label/desc/title as plain SVG text (no markdown).
 * Use stripMarkdownMarkers for chart DSL fields.
 */

export type InlineSeg =
	| {type: "text"; value: string}
	| {type: "bold"; value: string};

/**
 * Parse **bold** pairs. Unmatched `**` are treated as literal text (not bold).
 * Does not interpret single `*`, `_`, or HTML.
 */
export function parseInlineBold(raw: string): InlineSeg[] {
	const s = String(raw ?? "");
	if (!s) return [];
	const segs: InlineSeg[] = [];
	// Non-greedy between ** **; require non-empty inner (avoid ****)
	const re = /\*\*([^*\n]+?)\*\*/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		if (m.index > last) {
			segs.push({type: "text", value: s.slice(last, m.index)});
		}
		const inner = m[1] ?? "";
		if (inner.trim()) {
			segs.push({type: "bold", value: inner});
		} else {
			segs.push({type: "text", value: m[0]});
		}
		last = m.index + m[0].length;
	}
	if (last < s.length) {
		segs.push({type: "text", value: s.slice(last)});
	}
	return segs.length ? segs : [{type: "text", value: s}];
}

/** Fill element with text + <strong> for **bold**; clears previous children. */
export function setInlineMarkdown(el: HTMLElement, raw: string): void {
	el.empty();
	const segs = parseInlineBold(raw);
	for (const seg of segs) {
		if (seg.type === "bold") {
			el.createEl("strong", {text: seg.value, cls: "infograph-md-strong"});
		} else if (seg.value) {
			el.appendText(seg.value);
		}
	}
}

/**
 * Remove markdown markers so AntV plain-text fields don't show raw `**`.
 * Keeps the emphasis words themselves.
 */
export function stripMarkdownMarkers(raw: string): string {
	let s = String(raw ?? "");
	// **bold** → bold
	s = s.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
	// leftover unpaired **
	s = s.replace(/\*\*/g, "");
	// light strip of bare `code` ticks if LLM emits them in labels
	s = s.replace(/`([^`\n]+)`/g, "$1");
	return s;
}

/** True if string has balanced-looking ** usage (for optional diagnostics). */
export function hasInlineBold(raw: string): boolean {
	return /\*\*[^*\n]+?\*\*/.test(raw || "");
}
