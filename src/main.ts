import {Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf} from "obsidian";
import {DEFAULT_SETTINGS, InfographicSettings, InfographicSettingTab} from "./settings";
import {parseInfographicSpec, showParseError} from "./parser";
import {InfographicRenderChild} from "./renderer";
import {
	refreshAllInfographicPrintSnapshots,
	refreshInfographicPrintSnapshot,
	renderStaticSnapshotDirect,
} from "./renderer/printSnapshot";
import {SourceCodeModal, ExportModal} from "./ui";
import {VIEW_TYPE_INFOGRAPH_SIDEBAR} from "./constants";
import {InfographicSidebarView} from "./view/InfographicSidebarView";
import type {DslCacheMap} from "./cache/dslCache";
import {clearCachePath} from "./cache/dslCache";

/**
 * Detect if Obsidian is in PDF export mode.
 * Obsidian renders PDF export inside a container with `.print` class on body or as a direct child.
 * This mirrors the detection pattern used by obsidian-excalidraw-plugin.
 */
function isPrintingMode(doc: Document): boolean {
	return (
		Boolean(doc.body.querySelectorAll("body > .print").length > 0) ||
		doc.body.classList.contains("print")
	);
}

declare const activeWindow: Window;

const INFOGRAPHIC_TEMPLATE = `{
  "template": "list-row-simple-horizontal-arrow",
  "data": {
    "items": [
      { "label": "Step 1", "desc": "Description" },
      { "label": "Step 2", "desc": "Description" },
      { "label": "Step 3", "desc": "Description" }
    ]
  }
}`;

interface StoredPluginData {
	settings?: Partial<InfographicSettings>;
	cache?: DslCacheMap;
	// legacy flat settings keys may appear at top level
	[key: string]: unknown;
}

export default class InfographicPlugin extends Plugin {
	settings: InfographicSettings = DEFAULT_SETTINGS;
	dslCache: DslCacheMap = {};

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.registerView(VIEW_TYPE_INFOGRAPH_SIDEBAR, (leaf) => new InfographicSidebarView(leaf, this));

		this.addRibbonIcon("pie-chart", "Open Infograph Sidebar", () => {
			void this.activateSidebar();
		});

		// Use async callback to properly await image generation during PDF export
		this.registerMarkdownCodeBlockProcessor("infographic", async (source, el, ctx) => {
			await this.processInfographicBlock(source, el, ctx);
		});

		this.addSettingTab(new InfographicSettingTab(this.app, this));

		this.registerCommands();
		this.registerEventHandlers();

		// Ensure PDF export (print pipeline) uses a static snapshot instead of live rendering.
		const activeDoc = activeWindow.document;
		this.registerDomEvent(activeWindow, "beforeprint", () => {
			refreshAllInfographicPrintSnapshots(activeDoc, this.app, `${this.manifest.dir}/print-cache`);
		});
	}

	onunload(): void {
		// Leaves cleaned by Obsidian
	}

	/** Last active markdown path we notified sidebars about (avoid leaf-focus noise). */
	private lastNotifiedMdPath: string | null = null;

	private registerEventHandlers(): void {
		// Only refresh sidebar when the *active markdown note path* changes.
		// Focusing sidebar / other leaves used to fire active-leaf-change → full re-render → scroll jump to top.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf) {
					const view = leaf.view;
					if (view instanceof MarkdownView) {
						this.refreshView(view);
					}
				}
				const md = this.app.workspace.getActiveFile();
				const path = md && md.extension === "md" ? md.path : null;
				// Path unchanged (e.g. user clicked infograph sidebar / graph) → do not refresh
				if (path === this.lastNotifiedMdPath) return;
				this.lastNotifiedMdPath = path;
				this.notifySidebars((v) => v.scheduleRefresh(false));
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					const active = this.app.workspace.getActiveFile();
					if (active && active.path === file.path) {
						// Content edit — sidebar decides whether hash changed (skip DOM rebuild if not)
						this.notifySidebars((v) => v.scheduleRefresh(false));
					}
				}
			})
		);
	}

	private refreshView(view: MarkdownView): void {
		const state = view.getState();
		void view.setState(state, {history: false});
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-sidebar",
			name: "Open Infograph Sidebar",
			callback: () => {
				void this.activateSidebar();
			},
		});

		this.addCommand({
			id: "regenerate-sidebar",
			name: "重新生成当前笔记信息图",
			callback: () => {
				this.notifySidebars((v) => {
					void v.refresh({force: true});
				});
				void this.activateSidebar();
			},
		});

		this.addCommand({
			id: "clear-cache-current",
			name: "清除信息图缓存（当前笔记）",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("没有活动文件");
					return;
				}
				this.dslCache = clearCachePath(this.dslCache, file.path);
				await this.savePluginData();
				new Notice(`已清除缓存：${file.path}`);
			},
		});

		this.addCommand({
			id: "clear-cache-all",
			name: "清除信息图缓存（全部）",
			callback: async () => {
				this.dslCache = {};
				await this.savePluginData();
				new Notice("已清除全部信息图缓存");
			},
		});

		this.addCommand({
			id: "insert-template",
			name: "插入信息图模板",
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const template = "```infographic\n" + INFOGRAPHIC_TEMPLATE + "\n```\n";
				editor.replaceRange(template, cursor);
				editor.setCursor({
					line: cursor.line + 2,
					ch: 0,
				});
			},
		});

		this.addCommand({
			id: "refresh-all",
			name: "刷新当前笔记中的信息图",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (checking) return true;
				const state = view.getState();
				void view.setState(state, {history: false});
				return true;
			},
		});
	}

	async activateSidebar(): Promise<void> {
		const {workspace} = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_INFOGRAPH_SIDEBAR);
		if (existing.length > 0) {
			leaf = existing[0] ?? null;
		} else {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) {
				leaf = workspace.getLeaf("tab");
			}
			await leaf.setViewState({type: VIEW_TYPE_INFOGRAPH_SIDEBAR, active: true});
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	refreshOpenSidebars(): void {
		this.notifySidebars((v) => v.scheduleRefresh(false));
	}

	private notifySidebars(fn: (view: InfographicSidebarView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INFOGRAPH_SIDEBAR)) {
			if (leaf.view instanceof InfographicSidebarView) {
				fn(leaf.view);
			}
		}
	}

	private isDarkMode(): boolean {
		return activeWindow.document.body.classList.contains("theme-dark");
	}

	private async processInfographicBlock(
		source: string,
		el: HTMLElement,
		ctx: import("obsidian").MarkdownPostProcessorContext
	): Promise<void> {
		if (!this.settings.autoRender) {
			return;
		}

		const result = parseInfographicSpec(source);

		if (!result.success) {
			console.error("[Infographic Plugin] Parse error:", result.error, {
				source: source.substring(0, 200),
			});
			showParseError(result.error);
			this.handleError(el, result.error, source);
			return;
		}

		const cacheDir = `${this.manifest.dir}/print-cache`;
		const activeDoc = activeWindow.document;
		const isPrinting = isPrintingMode(activeDoc);
		const theme =
			this.settings.theme === "auto" ? (this.isDarkMode() ? "dark" : "light") : this.settings.theme;

		if (isPrinting) {
			el.empty();
			el.addClass("infographic-print-container");
			await renderStaticSnapshotDirect(this.app, cacheDir, result.content, result.isJson, theme, el);
			return;
		}

		const container = el.createDiv({cls: "infographic-wrapper"});
		const renderContainer = container.createDiv({cls: "infographic-render"});
		container.createDiv({cls: "infographic-print"});

		const renderChild = new InfographicRenderChild(renderContainer, {
			app: this.app,
			cacheDir,
			content: result.content,
			isJson: result.isJson,
			theme: this.settings.theme,
			isDarkMode: this.isDarkMode(),
			isPrinting: false,
		});
		ctx.addChild(renderChild);
		renderChild.ensureStarted();

		activeWindow.requestAnimationFrame(() => refreshInfographicPrintSnapshot(container, this.app, cacheDir));

		const printEl = container.querySelector<HTMLElement>(".infographic-print");
		if (printEl) {
			void renderStaticSnapshotDirect(this.app, cacheDir, result.content, result.isJson, theme, printEl);
		}

		const toolbar = container.createDiv({cls: "infographic-toolbar"});

		const copyBtn = toolbar.createEl("button", {
			text: "Copy",
			cls: "infographic-toolbar-btn",
		});
		copyBtn.addEventListener("click", () => {
			navigator.clipboard
				.writeText(source.trim())
				.then(() => {
					new Notice("Copied to clipboard");
				})
				.catch(() => {
					new Notice("Failed to copy");
				});
		});

		const exportBtn = toolbar.createEl("button", {
			text: "Export",
			cls: "infographic-toolbar-btn",
		});
		exportBtn.addEventListener("click", () => {
			const infographic = renderChild.getInfographic();
			if (infographic) {
				new ExportModal(this.app, infographic).open();
			}
		});
	}

	private handleError(el: HTMLElement, error: string, source: string): void {
		switch (this.settings.errorBehavior) {
			case "hide":
				el.empty();
				el.addClass("infographic-hidden");
				break;
			case "show-error": {
				el.empty();
				el.addClass("infographic-error-block");
				const errorMsg = el.createDiv({cls: "infographic-error-header"});
				errorMsg.setText(`Error: ${error}`);
				const detailsBtn = el.createEl("button", {
					text: "View details",
					cls: "infographic-error-details-btn",
				});
				detailsBtn.addEventListener("click", () => {
					new SourceCodeModal(this.app, source).open();
				});
				break;
			}
			case "show-code":
			default: {
				el.empty();
				el.addClass("infographic-error-block");
				const errorHeader = el.createDiv({cls: "infographic-error-header"});
				errorHeader.setText(`Error: ${error}`);
				const pre = el.createEl("pre", {cls: "infographic-error-source"});
				const code = pre.createEl("code");
				code.setText(source);
				break;
			}
		}
	}

	async loadPluginData(): Promise<void> {
		const raw = (await this.loadData()) as StoredPluginData | null;
		if (!raw) {
			this.settings = {...DEFAULT_SETTINGS};
			this.dslCache = {};
			return;
		}

		const nested = (raw.settings ?? {}) as Partial<InfographicSettings>;
		// Prefer nested settings; fall back to legacy flat keys on the same object.
		const pick = <K extends keyof InfographicSettings>(key: K, fallback: InfographicSettings[K]): InfographicSettings[K] => {
			if (nested[key] !== undefined) return nested[key] as InfographicSettings[K];
			const top = raw[key as string];
			if (top !== undefined && typeof top !== "object") return top as InfographicSettings[K];
			return fallback;
		};

		this.settings = {
			autoRender: pick("autoRender", DEFAULT_SETTINGS.autoRender),
			theme: pick("theme", DEFAULT_SETTINGS.theme),
			errorBehavior: pick("errorBehavior", DEFAULT_SETTINGS.errorBehavior),
			llmBaseUrl: String(pick("llmBaseUrl", DEFAULT_SETTINGS.llmBaseUrl) ?? ""),
			llmApiKey: String(pick("llmApiKey", DEFAULT_SETTINGS.llmApiKey) ?? ""),
			llmModel: String(pick("llmModel", DEFAULT_SETTINGS.llmModel) ?? ""),
			llmTemperature: Number(pick("llmTemperature", DEFAULT_SETTINGS.llmTemperature)) || 0.3,
			maxInputChars: Number(pick("maxInputChars", DEFAULT_SETTINGS.maxInputChars)) || 28000,
			llmMaxTokens: Number(pick("llmMaxTokens", DEFAULT_SETTINGS.llmMaxTokens)) || 8192,
			maxPanels: Number(pick("maxPanels", DEFAULT_SETTINGS.maxPanels)) || 5,
			autoGenerate: Boolean(pick("autoGenerate", DEFAULT_SETTINGS.autoGenerate)),
			debounceMs: Number(pick("debounceMs", DEFAULT_SETTINGS.debounceMs)) || 2500,
			minNoteChars: Number(pick("minNoteChars", DEFAULT_SETTINGS.minNoteChars)) || 40,
			llmTimeoutMs: Number(pick("llmTimeoutMs", DEFAULT_SETTINGS.llmTimeoutMs)) || 120000,
			autoGenPolicy: (pick("autoGenPolicy", DEFAULT_SETTINGS.autoGenPolicy) ||
				DEFAULT_SETTINGS.autoGenPolicy) as typeof DEFAULT_SETTINGS.autoGenPolicy,
			autoGenMinIntervalMin:
				Number(pick("autoGenMinIntervalMin", DEFAULT_SETTINGS.autoGenMinIntervalMin)) || 30,
			maxCacheEntries: (() => {
				const n = Number(pick("maxCacheEntries", DEFAULT_SETTINGS.maxCacheEntries));
				if (Number.isFinite(n) && n >= 1 && n <= 2000) return Math.floor(n);
				return DEFAULT_SETTINGS.maxCacheEntries;
			})(),
			// Always single-shot (总-分对齐)；忽略历史 two-stage 设置
			useTwoStageGen: false,
			llmReasoningEffort: (() => {
				const v = String(
					pick("llmReasoningEffort", DEFAULT_SETTINGS.llmReasoningEffort) ?? "high"
				).trim();
				return v || DEFAULT_SETTINGS.llmReasoningEffort;
			})(),
		};
		// migrate legacy autoGenerate → policy
		if (raw) {
			const nested = raw.settings as {autoGenerate?: boolean; autoGenPolicy?: string} | undefined;
			const legacyOff =
				(nested?.autoGenerate === false || (raw as {autoGenerate?: boolean}).autoGenerate === false) &&
				!nested?.autoGenPolicy &&
				!(raw as {autoGenPolicy?: string}).autoGenPolicy;
			if (legacyOff) this.settings.autoGenPolicy = "manual_only";
		}
		const {pruneCache} = await import("./cache/dslCache");
		const loaded = (raw.cache as DslCacheMap) ?? {};
		// Enforce max distinct notes on load (path = note id)
		this.dslCache = pruneCache(loaded, this.settings.maxCacheEntries ?? 100);
	}

	async savePluginData(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			cache: this.dslCache,
		});
	}

	/** Back-compat alias used by settings tab */
	async loadSettings(): Promise<void> {
		await this.loadPluginData();
	}

	async saveSettings(): Promise<void> {
		await this.savePluginData();
	}
}
