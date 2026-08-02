/**
 * Sanitize LLM AntV DSL before render.
 * Strips non-render noise and repairs common malformed charts.
 */

import {ensureMutedTheme, type ColorMode} from "../theme";
import {stripMarkdownMarkers} from "./inlineMarkdown";

const NOISE_LINE =
	/^\s*(anchors?|quote|context|heading|query|coverage|panel_count|INFOGRAPH_PACK|###\s*panel)\b/i;
const ANCHOR_BULLET =
	/^\s*-\s*(label\s+.+?\s*\|\s*(quote|heading|context|query)\b|.*\|\s*quote\s+)/i;

/** Pull pure DSL: from first `infographic ` / JSON. */
export function extractPureDsl(raw: string): string {
	let text = raw.trim();
	const fence = text.match(/```(?:infographic|infograph)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1]!.trim();

	const dslStart = text.search(/^infographic\s+\S+/m);
	const jsonStart = text.search(/^\s*\{/m);
	if (dslStart >= 0 && (jsonStart < 0 || dslStart <= jsonStart)) {
		text = text.slice(dslStart);
	} else if (jsonStart >= 0) {
		text = text.slice(jsonStart);
		return text.trim();
	}

	const cut = text.search(/\n(?:###\s*panel\b|INFOGRAPH_PACK\b)/i);
	if (cut > 0) text = text.slice(0, cut);

	return text.trim();
}

function isNoiseLine(line: string): boolean {
	if (NOISE_LINE.test(line)) return true;
	if (ANCHOR_BULLET.test(line)) return true;
	if (/^\s*-\s*label\s+.+\|\s*quote\s+/i.test(line)) return true;
	if (/^\s*icon\s+/i.test(line)) return true;
	if (/^\s*<!--/.test(line) || /^\s*-->/.test(line)) return true;
	return false;
}

export function expandPipedLabelValuePairs(blob: string): Array<{label: string; value: number}> {
	const s = blob.replace(/\s*\|\s*/g, " | ").trim();
	const pipeParts = s.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
	const pairs: Array<{label: string; value: number}> = [];

	if (pipeParts.length >= 2) {
		let i = 0;
		while (i < pipeParts.length) {
			const a = pipeParts[i]!;
			const b = pipeParts[i + 1];
			// skip pure junk tokens like "d", "value"
			if (/^(value|d|desc)$/i.test(a)) {
				i++;
				continue;
			}
			const numA = parseNum(a);
			const numB = b !== undefined ? parseNum(b) : null;
			if (numA === null && numB !== null) {
				pairs.push({label: cleanLabel(a.replace(/^value\s+/i, "")), value: numB});
				i += 2;
				continue;
			}
			if (numA !== null && b && parseNum(b) === null && !/^(value|d)$/i.test(b)) {
				pairs.push({label: cleanLabel(b), value: numA});
				i += 2;
				continue;
			}
			// "value 13" style segment
			const valSeg = a.match(/^value\s+([-+]?\d+(?:\.\d+)?%?)/i);
			if (valSeg && pairs.length) {
				const n = parseNum(valSeg[1]!);
				if (n !== null) pairs[pairs.length - 1]!.value = n;
				i++;
				continue;
			}
			const embedded = splitNameNumber(a.replace(/^value\s+/i, ""));
			if (embedded) {
				pairs.push(embedded);
				i += 1;
				continue;
			}
			i += 1;
		}
		if (pairs.length >= 1) return pairs;
	}

	// Inline: label 美国 | value 13 |
	const inline = blob.match(
		/label\s+([^|]+?)\s*\|\s*value\s+([-+]?\d+(?:\.\d+)?%?)/i
	);
	if (inline) {
		const n = parseNum(inline[2]!);
		if (n !== null) return [{label: cleanLabel(inline[1]!), value: n}];
	}

	const re = /([^\d|]+?)\s*[|：:]\s*([-+]?\d+(?:\.\d+)?%?)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(blob)) !== null) {
		const v = parseNum(m[2]!);
		if (v !== null) pairs.push({label: cleanLabel(m[1]!), value: v});
	}
	return pairs;
}

function parseNum(s: string): number | null {
	const t = s.replace(/%/g, "").replace(/,/g, "").trim();
	if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

function cleanLabel(s: string): string {
	return s
		.replace(/\s+/g, " ")
		.replace(/^[-–—|·.•]+\s*/, "")
		.replace(/\s*[|]+\s*$/g, "")
		.replace(/^(label|value)\s+/i, "")
		.trim()
		.slice(0, 16);
}

function splitNameNumber(seg: string): {label: string; value: number} | null {
	const m = seg.match(/^(.+?)\s+([-+]?\d+(?:\.\d+)?%?)\s*$/);
	if (!m) return null;
	const v = parseNum(m[2]!);
	if (v === null) return null;
	return {label: cleanLabel(m[1]!), value: v};
}

/**
 * Fix single-line items:
 * - label 美国 | value 13 |
 * - label 美国 | value 13 | d
 */
function expandInlineLabelValueLines(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const m = line.match(
			/^(\s*)-\s*label\s+(.+?)\s*\|\s*value\s+([-+]?\d+(?:\.\d+)?%?)\s*\|?\s*[a-z]?\s*$/i
		);
		if (m) {
			const indent = m[1] ?? "";
			const n = parseNum(m[3]!);
			out.push(`${indent}- label ${cleanLabel(m[2]!)}`);
			if (n !== null) out.push(`${indent}  value ${n}`);
			continue;
		}
		// - label 美国 | value 13 | (without trailing letter)
		const m2 = line.match(
			/^(\s*)-\s*label\s+(.+?)\s*\|\s*value\s+([-+]?\d+(?:\.\d+)?%?)/i
		);
		if (m2 && line.includes("|")) {
			const indent = m2[1] ?? "";
			const n = parseNum(m2[3]!);
			out.push(`${indent}- label ${cleanLabel(m2[2]!)}`);
			if (n !== null) out.push(`${indent}  value ${n}`);
			continue;
		}
		out.push(line);
	}
	return out;
}

function repairCollapsedItems(lines: string[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const labelMatch = line.match(/^(\s*)-\s*label\s+(.+)$/i);
		if (!labelMatch) {
			out.push(line);
			i++;
			continue;
		}

		const indent = labelMatch[1] ?? "";
		const labelBody = labelMatch[2]!.trim();
		let valueLine = "";
		let j = i + 1;
		while (j < lines.length && /^\s*$/.test(lines[j]!)) j++;
		if (j < lines.length && /^\s*value\s+/i.test(lines[j]!)) {
			valueLine = lines[j]!;
		}

		const pipeCount = (labelBody.match(/\|/g) || []).length;
		const looksCollapsed =
			pipeCount >= 2 ||
			(labelBody.length > 28 && /\d/.test(labelBody) && /[|；;]/.test(labelBody)) ||
			/\|\s*value\s+/i.test(labelBody);

		if (looksCollapsed) {
			const pairs = expandPipedLabelValuePairs(
				labelBody + (valueLine ? " " + valueLine.replace(/^\s*value\s+/i, " | value ") : "")
			);
			if (pairs.length >= 1) {
				for (const p of pairs) {
					out.push(`${indent}- label ${p.label}`);
					out.push(`${indent}  value ${p.value}`);
				}
				i = valueLine ? j + 1 : i + 1;
				while (i < lines.length && /^\s+(desc|icon)\s+/i.test(lines[i]!)) i++;
				continue;
			}
		}

		out.push(`${indent}- label ${cleanLabel(labelBody)}`);
		if (valueLine) {
			const vm = valueLine.match(/^\s*value\s+(.+)$/i);
			const rawV = (vm?.[1] ?? "").replace(/[|].*$/, "").trim();
			const n = parseNum(rawV);
			if (n !== null) {
				out.push(`${indent}  value ${n}`);
			} else {
				const first = rawV.match(/[-+]?\d+(?:\.\d+)?/);
				if (first) out.push(`${indent}  value ${first[0]}`);
			}
			i = j + 1;
			continue;
		}
		i++;
	}
	return out;
}

/** If values are sequential 1..n fake ranks, drop values (keep labels only). */
function demoteFakeOrdinalValues(lines: string[]): string[] {
	const items: Array<{label: string; value: number; indent: string}> = [];
	for (let i = 0; i < lines.length; i++) {
		const lm = lines[i]!.match(/^(\s*)-\s*label\s+(.+)$/i);
		if (!lm) continue;
		const vm = lines[i + 1]?.match(/^\s*value\s+([-+]?\d+)/i);
		if (!vm) continue;
		const n = Number(vm[1]);
		if (!Number.isFinite(n)) continue;
		items.push({label: lm[2]!, value: n, indent: lm[1] ?? ""});
	}
	if (items.length < 3) return lines;
	const sorted = [...items.map((x) => x.value)].sort((a, b) => a - b);
	const isOrdinal = sorted.every((v, idx) => v === idx + 1);
	// also 0..n-1
	const isZeroOrdinal = sorted.every((v, idx) => v === idx);
	if (!isOrdinal && !isZeroOrdinal) return lines;

	// Rebuild without value lines for these items
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const lm = lines[i]!.match(/^(\s*)-\s*label\s+(.+)$/i);
		if (lm && lines[i + 1] && /^\s*value\s+/i.test(lines[i + 1]!)) {
			out.push(`${lm[1]}- label ${cleanLabel(lm[2]!)}`);
			// optional desc keep
			i += 2;
			if (i < lines.length && /^\s+desc\s+/i.test(lines[i]!)) {
				out.push(lines[i]!);
				i++;
			}
			continue;
		}
		out.push(lines[i]!);
		i++;
	}
	return out;
}

/** list-* template with values field → chart-column-simple */
function fixTemplateDataMismatch(lines: string[]): string[] {
	const tplIdx = lines.findIndex((l) => /^infographic\s+/i.test(l.trim()));
	if (tplIdx < 0) return lines;
	const tpl = lines[tplIdx]!;
	const hasValues = lines.some((l) => /^\s*values\b/i.test(l));
	const hasLists = lines.some((l) => /^\s*lists\b/i.test(l));
	const isListTpl = /list-/i.test(tpl);
	const isChartTpl = /chart-/i.test(tpl);

	const out = [...lines];
	if (isListTpl && hasValues && !hasLists) {
		out[tplIdx] = "infographic chart-column-simple";
	}
	if (isChartTpl && hasLists && !hasValues) {
		// rename lists → values
		return out.map((l) => l.replace(/^(\s*)lists\b/i, "$1values"));
	}
	return out;
}

function stripNoiseLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => !isNoiseLine(line))
		.join("\n");
}

function simplifyTemplateLine(line: string): string {
	if (!/^infographic\s+/i.test(line)) return line;
	return line
		.replace(/list-row-horizontal-icon-arrow/gi, "list-row-simple-horizontal-arrow")
		.replace(/list-grid-icon-card/gi, "list-grid-badge-card")
		.replace(/-icon-arrow/gi, "-arrow")
		.replace(/-icon-card/gi, "-card");
}

/**
 * AntV Infographic renders label/desc/title as plain SVG text — no markdown.
 * Strip ** / ` so raw markers don't show on charts.
 */
function stripMarkdownFromDslLines(lines: string[]): string[] {
	return lines.map((line) => {
		// - label foo **bar**  OR  title ... OR desc ...
		const m = line.match(/^(\s*(?:-\s*)?(?:label|desc|title)\s+)(.*)$/i);
		if (!m) return line;
		return m[1]! + stripMarkdownMarkers(m[2]!);
	});
}

export function sanitizeDslForRender(raw: string, mode: ColorMode = "light"): string {
	let text = extractPureDsl(raw);
	if (!text) return raw.trim();

	if (text.trimStart().startsWith("{")) {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			delete obj.anchors;
			delete obj.quote;
			delete obj.coverage;
			// Walk shallow strings in JSON data for markdown markers
			const stripDeep = (v: unknown): unknown => {
				if (typeof v === "string") return stripMarkdownMarkers(v);
				if (Array.isArray(v)) return v.map(stripDeep);
				if (v && typeof v === "object") {
					const o: Record<string, unknown> = {};
					for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
						o[k] = stripDeep(val);
					}
					return o;
				}
				return v;
			};
			return JSON.stringify(stripDeep(obj));
		} catch {
			// fall through
		}
	}

	text = stripNoiseLines(text);
	let lines = text.split("\n").map(simplifyTemplateLine);
	lines = expandInlineLabelValueLines(lines);
	lines = stripMarkdownFromDslLines(lines);

	lines = lines.filter((line) => {
		const t = line.trim();
		if (!t) return true;
		if (
			/^(infographic|data|theme|lists|sequences|compares|values|nodes|root|items|order|palette|title|desc|label|value|children|id)\b/i.test(
				t
			)
		)
			return true;
		if (/^-\s+/.test(t)) return true;
		if (/^\s+(label|value|desc|icon|children|id|step)\b/i.test(t)) return true;
		if (/^\s{2,}\S/.test(line) && t.length < 40) return true;
		if (t.length > 60 && !/\d/.test(t)) return false;
		if (/^(第[一二三四五六七八九十]|核心结论|本研究)/.test(t)) return false;
		return true;
	});

	lines = repairCollapsedItems(lines);
	lines = demoteFakeOrdinalValues(lines);
	lines = fixTemplateDataMismatch(lines);

	const firstIdx = lines.findIndex((l) => /^infographic\s+\S+/i.test(l.trim()));
	if (firstIdx > 0) lines = lines.slice(firstIdx);

	const compact: string[] = [];
	let blank = 0;
	for (const l of lines) {
		if (!l.trim()) {
			blank++;
			if (blank <= 1) compact.push("");
			continue;
		}
		blank = 0;
		compact.push(l.replace(/\t/g, "  "));
	}

	let joined = compact.join("\n").trim();
	joined = preferNarrowTemplates(joined);
	return ensureMutedTheme(joined, mode);
}

/**
 * Do not remap root/children trees onto sequences templates (field mismatch).
 * Narrow layout is handled by prompt (prefer vertical templates) + CSS max-height/overflow.
 */
function preferNarrowTemplates(dsl: string): string {
	return dsl;
}

export function dslLooksRenderable(dsl: string): boolean {
	if (!dsl || dsl.length < 20) return false;
	if (!/^infographic\s+\S+/im.test(dsl) && !dsl.trimStart().startsWith("{")) return false;
	if (!/\b(lists|sequences|compares|values|nodes|root|items)\b/i.test(dsl)) return false;
	return true;
}
