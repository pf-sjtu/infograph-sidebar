import type {TFile} from "obsidian";
import type InfographicPlugin from "../main";
import {getCacheEntry, setCacheEntry} from "../cache/dslCache";
import {extractInfographicDsl} from "../llm/extract";
import {hashText} from "../utils/hash";
import {MIN_NOTE_CHARS} from "../constants";
import type {InfographicPack} from "../types/pack";
import {singleDslToPack} from "../types/pack";
import {shouldAutoGenerate} from "../policy/autoGen";
import {sanitizeDslForRender} from "../utils/dslSanitize";

export type DslSource = "cache" | "llm";

export interface ResolvedDsl {
	pack: InfographicPack;
	dsl: string;
	isJson: boolean;
	source: DslSource;
	contentHash: string;
	path: string;
	policyNote?: string;
}

/**
 * Rebuild a renderable pack from cache. Drops empty/invalid panels.
 * Returns null if nothing usable (treat as cache miss → regenerate).
 */
function packFromCache(cache: ReturnType<typeof getCacheEntry>): InfographicPack | null {
	if (!cache) return null;
	if (cache.pack?.panels?.length) {
		const panels = cache.pack.panels
			.filter((p) => p && typeof p.dsl === "string" && p.dsl.trim().length > 8)
			.map((p, i) => ({
				id: p.id || `p${i + 1}`,
				title: p.title || `面板 ${i + 1}`,
				dsl: sanitizeDslForRender(p.dsl),
				isJson: Boolean(p.isJson) || p.dsl.trimStart().startsWith("{"),
				anchors: Array.isArray(p.anchors) ? p.anchors : [],
			}))
			.filter((p) => p.dsl.trim().length > 8);
		if (!panels.length) return null;
		// Soft-normalize optional text blocks (never throw on corrupt cache)
		let logic = cache.pack.logic;
		if (logic && (typeof logic.thesis !== "string" || !logic.thesis.trim())) {
			logic = undefined;
		} else if (logic) {
			logic = {
				thesis: logic.thesis.trim(),
				points: Array.isArray(logic.points)
					? logic.points.map((x) => String(x).trim()).filter(Boolean)
					: [],
			};
		}
		let takeaways = cache.pack.takeaways;
		if (Array.isArray(takeaways)) {
			takeaways = takeaways.filter(
				(t) => t && typeof t.text === "string" && t.text.trim().length >= 6
			);
			if (!takeaways.length) takeaways = undefined;
		} else {
			takeaways = undefined;
		}
		return {
			title: cache.pack.title || "信息图集",
			coverageNote: cache.pack.coverageNote,
			logic,
			takeaways,
			panels,
		};
	}
	if (cache.dsl?.trim()) {
		return singleDslToPack(
			sanitizeDslForRender(cache.dsl),
			cache.dsl.trimStart().startsWith("{")
		);
	}
	return null;
}

export async function resolveDslForFile(
	plugin: InfographicPlugin,
	file: TFile,
	options: {
		force?: boolean;
		signal?: AbortSignal;
		isOpenOrSwitch?: boolean;
		onProgress?: (msg: string) => void;
	} = {}
): Promise<ResolvedDsl> {
	const raw = await plugin.app.vault.cachedRead(file);
	const contentHash = await hashText(
		raw +
			`|v4.2-text+oneshot|panels:${plugin.settings.maxPanels || 5}|effort:${plugin.settings.llmReasoningEffort || "high"}`
	);
	const path = file.path;
	const cache = getCacheEntry(plugin.dslCache, path);
	const cachedPack = packFromCache(cache);

	const decision = shouldAutoGenerate({
		policy: plugin.settings.autoGenPolicy || "throttle_30m_on_save",
		force: Boolean(options.force),
		contentHash,
		cache,
		minIntervalMin: plugin.settings.autoGenMinIntervalMin || 30,
		isOpenOrSwitch: options.isOpenOrSwitch,
	});

	if (!decision.shouldGenerate && cachedPack) {
		return {
			pack: cachedPack,
			dsl: cachedPack.panels.map((p) => p.dsl).join("\n\n---\n\n"),
			isJson: false,
			source: "cache",
			contentHash,
			path,
			policyNote: decision.reason,
		};
	}

	const bodyLen = raw.replace(/^---[\s\S]*?\n---/, "").trim().length;
	if (bodyLen < (plugin.settings.minNoteChars || MIN_NOTE_CHARS)) {
		throw new Error(`笔记过短（${bodyLen} 字）。请补充内容或降低最小字数。`);
	}

	// No cache and policy skipped → still generate once
	options.onProgress?.("正在调用模型…");
	const extracted = await extractInfographicDsl(plugin.settings, path, raw, {
		signal: options.signal,
		onProgress: options.onProgress,
	});

	const now = Date.now();
	// One pack per note path: replace prior version; cap distinct notes (default 100)
	const maxEntries = plugin.settings.maxCacheEntries ?? 100;
	plugin.dslCache = setCacheEntry(
		plugin.dslCache,
		path,
		{
			contentHash,
			dsl: extracted.dsl,
			pack: extracted.pack,
			model: plugin.settings.llmModel,
			updatedAt: new Date().toISOString(),
			lastGenAt: now,
			lastGenHash: contentHash,
		},
		maxEntries
	);
	await plugin.savePluginData();

	return {
		pack: extracted.pack,
		dsl: extracted.dsl,
		isJson: extracted.isJson,
		source: "llm",
		contentHash,
		path,
		policyNote: decision.reason,
	};
}
