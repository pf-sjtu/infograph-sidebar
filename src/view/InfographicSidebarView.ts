import {ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf} from "obsidian";
import type InfographicPlugin from "../main";
import {VIEW_TYPE_INFOGRAPH_SIDEBAR} from "../constants";
import {InfographicRenderChild} from "../renderer";
import {ExportModal, SourceCodeModal} from "../ui";
import {resolveDslForFile} from "../service/dslService";
import {parseInfographicSpec} from "../parser";
import type {InfographicPack, InfographicPanel, ResolvedAnchor} from "../types/pack";
import {resolveAnchors} from "../utils/anchorResolve";
import {jumpToResolvedAnchor} from "../utils/navigate";
import {dslLooksRenderable, sanitizeDslForRender} from "../utils/dslSanitize";
import {setInlineMarkdown} from "../utils/inlineMarkdown";
import {getVersionLabel} from "../version";
import {hasCachedPack} from "../cache/dslCache";
import {filterAndGroundAnchors} from "../llm/extract";

type StatusKind = "idle" | "loading" | "cached" | "ready" | "error";

/** Cap session open-once bookkeeping to avoid unbounded growth. */
const OPENED_ONCE_MAX = 200;

export class InfographicSidebarView extends ItemView {
	plugin: InfographicPlugin;
	private statusEl!: HTMLElement;
	private metaEl!: HTMLElement;
	private canvasHost!: HTMLElement;
	private progressEl!: HTMLElement;
	private primaryBtn!: HTMLButtonElement;
	private renderChildren: InfographicRenderChild[] = [];
	private svgClickCleanups: Array<() => void> = [];
	private currentPack: InfographicPack | null = null;
	private currentDsl = "";
	private currentPath = "";
	private currentFile: TFile | null = null;
	private currentFullText = "";
	/** Content hash of the pack currently painted in the canvas (skip rebuild when unchanged). */
	private currentContentHash = "";
	private generationToken = 0;
	private bodyEl: HTMLElement | null = null;
	private debounceTimer: number | null = null;
	private progressTimer: number | null = null;
	private loadingStartedAt = 0;
	private abortController: AbortController | null = null;
	/** Paths already auto-opened this session (insertion order; capped). */
	private openedOnce = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: InfographicPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_INFOGRAPH_SIDEBAR;
	}

	getDisplayText(): string {
		return "Infograph";
	}

	getIcon(): string {
		return "pie-chart";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("infograph-sidebar-root");

		// Fixed top chrome (no gap, no scroll-away under buttons)
		const chrome = root.createDiv({cls: "infograph-sidebar-chrome"});
		const header = chrome.createDiv({cls: "infograph-sidebar-header"});
		header.createDiv({
			text: "Infograph Sidebar",
			cls: "infograph-sidebar-brand",
		});
		header.createDiv({
			text: getVersionLabel(),
			cls: "infograph-sidebar-version",
		});

		const toolbar = chrome.createDiv({cls: "infograph-sidebar-toolbar"});
		this.primaryBtn = this.mkBtn(toolbar, "重新生成", "", () => this.onPrimaryClick());
		this.mkBtn(toolbar, "导出", "", () => this.exportCurrent());
		this.mkBtn(toolbar, "复制 DSL", "", () => this.copyDsl());
		this.mkBtn(toolbar, "插入笔记", "", () => void this.insertDslIntoNote());
		this.mkBtn(toolbar, "查看 DSL", "", () => {
			if (!this.currentDsl) {
				new Notice("暂无 DSL");
				return;
			}
			new SourceCodeModal(this.app, this.currentDsl).open();
		});

		// Scrollable body with bottom safe area for status bar
		const body = root.createDiv({cls: "infograph-sidebar-body"});
		this.bodyEl = body;
		// Keep scroll position when charts reflow (AntV resize); avoid browser scroll anchoring jumps
		body.style.overflowAnchor = "none";
		this.statusEl = body.createDiv({cls: "infograph-sidebar-status"});
		this.progressEl = body.createDiv({cls: "infograph-sidebar-progress is-hidden"});
		this.progressEl.createDiv({cls: "infograph-sidebar-progress-bar"});
		this.metaEl = body.createDiv({cls: "infograph-sidebar-meta"});
		this.canvasHost = body.createDiv({cls: "infograph-sidebar-canvas-host"});

		this.setStatus("idle", "打开笔记后按策略自动生成或读取缓存。");
		await this.refresh({force: false, isOpenOrSwitch: true});
	}

	async onClose(): Promise<void> {
		this.clearDebounce();
		this.stopGeneration();
		this.stopProgress();
		this.destroyRenderChildren();
	}

	scheduleRefresh(force = false): void {
		this.clearDebounce();
		const ms = this.plugin.settings.debounceMs || 2500;
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.refresh({force, isOpenOrSwitch: false});
		}, force ? 0 : ms);
	}

	private onPrimaryClick(): void {
		if (this.abortController) {
			this.stopGeneration();
			this.setStatus("idle", "已停止生成");
			this.setPrimaryIdle();
			return;
		}
		void this.refresh({force: true, isOpenOrSwitch: false});
	}

	private stopGeneration(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.stopProgress();
		this.setPrimaryIdle();
	}

	private setPrimaryLoading(): void {
		if (!this.primaryBtn) return;
		this.primaryBtn.setText("停止生成");
		this.primaryBtn.removeClass("mod-cta");
		this.primaryBtn.addClass("is-stop");
	}

	private setPrimaryIdle(): void {
		if (!this.primaryBtn) return;
		this.primaryBtn.setText("重新生成");
		this.primaryBtn.removeClass("is-stop");
		this.primaryBtn.removeClass("mod-cta");
	}

	/** Track open-once paths with hard cap (FIFO eviction). */
	private markOpenedOnce(path: string): void {
		if (this.openedOnce.has(path)) return;
		this.openedOnce.add(path);
		if (this.openedOnce.size <= OPENED_ONCE_MAX) return;
		const first = this.openedOnce.values().next().value as string | undefined;
		if (first) this.openedOnce.delete(first);
	}

	/** Only the latest generation token may reset loading UI. */
	private finishLoadingIfCurrent(token: number): void {
		if (token !== this.generationToken) return;
		if (this.abortController) this.abortController = null;
		this.stopProgress();
		this.setPrimaryIdle();
	}

	async refresh(options: {force?: boolean; isOpenOrSwitch?: boolean} = {}): Promise<void> {
		const token = ++this.generationToken;
		const file = this.getActiveMarkdownFile();
		if (!file) {
			this.clearSidebarDisplay();
			this.currentPath = "";
			this.currentFile = null;
			this.currentContentHash = "";
			this.stopProgress();
			this.setPrimaryIdle();
			this.setStatus("idle", "当前没有打开的 Markdown 文件。");
			return;
		}

		const prevPath = this.currentPath;
		const pathChanged = Boolean(prevPath && prevPath !== file.path);

		// Switching notes: never keep showing the previous note's chart
		if (pathChanged) {
			if (this.abortController) {
				this.abortController.abort();
				this.abortController = null;
			}
			this.clearSidebarDisplay();
		}

		this.currentFile = file;
		this.currentPath = file.path;
		const isOpen = options.isOpenOrSwitch || !this.openedOnce.has(file.path);
		if (isOpen) this.markOpenedOnce(file.path);

		const hasCache = hasCachedPack(this.plugin.dslCache, file.path);
		if (!hasCache && !this.currentPack) {
			this.clearSidebarDisplay();
			this.currentPath = file.path;
			this.currentFile = file;
		}

		// Already painted same note: avoid flashing "loading…" (that + rebuild caused scroll jumps)
		const alreadyShowing =
			!options.force &&
			Boolean(this.currentPack?.panels.length) &&
			this.currentPath === file.path &&
			Boolean(this.currentContentHash);

		// Cache fast-path UI: no "停止生成" chrome; LLM path keeps full loading controls
		const likelyCacheOnly = hasCache && !options.force;
		this.abortController = new AbortController();
		if (alreadyShowing && likelyCacheOnly) {
			// Silent re-check — keep scroll & canvas; only update if hash actually changed
			this.setPrimaryIdle();
			this.stopProgress();
		} else if (likelyCacheOnly) {
			this.setPrimaryIdle();
			this.stopProgress();
			this.setStatus("loading", "正在读取缓存…");
		} else {
			this.setPrimaryLoading();
			this.startProgress();
			this.setStatus(
				"loading",
				options.force ? "正在重新生成…" : hasCache ? "正在读取缓存…" : "无缓存，正在生成…"
			);
		}

		try {
			const resolved = await resolveDslForFile(this.plugin, file, {
				force: options.force,
				signal: this.abortController.signal,
				isOpenOrSwitch: isOpen,
				onProgress: (msg) => {
					if (token !== this.generationToken) return;
					// Escalated from cache expectation to real LLM call
					if (likelyCacheOnly && !this.primaryBtn?.classList.contains("is-stop")) {
						this.setPrimaryLoading();
						this.startProgress();
					}
					this.setStatus("loading", msg);
				},
			});
			// Stale generation: do not touch UI (owner is newer token)
			if (token !== this.generationToken) return;
			const stillActive = this.getActiveMarkdownFile();
			if (!stillActive || stillActive.path !== file.path) {
				this.finishLoadingIfCurrent(token);
				return;
			}

			// Same note + same content hash already on screen → do NOT rebuild DOM (preserves scroll)
			if (
				!options.force &&
				resolved.path === file.path &&
				this.currentPack?.panels.length &&
				this.currentContentHash &&
				resolved.contentHash === this.currentContentHash
			) {
				this.finishLoadingIfCurrent(token);
				const n = this.currentPack.panels.length;
				const base =
					resolved.source === "cache"
						? `缓存 · ${n} 面板`
						: `已生成 · ${n} 面板`;
				this.setStatus(
					resolved.source === "cache" ? "cached" : "ready",
					resolved.policyNote ? `${base} · ${resolved.policyNote}` : base
				);
				return;
			}

			const fullText = await this.app.vault.cachedRead(file);
			if (token !== this.generationToken) return;

			this.finishLoadingIfCurrent(token);
			await this.renderPack(
				resolved.pack,
				resolved.source === "cache" ? "cached" : "ready",
				resolved.path,
				file,
				fullText,
				resolved.policyNote,
				token,
				resolved.contentHash
			);
		} catch (e) {
			// Stale: leave UI to the active generation
			if (token !== this.generationToken) return;
			this.finishLoadingIfCurrent(token);
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("停止") || /abort/i.test(msg)) {
				this.setStatus("idle", "已停止生成");
				return;
			}
			// Keep prior chart only if it belongs to the same note path
			const sameNote =
				Boolean(this.currentPack?.panels.length) &&
				this.currentPath === file.path &&
				hasCache;
			if (sameNote) {
				this.setStatus("error", msg);
				new Notice(`信息图：${msg}`, 6000);
				return;
			}
			this.clearSidebarDisplay();
			this.currentPath = file.path;
			this.currentFile = file;
			this.setStatus("error", msg);
			new Notice(`信息图：${msg}`, 8000);
		}
	}

	/** Wipe rendered pack/canvas (used on note switch / no-cache). */
	private clearSidebarDisplay(): void {
		this.destroyRenderChildren();
		this.currentDsl = "";
		this.currentPack = null;
		this.currentFullText = "";
		this.currentContentHash = "";
		this.canvasHost?.empty();
	}

	private getScrollEl(): HTMLElement | null {
		return this.bodyEl;
	}

	private captureScroll(): number {
		return this.getScrollEl()?.scrollTop ?? 0;
	}

	private restoreScroll(top: number): void {
		const el = this.getScrollEl();
		if (!el) return;
		// Double rAF: after AntV layout + images
		const apply = () => {
			el.scrollTop = top;
		};
		apply();
		window.requestAnimationFrame(() => {
			apply();
			window.requestAnimationFrame(apply);
		});
	}

	private async renderPack(
		pack: InfographicPack,
		status: StatusKind,
		path: string,
		file: TFile,
		fullText: string,
		policyNote?: string,
		token?: number,
		contentHash?: string
	): Promise<void> {
		const isCurrent = () =>
			token === undefined ||
			(token === this.generationToken && this.currentPath === path);

		if (!pack.panels.length) {
			if (isCurrent()) this.setStatus("error", "信息图集为空");
			return;
		}

		const isDark = document.body.classList.contains("theme-dark");
		const colorMode = isDark ? "dark" : "light";
		// Sanitize once per panel; reuse for parse + render
		const panels: InfographicPanel[] = [];
		for (const p of pack.panels) {
			const sanitized = sanitizeDslForRender(p.dsl, colorMode);
			if (!dslLooksRenderable(sanitized)) {
				console.warn("[Infograph] skip panel", p.title, sanitized.slice(0, 100));
				continue;
			}
			const parsed = parseInfographicSpec(sanitized);
			if (!parsed.success) continue;
			panels.push({...p, dsl: parsed.content, isJson: parsed.isJson});
		}
		if (!panels.length) {
			if (isCurrent()) this.setStatus("error", "全部面板 DSL 无效。请重新生成。");
			return;
		}
		if (!isCurrent()) return;

		// Preserve scroll when rebuilding (theme refresh / forced regen on same note)
		const prevScroll = this.captureScroll();
		const sameNoteRebuild = Boolean(this.currentPack) && this.currentPath === path;

		const validPack: InfographicPack = {...pack, panels};
		this.currentPack = validPack;
		this.currentDsl = panels.map((p, i) => `### ${p.title || i + 1}\n${p.dsl}`).join("\n\n");
		this.currentPath = path;
		this.currentFile = file;
		this.currentFullText = fullText;
		if (contentHash) this.currentContentHash = contentHash;

		this.destroyRenderChildren();
		this.canvasHost.empty();

		if (validPack.title) {
			this.canvasHost.createEl("h3", {
				text: validPack.title,
				cls: "infograph-pack-title",
			});
		}

		this.renderLogicBrief(this.canvasHost, validPack.logic);
		this.renderTakeaways(this.canvasHost, validPack.takeaways);

		const theme = this.plugin.settings.theme;
		const cacheDir = `${this.plugin.manifest.dir}/print-cache`;

		let okAnchors = 0;
		let badAnchors = 0;
		const nextFrame = () =>
			new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

		for (let i = 0; i < panels.length; i++) {
			if (!isCurrent()) return;
			const panel = panels[i]!;
			const section = this.canvasHost.createDiv({cls: "infograph-panel-section"});
			section.createEl("h4", {
				text: panel.title,
				cls: "infograph-panel-title",
			});

			const container = section.createDiv({
				cls: "infographic-wrapper infograph-sidebar-wrapper",
			});
			const renderContainer = container.createDiv({cls: "infographic-render"});
			const renderDsl = panel.dsl;

			const child = new InfographicRenderChild(renderContainer, {
				app: this.app,
				cacheDir,
				content: renderDsl,
				isJson: panel.isJson && renderDsl.trimStart().startsWith("{"),
				theme,
				isDarkMode: isDark,
				isPrinting: false,
			});
			this.addChild(child);
			child.ensureStarted();
			this.renderChildren.push(child);

			if (i < panels.length - 1) await nextFrame();

			const grounded = filterAndGroundAnchors(fullText, panel.anchors || []);
			const resolved = resolveAnchors(fullText, grounded);
			const unique = resolved.filter((a) => a.status === "ok");
			const ambiguous = resolved.filter((a) => a.status === "ambiguous");
			const okList =
				unique.length >= 2 ? unique.slice(0, 6) : [...unique, ...ambiguous].slice(0, 6);
			okAnchors += okList.length;
			badAnchors += resolved.length - okList.length;

			this.renderAnchorChips(section, okList, file);
			const bindPath = path;
			const bindToken = token;
			window.setTimeout(() => {
				if (bindToken !== undefined && bindToken !== this.generationToken) return;
				if (this.currentPath !== bindPath) return;
				this.bindSvgTextClicks(renderContainer, okList, file);
			}, 400);
		}

		if (!isCurrent()) return;
		const n = panels.length;
		const linkInfo =
			`锚点 ${okAnchors}` + (badAnchors ? ` · 失效 ${badAnchors}` : "");
		const base =
			status === "cached"
				? `缓存 · ${n} 面板 · ${linkInfo}`
				: `已生成 · ${n} 面板 · ${linkInfo}`;
		this.setStatus(status, policyNote ? `${base} · ${policyNote}` : base);

		// Same-note rebuild (or any rebuild after user had scrolled): restore position
		if (sameNoteRebuild && prevScroll > 0) {
			this.restoreScroll(prevScroll);
		}
	}

	/** 全文主要逻辑：thesis + 分论点列表（支持 **重点** 行内加粗） */
	private renderLogicBrief(
		host: HTMLElement,
		logic: InfographicPack["logic"] | undefined
	): void {
		if (!logic?.thesis?.trim()) return;
		const card = host.createDiv({cls: "infograph-text-card infograph-logic-card"});
		card.createEl("h4", {text: "全文主逻辑", cls: "infograph-text-card-title"});
		const thesisEl = card.createEl("p", {cls: "infograph-logic-thesis"});
		setInlineMarkdown(thesisEl, logic.thesis.trim());
		const points = (logic.points || []).map((p) => p.trim()).filter((p) => p.length >= 4);
		if (points.length) {
			const ul = card.createEl("ul", {cls: "infograph-logic-points"});
			for (const p of points) {
				const li = ul.createEl("li");
				setInlineMarkdown(li, p);
			}
		}
	}

	/** 注意点 takeaways：批判 / 方法 / 延申（支持 **重点** 行内加粗） */
	private renderTakeaways(
		host: HTMLElement,
		takeaways: InfographicPack["takeaways"] | undefined
	): void {
		const items = (takeaways || []).filter((t) => t?.text && t.text.trim().length >= 6);
		if (!items.length) return;
		const card = host.createDiv({cls: "infograph-text-card infograph-takeaway-card"});
		card.createEl("h4", {text: "注意点", cls: "infograph-text-card-title"});
		const list = card.createDiv({cls: "infograph-takeaway-list"});
		const kindLabel: Record<string, string> = {
			critique: "批判·挑战",
			method: "方法·体系",
			extend: "延申·方向",
		};
		for (const t of items) {
			const row = list.createDiv({
				cls: `infograph-takeaway-item kind-${t.kind}`,
			});
			row.createEl("span", {
				text: kindLabel[t.kind] || t.kind,
				cls: "infograph-takeaway-kind",
			});
			const textEl = row.createEl("span", {cls: "infograph-takeaway-text"});
			setInlineMarkdown(textEl, t.text.trim());
		}
	}

	/**
	 * Keyword chips: LLM claim keywords (may summarize). Tooltip = grounded body span.
	 * No section title, no coverage note.
	 */
	private renderAnchorChips(
		section: HTMLElement,
		resolved: ResolvedAnchor[],
		file: TFile
	): void {
		const okList = resolved.filter((a) => a.status === "ok" || a.status === "ambiguous");
		if (!okList.length) return;

		const nav = section.createDiv({cls: "infograph-anchor-nav"});
		const list = nav.createDiv({cls: "infograph-anchor-list"});
		for (const a of okList) {
			// Chip = LLM label (逻辑/论点); never re-mint from quote mechanically
			const chip = (a.label || "").replace(/\s+/g, " ").trim().slice(0, 18);
			if (!chip) continue;
			const btn = list.createEl("button", {
				text: chip,
				cls:
					a.status === "ambiguous"
						? "infograph-anchor-btn is-ambiguous"
						: "infograph-anchor-btn is-ok",
				attr: {
					title: a.quote
						? `${a.status === "ambiguous" ? "多处匹配 · " : ""}${a.quote}`
						: chip,
				},
			});
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				void this.onAnchorClick(file, a);
			});
		}
	}

	private async onAnchorClick(file: TFile, anchor: ResolvedAnchor): Promise<void> {
		let latest = this.currentFullText;
		try {
			latest = await this.app.vault.cachedRead(file);
			this.currentFullText = latest;
		} catch {
			// keep
		}
		await jumpToResolvedAnchor(this.app, file, anchor, latest);
	}

	private bindSvgTextClicks(
		renderContainer: HTMLElement,
		resolved: ResolvedAnchor[],
		file: TFile
	): void {
		const svg = renderContainer.querySelector("svg");
		if (!svg) return;
		const okList = resolved.filter((a) => a.status === "ok" || a.status === "ambiguous");
		if (!okList.length) return;

		const handler = (ev: Event) => {
			const t = ev.target as Element | null;
			const textEl = t?.closest?.("text");
			if (!textEl || !svg.contains(textEl)) return;
			const content = (textEl.textContent || "").replace(/\s+/g, " ").trim();
			if (!content) return;
			// Match SVG text to claim keyword or shared digits in locator quote
			const hit =
				okList.find((a) => a.label && a.label.length >= 2 && content.includes(a.label.trim())) ||
				okList.find((a) => {
					const nums = a.quote.match(/\d+(?:\.\d+)?%?/g) || [];
					return nums.some((n) => n.length >= 2 && content.includes(n));
				});
			if (!hit) return;
			ev.preventDefault();
			void this.onAnchorClick(file, hit);
		};
		svg.addEventListener("click", handler);
		svg.classList.add("infograph-svg-hot");
		this.svgClickCleanups.push(() => svg.removeEventListener("click", handler));
	}

	private destroyRenderChildren(): void {
		for (const c of this.svgClickCleanups) c();
		this.svgClickCleanups = [];
		for (const c of this.renderChildren) this.removeChild(c);
		this.renderChildren = [];
		this.canvasHost?.empty();
	}

	private setStatus(kind: StatusKind, text: string): void {
		if (!this.statusEl) return;
		this.statusEl.setAttr("data-status", kind);
		this.statusEl.setText(text);
	}

	private startProgress(): void {
		this.loadingStartedAt = Date.now();
		this.progressEl?.removeClass("is-hidden");
		this.stopProgressTicker();
		this.progressTimer = window.setInterval(() => {
			const sec = Math.round((Date.now() - this.loadingStartedAt) / 1000);
			if (this.statusEl?.getAttr("data-status") === "loading") {
				const cur = this.statusEl.getText() || "";
				if (!cur.includes("已等待")) {
					this.statusEl.setText(`${cur} · 已等待 ${sec}s`);
				} else {
					this.statusEl.setText(cur.replace(/已等待 \d+s/, `已等待 ${sec}s`));
				}
			}
		}, 1000);
	}

	private stopProgress(): void {
		this.progressEl?.addClass("is-hidden");
		this.stopProgressTicker();
	}

	private stopProgressTicker(): void {
		if (this.progressTimer !== null) {
			window.clearInterval(this.progressTimer);
			this.progressTimer = null;
		}
	}

	private getActiveMarkdownFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === "md") return file;
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	}

	private mkBtn(
		parent: HTMLElement,
		text: string,
		extraCls: string,
		onClick: () => void
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			text,
			cls: extraCls ? `infograph-sidebar-btn ${extraCls}` : "infograph-sidebar-btn",
		});
		btn.addEventListener("click", onClick);
		return btn;
	}

	private exportCurrent(): void {
		const ig = this.renderChildren[0]?.getInfographic();
		if (!ig) {
			new Notice("暂无可导出内容");
			return;
		}
		const name =
			this.currentPath.replace(/[\\/]/g, "_").replace(/\.md$/i, "") || "infographic";
		new ExportModal(this.app, ig, name).open();
		if (this.renderChildren.length > 1) {
			new Notice("已打开首个面板导出；完整包请用「复制 DSL」");
		}
	}

	private copyDsl(): void {
		const pack = this.currentPack;
		const textParts: string[] = [];
		if (pack?.logic?.thesis) {
			textParts.push(
				`logic\n  thesis ${pack.logic.thesis}\n  points\n${(pack.logic.points || [])
					.map((p) => `    - ${p}`)
					.join("\n")}`
			);
		}
		if (pack?.takeaways?.length) {
			textParts.push(
				`takeaways\n${pack.takeaways.map((t) => `  - kind ${t.kind} | text ${t.text}`).join("\n")}`
			);
		}
		const body = [textParts.join("\n\n"), this.currentDsl].filter(Boolean).join("\n\n");
		if (!body) {
			new Notice("暂无 DSL");
			return;
		}
		navigator.clipboard.writeText(body).then(
			() => new Notice("已复制信息图 DSL（含主逻辑/注意点）"),
			() => new Notice("复制失败")
		);
	}

	private async insertDslIntoNote(): Promise<void> {
		if (!this.currentPack?.panels.length) {
			new Notice("暂无信息图可插入");
			return;
		}
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice("没有活动笔记");
			return;
		}
		const pack = this.currentPack;
		const textMd: string[] = [];
		if (pack.logic?.thesis) {
			textMd.push("### 全文主逻辑\n");
			textMd.push(`${pack.logic.thesis.trim()}\n`);
			const pts = (pack.logic.points || []).filter((p) => p.trim().length >= 4);
			if (pts.length) {
				textMd.push(pts.map((p) => `- ${p.trim()}`).join("\n") + "\n");
			}
		}
		if (pack.takeaways?.length) {
			const kindLabel: Record<string, string> = {
				critique: "批判·挑战",
				method: "方法·体系",
				extend: "延申·方向",
			};
			textMd.push("### 注意点\n");
			for (const t of pack.takeaways) {
				textMd.push(`- **${kindLabel[t.kind] || t.kind}**：${t.text.trim()}\n`);
			}
		}
		const blocks = pack.panels
			.map((p) => {
				const sanitized = sanitizeDslForRender(p.dsl);
				const anchorLines = (p.anchors || [])
					.map((a) => `- ${a.label}: ${a.quote}`)
					.join("\n");
				const meta = anchorLines ? `\n<!-- infograph-quotes\n${anchorLines}\n-->\n` : "";
				return `\n### ${p.title}\n${meta}\n\`\`\`infographic\n${sanitized.trim()}\n\`\`\`\n`;
			})
			.join("");
		const content = await this.app.vault.read(file);
		const header = textMd.length ? textMd.join("\n") + "\n" : "";
		await this.app.vault.modify(
			file,
			content.trimEnd() + "\n\n## 信息图集\n\n" + header + blocks
		);
		new Notice(`已插入主逻辑/注意点与 ${pack.panels.length} 个信息图代码块`);
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
