import {DEFAULT_MAX_CACHE_ENTRIES} from "../constants";
import type {InfographicPack} from "../types/pack";

/**
 * One cached pack per note path (vault-relative path is the note id).
 * Same path → replace in place when content regenerates.
 * Cap = max distinct notes, not versions of one note.
 */
export interface DslCacheEntry {
	contentHash: string;
	dsl: string;
	pack?: InfographicPack;
	model: string;
	/** ISO time of last cache write (used for LRU eviction) */
	updatedAt: string;
	/** Last successful LLM generation time (ms) */
	lastGenAt?: number;
	/** Content hash at last generation */
	lastGenHash?: string;
}

/** Keyed by vault-relative note path (one entry per note). */
export type DslCacheMap = Record<string, DslCacheEntry>;

export function getCacheEntry(cache: DslCacheMap, path: string): DslCacheEntry | undefined {
	return cache[path];
}

export function hasCachedPack(cache: DslCacheMap, path: string): boolean {
	const e = cache[path];
	return Boolean(e?.pack?.panels?.length || e?.dsl?.trim());
}

function entryAgeMs(e: DslCacheEntry | undefined): number {
	if (!e) return 0;
	if (typeof e.lastGenAt === "number" && e.lastGenAt > 0) return e.lastGenAt;
	const t = Date.parse(e.updatedAt || "");
	return Number.isFinite(t) ? t : 0;
}

/**
 * Enforce max distinct notes. Drops oldest by lastGenAt/updatedAt.
 * Never drops `protectPath` if provided (the entry just written).
 */
export function pruneCache(
	cache: DslCacheMap,
	maxEntries: number,
	protectPath?: string
): DslCacheMap {
	const max = Math.max(1, Math.min(2000, Math.floor(maxEntries) || DEFAULT_MAX_CACHE_ENTRIES));
	const keys = Object.keys(cache);
	if (keys.length <= max) return cache;

	const next: DslCacheMap = {...cache};
	const sorted = keys.slice().sort((a, b) => entryAgeMs(next[a]) - entryAgeMs(next[b]));
	let drop = sorted.length - max;
	for (const k of sorted) {
		if (drop <= 0) break;
		if (protectPath && k === protectPath) continue;
		delete next[k];
		drop--;
	}
	// If still over (protectPath edge case with max=1 etc.), drop oldest including protect only as last resort
	const remain = Object.keys(next);
	if (remain.length > max) {
		const sorted2 = remain.slice().sort((a, b) => entryAgeMs(next[a]) - entryAgeMs(next[b]));
		let d2 = sorted2.length - max;
		for (const k of sorted2) {
			if (d2 <= 0) break;
			delete next[k];
			d2--;
		}
	}
	return next;
}

/**
 * Upsert one note's pack (path = note identity). Replaces prior version for that path.
 * If size exceeds maxEntries, evicts oldest other notes first.
 */
export function setCacheEntry(
	cache: DslCacheMap,
	path: string,
	entry: DslCacheEntry,
	maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES
): DslCacheMap {
	const next: DslCacheMap = {...cache, [path]: entry};
	return pruneCache(next, maxEntries, path);
}

export function clearCachePath(cache: DslCacheMap, path: string): DslCacheMap {
	const next = {...cache};
	delete next[path];
	return next;
}

export function cacheEntryCount(cache: DslCacheMap): number {
	return Object.keys(cache).length;
}
