/**
 * LLM-provided jump marker, generated with the pack (not script-mined).
 * - label: semantic keyword (logic / core claim); may summarize, need NOT appear in note
 * - quote: locator span that MUST occur in note body (for jump); may be evidence, not the chip text
 */
export interface SourceAnchor {
	/** Chip text: 逻辑/核心论点概括（可非原文，由 LLM 生成） */
	label: string;
	/**
	 * Locator: continuous span that exists in the note body so we can jump.
	 * Used for grounding only; not necessarily what the chip displays.
	 */
	quote: string;
	/** Optional nearby phrase to disambiguate multi-match */
	context?: string;
	/** Legacy / optional section hint (not primary navigation) */
	heading?: string;
	/** Legacy alias of quote fragment */
	query?: string;
}

export type AnchorResolveStatus =
	| "ok"
	| "missing"
	| "ambiguous"
	| "too_short"
	| "empty";

/** Anchor after binding to current file text offsets. */
export interface ResolvedAnchor extends SourceAnchor {
	status: AnchorResolveStatus;
	/** Inclusive start / exclusive end char offsets in full file text */
	start: number;
	end: number;
	matchCount: number;
	message?: string;
}

/** One AntV panel inside a multi-panel set. */
export interface InfographicPanel {
	id: string;
	title: string;
	dsl: string;
	isJson: boolean;
	anchors: SourceAnchor[];
}

/** Full-text logic brief (text block before charts). */
export interface LogicBrief {
	/** 全文主逻辑，1–3 句 */
	thesis: string;
	/** 分论点列表（3–8 条短句） */
	points: string[];
}

/** Takeaway lens: critique / method / extend. */
export type TakeawayKind = "critique" | "method" | "extend";

export interface TakeawayItem {
	kind: TakeawayKind;
	/** Reader-facing body */
	text: string;
}

/** Multi-panel pack for dense research-note coverage. */
export interface InfographicPack {
	title: string;
	panels: InfographicPanel[];
	/** Free-text note from model about what was covered (not shown in UI) */
	coverageNote?: string;
	/** 全文主要逻辑 — rendered above charts */
	logic?: LogicBrief;
	/** 注意点 / takeaways — after logic, before charts */
	takeaways?: TakeawayItem[];
}

export function normalizeTakeawayKind(raw: string | undefined): TakeawayKind | null {
	const k = (raw || "").trim().toLowerCase();
	if (k === "critique" || k === "challenge" || k === "critic" || k === "批判" || k === "挑战") {
		return "critique";
	}
	if (k === "method" || k === "methodology" || k === "方法" || k === "体系") {
		return "method";
	}
	if (k === "extend" || k === "extension" || k === "next" || k === "延申" || k === "延伸" || k === "方向") {
		return "extend";
	}
	return null;
}

export function packToSerializableDsl(pack: InfographicPack): string {
	return JSON.stringify({__infographPack: 1, ...pack}, null, 2);
}

export function tryParsePack(text: string): InfographicPack | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const obj = JSON.parse(trimmed) as Partial<InfographicPack> & {__infographPack?: number};
		if (!obj.panels || !Array.isArray(obj.panels) || obj.panels.length === 0) return null;
		const logic =
			obj.logic && typeof obj.logic.thesis === "string" && obj.logic.thesis.trim()
				? {
						thesis: obj.logic.thesis.trim(),
						points: Array.isArray(obj.logic.points)
							? obj.logic.points.map((x) => String(x).trim()).filter(Boolean)
							: [],
					}
				: undefined;
		const takeaways = Array.isArray(obj.takeaways)
			? obj.takeaways
					.map((t) => {
						const kind = normalizeTakeawayKind(t?.kind);
						const text = (t?.text || "").trim();
						if (!kind || text.length < 6) return null;
						return {kind, text};
					})
					.filter((t): t is TakeawayItem => Boolean(t))
			: undefined;
		return {
			title: obj.title || "Infograph set",
			coverageNote: obj.coverageNote,
			logic,
			takeaways: takeaways?.length ? takeaways : undefined,
			panels: obj.panels.map((p, i) => ({
				id: p.id || `p${i + 1}`,
				title: p.title || `Panel ${i + 1}`,
				dsl: p.dsl,
				isJson: Boolean(p.isJson) || p.dsl.trimStart().startsWith("{"),
				anchors: (p.anchors || []).map(normalizeAnchorInput),
			})),
		};
	} catch {
		return null;
	}
}

export function normalizeAnchorInput(a: Partial<SourceAnchor>): SourceAnchor {
	const quote = (a.quote || a.query || "").trim();
	return {
		label: (a.label || quote.slice(0, 24) || "source").trim(),
		quote,
		context: a.context?.trim() || undefined,
		heading: a.heading?.trim() || undefined,
		query: a.query?.trim() || undefined,
	};
}

/** Wrap a single DSL into a one-panel pack (legacy cache). */
export function singleDslToPack(dsl: string, isJson: boolean, title = "Infographic"): InfographicPack {
	return {
		title,
		panels: [{id: "main", title, dsl, isJson, anchors: []}],
		// logic / takeaways omitted for legacy single DSL
	};
}
