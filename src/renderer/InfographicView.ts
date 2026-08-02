import type {App} from "obsidian";
import {MarkdownRenderChild} from "obsidian";
import {Infographic, type InfographicOptions} from "@antv/infographic";
import type {ThemeSetting} from "../settings";
import {sanitizeDslForRender} from "../utils/dslSanitize";
import {persistSnapshotDataUrl} from "./snapshotFileCache";

declare const activeWindow: Window;

export interface RenderOptions {
	app: App;
	cacheDir: string;
	content: string;
	isJson: boolean;
	theme: ThemeSetting;
	isDarkMode: boolean;
	/** True when Obsidian is in PDF export mode */
	isPrinting?: boolean;
}

interface ParsedInfographicConfig {
	width?: number;
	height?: number;
	theme?: string;
	template?: string;
	data?: InfographicOptions["data"];
}

const DEFAULT_ASPECT_RATIO = 4 / 3;
/** Single chart max height: 2/3 of available viewport/sidebar height */
const MAX_HEIGHT_RATIO = 2 / 3;

export class InfographicRenderChild extends MarkdownRenderChild {
	private infographic: Infographic | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private options: RenderOptions;
	private loadingEl: HTMLElement | null = null;
	private aspectRatio: number = DEFAULT_ASPECT_RATIO;
	private snapshotRefreshTimer: number | null = null;
	private resizeRaf: number | null = null;
	private started: boolean = false;

	constructor(containerEl: HTMLElement, options: RenderOptions) {
		super(containerEl);
		this.options = options;
	}

	onload(): void {
		this.ensureStarted();
	}

	onunload(): void {
		this.cleanup();
	}

	getInfographic(): Infographic | null {
		return this.infographic;
	}

	/**
	 * Some Obsidian render pipelines (notably PDF export) may not invoke
	 * MarkdownRenderChild lifecycle hooks. This makes rendering idempotent and callable.
	 */
	ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.showLoading();
		this.render();
		this.setupResizeObserver();
	}

	private getTheme(): string | undefined {
		if (this.options.theme === "auto") {
			return this.options.isDarkMode ? "dark" : "light";
		}
		return this.options.theme;
	}

	private showLoading(): void {
		this.containerEl.empty();
		this.containerEl.addClass("infographic-container");
		this.loadingEl = this.containerEl.createDiv({cls: "infographic-loading"});
		this.loadingEl.setText("正在渲染信息图…");
	}

	private hideLoading(): void {
		if (this.loadingEl) {
			this.loadingEl.remove();
			this.loadingEl = null;
		}
	}

	/**
	 * Stable layout box (do NOT read self/parent that shrink-wraps the chart —
	 * that causes a width feedback loop and under-fills the sidebar).
	 *
	 * maxH = 2/3 of the **visible frame** (sidebar root or window), NEVER the
	 * scrollable canvas-host content height (that grows with panels and defeats the cap).
	 */
	private getLayoutBox(): {maxW: number; maxH: number} {
		const section =
			this.containerEl.closest(".infograph-panel-section") ||
			this.containerEl.closest(".infograph-sidebar-wrapper") ||
			this.containerEl.closest(".infographic-wrapper");
		const root = this.containerEl.closest(".infograph-sidebar-root") as HTMLElement | null;
		const viewContent = this.containerEl.closest(".view-content") as HTMLElement | null;

		const maxW = Math.max(
			200,
			(section as HTMLElement | null)?.clientWidth ||
				root?.clientWidth ||
				viewContent?.clientWidth ||
				this.containerEl.parentElement?.parentElement?.clientWidth ||
				360
		);

		// Visible frame height only (viewport / leaf), not content-sized hosts
		const winH = activeWindow.innerHeight || 800;
		const rootH = root?.clientHeight || 0;
		const viewH = viewContent?.clientHeight || 0;
		// Prefer the leaf/sidebar viewport; fall back to window
		const frameH =
			rootH >= 160 ? rootH : viewH >= 160 ? viewH : winH;
		const maxH = Math.max(160, Math.floor(frameH * MAX_HEIGHT_RATIO));
		return {maxW, maxH};
	}

	/**
	 * Largest rectangle of aspect ratio `ar` that fits in maxW × maxH.
	 * Prefer full width when possible; if height would exceed maxH, scale both down.
	 * Hard-cap height at maxH (2/3 frame). No scrollbars.
	 */
	private measureSize(): {width: number; height: number; maxH: number} {
		const {maxW, maxH} = this.getLayoutBox();
		// Clamp AR so a bad SVG viewBox cannot force a tiny canvas
		// Allow taller charts than before (0.4) so vertical roadmaps still use width well,
		// but height is always hard-capped at maxH below.
		let ar = this.aspectRatio;
		if (!(ar > 0) || !Number.isFinite(ar)) ar = DEFAULT_ASPECT_RATIO;
		ar = Math.min(3.2, Math.max(0.4, ar));

		// contain: height = min(maxH, maxW/ar), width = height * ar
		let height = Math.min(maxH, maxW / ar);
		let width = height * ar;

		// Prefer full width when under height cap
		if (width < maxW - 0.5 && height < maxH - 0.5) {
			width = maxW;
			height = width / ar;
			if (height > maxH) {
				height = maxH;
				width = height * ar;
			}
		}

		width = Math.floor(Math.min(maxW, Math.max(160, width)));
		// Hard ceiling: never exceed 2/3 frame height
		height = Math.floor(Math.min(maxH, Math.max(120, width / ar)));
		if (height > maxH) height = maxH;
		if (width > maxW) width = maxW;

		// Exact pixel box + hard max-height; clip overflow; center if narrower
		this.containerEl.style.overflow = "hidden";
		this.containerEl.style.boxSizing = "border-box";
		this.containerEl.style.maxWidth = "100%";
		this.containerEl.style.maxHeight = `${maxH}px`;
		this.containerEl.style.width = `${width}px`;
		this.containerEl.style.height = `${height}px`;
		this.containerEl.style.marginLeft = "auto";
		this.containerEl.style.marginRight = "auto";

		// Also clamp wrapper so AntV cannot expand the section past maxH
		const wrapper = this.containerEl.closest(
			".infograph-sidebar-wrapper, .infographic-wrapper"
		) as HTMLElement | null;
		if (wrapper) {
			wrapper.style.maxHeight = `${maxH + 16}px`;
			wrapper.style.overflow = "hidden";
		}

		return {width, height, maxH};
	}

	private render(): void {
		const theme = this.getTheme();
		const {width, height} = this.measureSize();

		// Re-apply light/dark palette so DSL matches Obsidian theme
		const mode = theme === "dark" ? "dark" : "light";
		let content = this.options.content;
		if (!this.options.isJson) {
			content = sanitizeDslForRender(content, mode);
		}

		try {
			if (this.options.isJson) {
				const parsed = JSON.parse(content) as ParsedInfographicConfig;
				this.infographic = new Infographic({
					container: this.containerEl,
					width: parsed.width ?? width,
					height: Math.min(parsed.height ?? height, height),
					theme: parsed.theme ?? theme,
					...parsed,
				});
				this.infographic.render();
			} else {
				this.infographic = new Infographic({
					container: this.containerEl,
					width,
					height,
					theme,
				});
				this.infographic.render(content);
			}
			this.hideLoading();
			this.updateAspectRatioFromSVG();
			// Print snapshot only when PDF/print path needs it (sidebar skips — big win)
			this.schedulePrintSnapshotRefresh();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error("[Infographic Plugin] Render error:", message, {
				content: content.substring(0, 200),
				isJson: this.options.isJson,
			});
			this.hideLoading();
			this.renderError(message);
		}
	}

	/** True when we should build PNG/SVG snapshots for PDF export. */
	private needsPrintSnapshot(): boolean {
		if (this.options.isPrinting) return true;
		// Sidebar live view has no print container — skip expensive toDataURL
		if (this.containerEl.closest(".infograph-sidebar-root")) return false;
		return Boolean(this.getPrintContainerEl());
	}

	private setupResizeObserver(): void {
		if (typeof ResizeObserver === "undefined") return;

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.infographic || !this.containerEl.isConnected) return;
			// Coalesce to one update per animation frame (multi-panel sidebar drag)
			if (this.resizeRaf !== null) return;
			this.resizeRaf = activeWindow.requestAnimationFrame(() => {
				this.resizeRaf = null;
				if (!this.infographic || !this.containerEl.isConnected) return;
				const {width, height} = this.measureSize();
				try {
					this.infographic.update({width, height});
				} catch {
					// ignore transient AntV resize errors
				}
				this.schedulePrintSnapshotRefresh();
			});
		});

		// Observe stable full-width ancestors, not the shrink-wrapped chart itself
		const section = this.containerEl.closest(".infograph-panel-section");
		const host = this.containerEl.closest(".infograph-sidebar-canvas-host");
		const target =
			(section as HTMLElement | null) ||
			(host as HTMLElement | null) ||
			this.containerEl.parentElement ||
			this.containerEl;
		this.resizeObserver.observe(target);
	}

	private renderError(message: string): void {
		this.containerEl.empty();
		this.containerEl.addClass("infographic-error");
		
		const errorDiv = this.containerEl.createDiv({cls: "infographic-error-message"});
		errorDiv.setText(`Failed to render infographic: ${message}`);
	}

	private updateAspectRatioFromSVG(): void {
		if (!this.infographic) return;

		const svg = this.containerEl.querySelector("svg");
		if (!svg) return;

		let nextAr: number | null = null;
		const viewBox = svg.getAttribute("viewBox");
		if (viewBox) {
			const parts = viewBox.split(/\s+/).map(Number);
			const vbWidth = parts[2];
			const vbHeight = parts[3];
			if (
				parts.length === 4 &&
				vbWidth !== undefined &&
				vbHeight !== undefined &&
				vbWidth > 0 &&
				vbHeight > 0
			) {
				nextAr = vbWidth / vbHeight;
			}
		}
		if (nextAr === null) {
			const rect = svg.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				nextAr = rect.width / rect.height;
			}
		}
		if (nextAr === null || !Number.isFinite(nextAr) || nextAr <= 0) return;

		// Ignore pathological ARs; allow tall vertical layouts (floor 0.4) but height still hard-capped
		const clamped = Math.min(3.2, Math.max(0.4, nextAr));
		if (Math.abs(clamped - this.aspectRatio) < 0.02) return;
		this.aspectRatio = clamped;
		this.resizeToFit();
	}

	private resizeToFit(): void {
		if (!this.infographic) return;
		const {width, height} = this.measureSize();
		this.infographic.update({width, height});
	}

	private destroyInfographic(): void {
		if (this.infographic) {
			try {
				this.infographic.destroy();
			} catch {
				// AntV Infographic may throw during cleanup if already destroyed
			}
			this.infographic = null;
		}
	}

	private cleanup(): void {
		if (this.snapshotRefreshTimer) {
			activeWindow.clearTimeout(this.snapshotRefreshTimer);
			this.snapshotRefreshTimer = null;
		}
		if (this.resizeRaf !== null) {
			activeWindow.cancelAnimationFrame(this.resizeRaf);
			this.resizeRaf = null;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		this.destroyInfographic();
	}

	private getPrintContainerEl(): HTMLElement | null {
		const wrapper = this.containerEl.closest<HTMLElement>(".infographic-wrapper");
		return wrapper?.querySelector<HTMLElement>(".infographic-print") ?? null;
	}

	private setPrintSnapshot(dataUrl: string, source: "antv" | "dom", persisted?: string): void {
		const printEl = this.getPrintContainerEl();
		if (!printEl) return;
		const wrapper = this.containerEl.closest<HTMLElement>(".infographic-wrapper");
		wrapper?.addClass("infographic-has-print");
		printEl.empty();
		const img = printEl.createEl("img", { cls: "infographic-print-img" });
		img.dataset.source = source;
		// Keep data URL primary for maximum compatibility with PDF renderers.
		img.setAttribute("src", dataUrl);
		if (persisted) {
			img.dataset.persistedSrc = persisted;
		}
		img.setAttribute("alt", "Infographic");
	}

	private schedulePrintSnapshotRefresh(): void {
		if (!this.needsPrintSnapshot()) return;
		if (this.snapshotRefreshTimer) activeWindow.clearTimeout(this.snapshotRefreshTimer);
		this.snapshotRefreshTimer = activeWindow.setTimeout(() => {
			this.snapshotRefreshTimer = null;
			void this.generatePrintSnapshot();
		}, 250);
	}

	private async generatePrintSnapshot(): Promise<void> {
		if (!this.infographic) return;
		const keyBase = `${this.getTheme() ?? ""}|${this.options.isJson ? "json" : "dsl"}|${this.options.content}`;
		// Prefer PNG for printing reliability.
		try {
			const dataUrl = await this.infographic.toDataURL({ type: "png" });
			if (dataUrl) {
				let persisted: string | undefined;
				try {
					persisted = await persistSnapshotDataUrl(this.options.app, this.options.cacheDir, dataUrl, "png", `${keyBase}|png`);
				} catch {
					// keep dataUrl only
				}
				this.setPrintSnapshot(dataUrl, "antv", persisted);
			}
			return;
		} catch {
			// Fall back to SVG data-url export.
		}

		try {
			const dataUrl = await this.infographic.toDataURL({ type: "svg" });
			if (dataUrl) {
				let persisted: string | undefined;
				try {
					persisted = await persistSnapshotDataUrl(this.options.app, this.options.cacheDir, dataUrl, "svg", `${keyBase}|svg`);
				} catch {
					// keep dataUrl only
				}
				this.setPrintSnapshot(dataUrl, "antv", persisted);
			}
		} catch {
			// If export fails, do nothing; the DOM snapshot fallback may still work via beforeprint.
		}
	}
}
