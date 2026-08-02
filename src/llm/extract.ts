import {parseInfographicSpec} from "../parser";
import type {InfographicSettings} from "../settings";
import {extractHeadingIndex, prepareNoteText} from "../utils/markdown";
import {chatCompletion} from "./client";
import {SYSTEM_PROMPT, buildRepairPrompt, buildUserPrompt} from "./prompts";
import type {
	InfographicPack,
	InfographicPanel,
	LogicBrief,
	SourceAnchor,
	TakeawayItem,
} from "../types/pack";
import {normalizeAnchorInput, normalizeTakeawayKind, singleDslToPack} from "../types/pack";
import {resolveAnchor} from "../utils/anchorResolve";
import {sanitizeDslForRender} from "../utils/dslSanitize";

/** @deprecated use sanitizeDslForRender */
export function stripDecorativeIcons(dsl: string): string {
	return sanitizeDslForRender(dsl);
}

export function countIconLines(dsl: string): number {
	return (dsl.match(/^\s*icon\s+/gim) || []).length;
}

export interface ExtractResult {
	pack: InfographicPack;
	dsl: string;
	isJson: boolean;
	rawModelOutput: string;
}

function cleanSingleDsl(raw: string): string {
	const fenced = raw.match(/```(?:infographic|infograph)?\s*([\s\S]*?)```/i);
	let text = (fenced?.[1] ?? raw).trim();
	const dslIdx = text.search(/^infographic\s+\S+/m);
	if (dslIdx > 0) text = text.slice(dslIdx);
	return text.trim();
}

/**
 * Parse anchor lines:
 * - label X | quote Y | context Z
 */
function parseAnchorsBlock(block: string): SourceAnchor[] {
	const anchors: SourceAnchor[] = [];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("-")) continue;

		const body = line.replace(/^\s*-\s*/, "");
		const parts = body.split("|").map((p) => p.trim());
		const map: Record<string, string> = {};
		for (const part of parts) {
			const m = part.match(/^(label|quote|context|heading|query)\s*[:=]?\s*(.+)$/i);
			if (m) {
				map[m[1]!.toLowerCase()] = m[2]!.trim();
			}
		}
		if (!map.label && parts[0]) {
			const m0 = parts[0].match(/^label\s+(.+)$/i);
			if (m0) map.label = m0[1]!.trim();
			else if (!/^(quote|context|heading|query)\b/i.test(parts[0])) map.label = parts[0];
		}
		if (!map.quote) {
			for (const part of parts) {
				const mq = part.match(/^quote\s+(.+)$/i);
				if (mq) map.quote = mq[1]!.trim();
				const mq2 = part.match(/^query\s+(.+)$/i);
				if (mq2 && !map.quote) map.quote = mq2[1]!.trim();
				const mc = part.match(/^context\s+(.+)$/i);
				if (mc) map.context = mc[1]!.trim();
			}
		}
		if (!map.quote && map.query) map.quote = map.query;

		// Locator quote must be long enough to search; label is free-form claim (may be short)
		if (!map.quote || map.quote.length < 8) continue;
		if (isStructuralShell(map.quote) && map.quote.length < 16) continue;
		const rawLabel = (map.label || "").trim();
		// Drop pure structure shells as keyword; keep claim-like labels even if short
		if (rawLabel && isStructuralShell(rawLabel) && !isClaimLikeLabel(rawLabel)) continue;
		anchors.push(
			normalizeAnchorInput({
				label: rawLabel || map.quote.slice(0, 16),
				quote: map.quote,
				context: map.context,
			})
		);
	}
	return anchors;
}

/**
 * Structure shells only (step numbers / empty scaffolds) — NOT short claim keywords.
 * 「复苏路径分化」OK；「1. 问题定义」「机制一」BAD.
 */
function isStructuralShell(s: string): boolean {
	const t = (s || "").trim();
	if (!t) return true;
	if (/^\d+[\.、．]\s*/.test(t)) return true;
	if (/^[1-5]\.\s*\S*/.test(t)) return true;
	if (/^(机制|阶段|步骤|路径|层级)\s*[一二三四五六七八九十\d]+$/.test(t)) return true;
	if (/^(其一|其二|其三|其四|其五|首先|其次|最后|综上|问题定义|含义|结论)$/.test(t)) return true;
	return false;
}

/** Claim-like keyword: 2–20 chars, not a pure structure shell. */
function isClaimLikeLabel(s: string): boolean {
	const t = (s || "").replace(/\s+/g, "").trim();
	if (t.length < 2 || t.length > 20) return false;
	if (isStructuralShell(t)) return false;
	// Reject pure entity·number mining style (日本·27% / 西班牙36%)
	if (/^[\u4e00-\u9fffA-Za-z]{1,8}[·•]?[0-9]+(?:\.[0-9]+)?[%万亿年倍]?$/.test(t) && t.length <= 10) {
		// Allow if it still looks like a claim word with number, but prefer rejecting pure digests
		// e.g. 跌幅36% might be ok as weak claim; 日本27 alone is not
		if (/^(日本|美国|西班牙|爱尔兰|迪拜|中国|东京|希腊)/.test(t) && /\d/.test(t)) return false;
	}
	return true;
}

/**
 * Keep LLM label as chip when it is a claim keyword.
 * Never rewrite into entity·number via script.
 */
function preferLlmChip(label: string | undefined, locatorQuote: string): string {
	const lab = (label || "").replace(/\s+/g, " ").trim();
	if (lab && isClaimLikeLabel(lab)) return lab.slice(0, 18);
	// Soft fallback: clip locator only if LLM label missing/bad (should be rare)
	const q = locatorQuote.replace(/\s+/g, " ").trim();
	return q.slice(0, 14);
}

/**
 * Filter + ground LLM anchors only (no mechanical DSL mining).
 * - label stays LLM claim keyword (display)
 * - quote is re-grounded to the actual note span for jump offsets
 */
export function filterAndGroundAnchors(
	fullNote: string,
	anchors: SourceAnchor[]
): SourceAnchor[] {
	const kept: SourceAnchor[] = [];
	const seenStarts = new Set<number>();
	const seenLabels = new Set<string>();

	for (const a of anchors) {
		const locator = (a.quote || a.query || "").trim();
		if (locator.length < 8) continue;

		const r = resolveAnchor(fullNote, {...a, quote: locator});
		// Accept unique; accept ambiguous if context helps or label is claim-like
		const accept =
			r.status === "ok" ||
			(r.status === "ambiguous" &&
				((a.context && a.context.length >= 2) || isClaimLikeLabel(a.label || "")));
		if (!accept) continue;

		const grounded = fullNote.slice(r.start, r.end).replace(/\s+/g, " ").trim() || locator;
		if (grounded.length < 8) continue;
		if (seenStarts.has(r.start)) continue;

		const chip = preferLlmChip(a.label, grounded);
		if (!chip || isStructuralShell(chip)) continue;
		const chipKey = chip.toLowerCase();
		if (seenLabels.has(chipKey)) continue;

		seenStarts.add(r.start);
		seenLabels.add(chipKey);
		kept.push({
			label: chip,
			quote: grounded,
			context: a.context,
		});
	}
	return kept;
}

/**
 * @deprecated Mechanical DSL mining removed — anchors must come from LLM.
 * Kept as identity for any external callers; returns existing only.
 */
export function recoverAnchorsFromDsl(
	_fullNote: string,
	_dsl: string,
	existing: SourceAnchor[],
	_minWanted = 3
): SourceAnchor[] {
	return existing;
}

export function countPanelsMissingAnchors(pack: InfographicPack): number {
	return pack.panels.filter((p) => !(p.anchors && p.anchors.length > 0)).length;
}

/** Parse logic { thesis, points } from INFOGRAPH_PACK text (before panels). */
export function parseLogicBrief(text: string): LogicBrief | undefined {
	// Prefer explicit `logic` block ending before takeaways / ### panel
	const block =
		text.match(
			/^logic\s*\n([\s\S]*?)(?=^takeaways\b|^###\s*panel\b|^##\s*takeaways\b)/im
		)?.[1] ||
		text.match(/^##\s*logic(?:_summary)?\s*\n([\s\S]*?)(?=^##\s*takeaways\b|^###\s*panel\b)/im)?.[1] ||
		text.match(
			/\blogic\s*\n([\s\S]*?)(?=\ntakeaways\b|\n###\s*panel\b)/i
		)?.[1];
	if (!block) {
		// Fallback: lone thesis line anywhere near top
		const thesisOnly = text.match(/^thesis\s+(.+)$/im)?.[1]?.trim();
		if (thesisOnly && thesisOnly.length >= 12) {
			return {thesis: thesisOnly, points: []};
		}
		return undefined;
	}
	const thesis =
		block.match(/^\s*thesis\s+(.+)$/im)?.[1]?.trim() ||
		block.match(/^\s*thesis\s*:\s*(.+)$/im)?.[1]?.trim() ||
		"";
	if (thesis.length < 8) return undefined;

	const points: string[] = [];
	const pointsSection = block.match(/points\s*\n([\s\S]*)/i)?.[1] || block;
	for (const rawLine of pointsSection.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("-")) continue;
		if (/^-\s*kind\b/i.test(line)) continue;
		let item = line.replace(/^\s*-\s*/, "").trim();
		item = item.replace(/^(point|item)\s*[:=]?\s*/i, "").trim();
		if (item.length < 4) continue;
		if (isStructuralShell(item) && item.length < 16) continue;
		points.push(item.slice(0, 200));
		if (points.length >= 10) break;
	}
	return {thesis: thesis.slice(0, 600), points};
}

/** Parse takeaways list (critique | method | extend). */
export function parseTakeaways(text: string): TakeawayItem[] {
	const block =
		text.match(
			/^takeaways\s*\n([\s\S]*?)(?=^###\s*panel\b|^##\s*panel\b|\nINFOGRAPH_PACK\b)/im
		)?.[1] ||
		text.match(/^##\s*takeaways\s*\n([\s\S]*?)(?=^###\s*panel\b)/im)?.[1] ||
		text.match(/\ntakeaways\s*\n([\s\S]*?)(?=\n###\s*panel\b)/i)?.[1];
	if (!block) return [];

	const out: TakeawayItem[] = [];
	const seen = new Set<string>();
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("-")) continue;
		const body = line.replace(/^\s*-\s*/, "");
		// [critique] text  OR  kind critique | text ...
		let kindRaw = "";
		let textBody = "";
		const bracket = body.match(/^\[(critique|challenge|method|extend|批判|方法|延申|延伸)\]\s*(.+)$/i);
		if (bracket) {
			kindRaw = bracket[1]!;
			textBody = bracket[2]!.trim();
		} else {
			const parts = body.split("|").map((p) => p.trim());
			const map: Record<string, string> = {};
			for (const part of parts) {
				const m = part.match(/^(kind|text|type)\s*[:=]?\s*(.+)$/i);
				if (m) map[m[1]!.toLowerCase()] = m[2]!.trim();
			}
			kindRaw = map.kind || map.type || "";
			textBody = map.text || "";
			if (!textBody && parts.length >= 2 && !kindRaw) {
				// kind-like first token
				const k0 = parts[0]!.replace(/^kind\s+/i, "").trim();
				if (normalizeTakeawayKind(k0)) {
					kindRaw = k0;
					textBody = parts.slice(1).join(" | ").replace(/^text\s+/i, "").trim();
				}
			}
			if (!textBody && map.text === undefined) {
				// last resort: whole line after kind
				const m2 = body.match(/^kind\s+(\S+)\s*[|:]?\s*(?:text\s+)?(.+)$/i);
				if (m2) {
					kindRaw = m2[1]!;
					textBody = m2[2]!.trim();
				}
			}
		}
		const kind = normalizeTakeawayKind(kindRaw);
		if (!kind) continue;
		textBody = textBody.replace(/^text\s+/i, "").trim();
		if (textBody.length < 8) continue;
		const key = `${kind}:${textBody.slice(0, 40)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({kind, text: textBody.slice(0, 400)});
		if (out.length >= 12) break;
	}
	return out;
}

export function parseInfographPack(raw: string): InfographicPack | null {
	const text = raw.trim();
	if (!/INFOGRAPH_PACK/i.test(text) && !/^###\s*panel/im.test(text)) {
		const dsl = cleanSingleDsl(text);
		if (/^infographic\s+\S+/m.test(dsl) || dsl.trimStart().startsWith("{")) {
			const parsed = parseInfographicSpec(dsl);
			if (parsed.success) {
				return singleDslToPack(parsed.content, parsed.isJson, "Infographic");
			}
		}
		return null;
	}

	const titleMatch = text.match(/^title\s+(.+)$/im);
	const coverageMatch = text.match(/^coverage\s+(.+)$/im);
	const title = titleMatch?.[1]?.trim() || "信息图集";
	const coverageNote = coverageMatch?.[1]?.trim();
	const logic = parseLogicBrief(text);
	const takeaways = parseTakeaways(text);

	let chunks = text.split(/^###\s*panel\b.*$/im).slice(1);
	if (chunks.length === 0) {
		chunks = text.split(/(?=^###\s*panel)/im).filter((c) => /panel/i.test(c.slice(0, 40)));
	}

	const panels: InfographicPanel[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const idMatch = chunk.match(/^id\s+(\S+)/im) || chunk.match(/\bid\s+(\S+)/i);
		const pTitleMatch = chunk.match(/^title\s+(.+)$/im);
		const anchorsSection = chunk.match(/anchors\s*\n([\s\S]*?)(?=```|infographic\s+\S+)/i);
		const anchors = anchorsSection ? parseAnchorsBlock(anchorsSection[1]!) : [];

		const fence = chunk.match(/```(?:infographic|infograph)?\s*([\s\S]*?)```/i);
		let dsl = fence?.[1]?.trim() ?? "";
		if (!dsl) {
			const idx = chunk.search(/^infographic\s+\S+/m);
			if (idx >= 0) dsl = chunk.slice(idx).trim();
		}
		if (!dsl) continue;
		dsl = dsl.replace(/\nanchors\s*\n[\s\S]*$/i, "").trim();
		const cleaned = sanitizeDslForRender(dsl);
		const parsed = parseInfographicSpec(cleaned);
		if (!parsed.success) {
			console.warn("[Infograph] skip invalid panel DSL:", parsed.error);
			continue;
		}

		// Fix common field mismatch: list-column uses lists not items
		let body = parsed.content;
		if (/list-column|list-row|list-grid/i.test(body) && /^\s*items\b/m.test(body)) {
			body = body.replace(/^(\s*)items\b/m, "$1lists");
		}

		panels.push({
			id: idMatch?.[1] || `p${i + 1}`,
			title: pTitleMatch?.[1]?.trim() || `面板 ${i + 1}`,
			dsl: body,
			isJson: parsed.isJson,
			anchors,
		});
	}

	if (panels.length === 0) return null;
	return {
		title,
		coverageNote,
		logic,
		takeaways: takeaways.length ? takeaways : undefined,
		panels,
	};
}

function countDigitsInPack(pack: InfographicPack): number {
	return pack.panels.reduce((n, p) => n + (p.dsl.match(/\d/g)?.length ?? 0), 0);
}

function countGroundedAnchors(pack: InfographicPack, fullNote: string): number {
	let n = 0;
	for (const p of pack.panels) {
		for (const a of p.anchors) {
			const r = resolveAnchor(fullNote, a);
			if (r.status === "ok" || r.status === "ambiguous") n++;
		}
	}
	return n;
}

export function hasLogicPanel(pack: InfographicPack): boolean {
	const p0 = pack.panels[0];
	if (!p0) return false;
	const dsl = p0.dsl || "";
	const labels = dsl.match(/^\s+-?\s*label\s+.+$/gim) || [];
	const descs = dsl.match(/^\s+desc\s+.+$/gim) || [];
	if (labels.length < 3) return false;
	if (descs.length < Math.ceil(labels.length * 0.5)) return false;
	if (
		/sequence-roadmap-vertical|sequence-ascending|list-column|hierarchy|relation-dagre|compare-binary/i.test(
			dsl
		)
	) {
		return true;
	}
	return descs.length >= 4;
}

export function countHollowPanels(pack: InfographicPack): number {
	let hollow = 0;
	for (const p of pack.panels) {
		const dsl = p.dsl || "";
		if (/chart-/i.test(dsl)) continue;
		const labels: string[] = dsl.match(/^\s+-?\s*label\s+(.+)$/gim) ?? [];
		if (labels.length < 2) continue;
		const descs: string[] = dsl.match(/^\s+desc\s+(.+)$/gim) ?? [];
		let descChars = 0;
		for (const d of descs) {
			descChars += d.replace(/^\s+desc\s+/i, "").trim().length;
		}
		const avgDesc = descChars / Math.max(1, descs.length);
		if (descs.length < labels.length * 0.4 || avgDesc < 6) hollow++;
	}
	return hollow;
}

export interface ExtractOptions {
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
}

export async function extractInfographicDsl(
	settings: InfographicSettings,
	notePath: string,
	rawMarkdown: string,
	options: ExtractOptions = {}
): Promise<ExtractResult> {
	const maxChars = settings.maxInputChars || 28000;
	const noteText = prepareNoteText(rawMarkdown, maxChars);
	if (noteText.length < 20) {
		throw new Error("笔记内容过短，无法生成信息图。");
	}

	const headingIndex = extractHeadingIndex(rawMarkdown);
	const maxPanels = settings.maxPanels || 5;
	const reasoningEffort = (settings.llmReasoningEffort || "high").trim();
	const common = {
		baseUrl: settings.llmBaseUrl,
		apiKey: settings.llmApiKey,
		model: settings.llmModel,
		temperature: settings.llmTemperature,
		maxTokens: settings.llmMaxTokens || 8192,
		timeoutMs: settings.llmTimeoutMs || 120000,
		signal: options.signal,
		onProgress: options.onProgress,
		reasoningEffort,
	};

	options.onProgress?.("正在单次生成（主逻辑+注意点+信息图）…");
	const userPrompt = buildUserPrompt(
		notePath,
		noteText,
		headingIndex,
		maxPanels,
		reasoningEffort
	);
	let rawModelOutput = await chatCompletion({
		...common,
		messages: [
			{role: "system", content: SYSTEM_PROMPT},
			{role: "user", content: userPrompt},
		],
	});

	let pack = parseInfographPack(rawModelOutput);
	if (!pack) {
		throw new Error("无法解析模型输出的 INFOGRAPH_PACK");
	}

	const digitCount = countDigitsInPack(pack);
	const grounded0 = countGroundedAnchors(pack, rawMarkdown);
	const iconLines0 = pack.panels.reduce((n, p) => n + countIconLines(p.dsl), 0);
	const logic0 = hasLogicPanel(pack);
	const hollow0 = countHollowPanels(pack);
	const hasLogicBrief0 = Boolean(pack.logic?.thesis && pack.logic.thesis.length >= 8);
	const preGrounded = pack.panels.map((p) => ({
		...p,
		anchors: filterAndGroundAnchors(rawMarkdown, p.anchors || []),
	}));
	const missingAnchors0 = preGrounded.filter((p) => p.anchors.length === 0).length;

	if (
		pack.panels.length < 2 ||
		digitCount < 12 ||
		grounded0 < 3 ||
		iconLines0 > 4 ||
		!logic0 ||
		hollow0 > 0 ||
		missingAnchors0 > 0 ||
		!hasLogicBrief0
	) {
		options.onProgress?.("质量不足，正在修正…");
		const repairHints: string[] = [];
		if (missingAnchors0 > 0) {
			repairHints.push(
				`${missingAnchors0} panels have zero grounded anchors — each panel needs ≥3 LLM anchors: label=逻辑/论点关键词（可非原文）, quote=正文可定位原文`
			);
		}
		if (!hasLogicBrief0) {
			repairHints.push("missing logic block: need thesis + points BEFORE panels");
		}
		const repair = await chatCompletion({
			...common,
			temperature: Math.min(settings.llmTemperature, 0.25),
			messages: [
				{role: "system", content: SYSTEM_PROMPT},
				{role: "user", content: userPrompt},
				{role: "assistant", content: rawModelOutput.slice(0, 6000)},
				{
					role: "user",
					content: buildRepairPrompt(maxPanels, {
						panels: pack.panels.length,
						digitChars: digitCount,
						groundedQuotes: grounded0,
						iconLines: iconLines0,
						hasLogicPanel: logic0,
						hollowPanels: hollow0,
						hasLogicBrief: hasLogicBrief0,
						malformedHints: repairHints.length ? repairHints : undefined,
					}),
				},
			],
		});
		const repaired = parseInfographPack(repair);
		if (repaired) {
			const better =
				(hasLogicPanel(repaired) && !logic0) ||
				countHollowPanels(repaired) < hollow0 ||
				countGroundedAnchors(repaired, rawMarkdown) >= grounded0 ||
				countDigitsInPack(repaired) >= digitCount ||
				countPanelsMissingAnchors(repaired) < missingAnchors0 ||
				(Boolean(repaired.logic?.thesis) && !hasLogicBrief0);
			if (better) {
				pack = repaired;
				rawModelOutput = repair;
			}
		}
	}

	// LLM anchors only — filter + ground; never script-mine keywords from DSL
	pack = {
		...pack,
		logic: pack.logic?.thesis
			? {
					thesis: pack.logic.thesis.trim(),
					points: (pack.logic.points || []).map((p) => p.trim()).filter((p) => p.length >= 4),
				}
			: undefined,
		takeaways: pack.takeaways?.length ? pack.takeaways : undefined,
		panels: pack.panels.map((p) => ({
			...p,
			dsl: sanitizeDslForRender(p.dsl, "light"),
			anchors: filterAndGroundAnchors(rawMarkdown, p.anchors || []),
		})),
	};

	if (pack.panels.length > maxPanels) {
		pack = {...pack, panels: pack.panels.slice(0, maxPanels)};
	}

	const dsl = pack.panels.map((p) => p.dsl).join("\n\n---\n\n");
	return {pack, dsl, isJson: false, rawModelOutput};
}
