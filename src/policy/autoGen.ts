import type {DslCacheEntry} from "../cache/dslCache";
import type {AutoGenPolicy} from "../settings";

export interface AutoGenDecision {
	shouldGenerate: boolean;
	reason: string;
}

/**
 * Decide whether to call LLM automatically.
 * force=true always generates (manual regenerate).
 */
export function shouldAutoGenerate(opts: {
	policy: AutoGenPolicy;
	force: boolean;
	contentHash: string;
	cache?: DslCacheEntry;
	minIntervalMin: number;
	/** true when this is first open / active file switch for this path in session — used lightly */
	isOpenOrSwitch?: boolean;
}): AutoGenDecision {
	if (opts.force) {
		return {shouldGenerate: true, reason: "手动重新生成"};
	}

	const intervalMs = Math.max(1, opts.minIntervalMin) * 60_000;
	const now = Date.now();
	const cache = opts.cache;
	const hasPack = Boolean(cache?.pack?.panels?.length || cache?.dsl?.trim());
	const lastGenAt = cache?.lastGenAt ?? 0;
	const lastGenHash = cache?.lastGenHash ?? cache?.contentHash ?? "";
	const hashChanged = !cache || cache.contentHash !== opts.contentHash || lastGenHash !== opts.contentHash;
	const elapsed = now - lastGenAt;
	const cooled = !lastGenAt || elapsed >= intervalMs;

	switch (opts.policy) {
		case "manual_only":
			if (hasPack) return {shouldGenerate: false, reason: "仅手动 · 使用缓存"};
			return {shouldGenerate: true, reason: "无缓存，首次生成"};

		case "open_once":
			if (hasPack && !hashChanged) return {shouldGenerate: false, reason: "已有缓存"};
			if (hasPack && hashChanged && !opts.isOpenOrSwitch) {
				return {shouldGenerate: false, reason: "打开时生成策略 · 编辑不自动刷"};
			}
			return {shouldGenerate: true, reason: hasPack ? "内容已变，打开时更新" : "首次生成"};

		case "always_debounce":
			if (hasPack && !hashChanged) return {shouldGenerate: false, reason: "内容未变 · 缓存"};
			return {shouldGenerate: true, reason: "防抖自动生成"};

		case "on_save_throttle":
			if (hasPack && !hashChanged) return {shouldGenerate: false, reason: "内容未变 · 缓存"};
			if (!cooled) {
				const left = Math.ceil((intervalMs - elapsed) / 60000);
				return {shouldGenerate: false, reason: `保存节流 · ${left} 分钟后可再生成`};
			}
			return {shouldGenerate: true, reason: "保存且已过冷却"};

		case "throttle_30m_on_save":
		default:
			// Show cache if hash same
			if (hasPack && !hashChanged) {
				return {shouldGenerate: false, reason: "内容未变 · 使用缓存"};
			}
			// Hash changed but within cooldown → keep showing old pack if any
			if (hasPack && hashChanged && !cooled) {
				const left = Math.ceil((intervalMs - elapsed) / 60000);
				return {
					shouldGenerate: false,
					reason: `有新保存，但未满 ${opts.minIntervalMin} 分钟（约 ${left} 分钟后可自动更新）`,
				};
			}
			// No cache, or cooled + changed, or cooled first time
			if (!hasPack) return {shouldGenerate: true, reason: "首次生成"};
			if (hashChanged && cooled) return {shouldGenerate: true, reason: "新保存且已过冷却"};
			if (!hashChanged) return {shouldGenerate: false, reason: "使用缓存"};
			return {shouldGenerate: true, reason: "自动生成"};
	}
}
