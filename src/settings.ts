import {App, PluginSettingTab, Setting} from "obsidian";
import type InfographicPlugin from "./main";
import {DEFAULT_DEPLOY_HINT} from "./constants";
import {getVersionLabel} from "./version";

export type ThemeSetting = "auto" | "light" | "dark";
export type ErrorBehavior = "show-code" | "show-error" | "hide";

/** Auto-generation policy for sidebar. */
export type AutoGenPolicy =
	| "throttle_30m_on_save"
	| "open_once"
	| "on_save_throttle"
	| "always_debounce"
	| "manual_only";

export interface InfographicSettings {
	autoRender: boolean;
	theme: ThemeSetting;
	errorBehavior: ErrorBehavior;
	llmBaseUrl: string;
	llmApiKey: string;
	llmModel: string;
	llmTemperature: number;
	maxInputChars: number;
	llmMaxTokens: number;
	maxPanels: number;
	/** @deprecated use autoGenPolicy; kept for migration */
	autoGenerate: boolean;
	debounceMs: number;
	minNoteChars: number;
	llmTimeoutMs: number;
	autoGenPolicy: AutoGenPolicy;
	/** Minimum minutes between auto generations */
	autoGenMinIntervalMin: number;
	/**
	 * Max distinct notes with a cached pack (1 note path → 1 pack).
	 * Note update replaces same path; over limit drops oldest notes.
	 */
	maxCacheEntries: number;
	/** @deprecated always single-shot now; kept for settings migration */
	useTwoStageGen: boolean;
	/**
	 * LLM reasoning / thinking intensity.
	 * Presets: none | low | medium | high | xhigh | max — or any free-form string.
	 * Default high. Sent as OpenAI-compatible `reasoning_effort` when not none.
	 */
	llmReasoningEffort: string;
}

export const DEFAULT_SETTINGS: InfographicSettings = {
	autoRender: true,
	theme: "auto",
	errorBehavior: "show-code",
	llmBaseUrl: "",
	llmApiKey: "",
	llmModel: "",
	llmTemperature: 0.3,
	maxInputChars: 28000,
	llmMaxTokens: 8192,
	maxPanels: 5,
	autoGenerate: true,
	debounceMs: 2500,
	minNoteChars: 40,
	llmTimeoutMs: 120000,
	autoGenPolicy: "throttle_30m_on_save",
	autoGenMinIntervalMin: 30,
	maxCacheEntries: 100,
	useTwoStageGen: false,
	llmReasoningEffort: "high",
};

/** Known presets for the reasoning effort dropdown. */
export const REASONING_EFFORT_PRESETS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export class InfographicSettingTab extends PluginSettingTab {
	plugin: InfographicPlugin;

	constructor(app: App, plugin: InfographicPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl("h2", {text: "Infograph Sidebar"});
		containerEl.createEl("p", {
			text: `Version ${getVersionLabel()} · logic brief + takeaways + AntV multi-panel + source anchors`,
			cls: "setting-item-description",
		});

		containerEl.createEl("h3", {text: "代码块渲染"});

		new Setting(containerEl)
			.setName("自动渲染代码块")
			.setDesc("预览模式下自动渲染 ```infographic 代码块")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRender).onChange(async (value) => {
					this.plugin.settings.autoRender = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("主题")
			.setDesc("信息图明暗（配色默认黑白灰+少量 Claude 橙）")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "跟随 Obsidian")
					.addOption("light", "浅色")
					.addOption("dark", "深色")
					.setValue(this.plugin.settings.theme)
					.onChange(async (value) => {
						this.plugin.settings.theme = value as ThemeSetting;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenSidebars();
					})
			);

		new Setting(containerEl)
			.setName("渲染失败时")
			.setDesc("代码块解析/渲染失败时的展示方式")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("show-code", "显示源码")
					.addOption("show-error", "仅显示错误")
					.addOption("hide", "隐藏")
					.setValue(this.plugin.settings.errorBehavior)
					.onChange(async (value) => {
						this.plugin.settings.errorBehavior = value as ErrorBehavior;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", {text: "自动生成策略"});

		new Setting(containerEl)
			.setName("策略")
			.setDesc("控制何时自动调用模型（手动「重新生成」始终可用）")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("throttle_30m_on_save", "默认：有新保存且满间隔才自动")
					.addOption("open_once", "仅打开/切换笔记时")
					.addOption("on_save_throttle", "每次保存后（受间隔限制）")
					.addOption("always_debounce", "编辑防抖即生成（费额度）")
					.addOption("manual_only", "仅手动（有缓存则只读缓存）")
					.setValue(this.plugin.settings.autoGenPolicy)
					.onChange(async (value) => {
						this.plugin.settings.autoGenPolicy = value as AutoGenPolicy;
						this.plugin.settings.autoGenerate = value !== "manual_only";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最小间隔（分钟）")
			.setDesc("自动生成冷却时间，默认 30")
			.addSlider((slider) =>
				slider
					.setLimits(5, 120, 5)
					.setValue(this.plugin.settings.autoGenMinIntervalMin)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autoGenMinIntervalMin = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("编辑防抖（毫秒）")
			.setDesc("always_debounce / 保存策略下的等待时间")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 300) {
						this.plugin.settings.debounceMs = Math.floor(n);
						await this.plugin.saveSettings();
					}
				})
			);

		const cacheCount = Object.keys(this.plugin.dslCache || {}).length;
		new Setting(containerEl)
			.setName("信息图缓存上限")
			.setDesc(
				`按笔记路径一一对应缓存（同笔记更新则替换，不占多条）。当前 ${cacheCount} 条 · 默认 100 · 超出时淘汰最久未更新的笔记缓存`
			)
			.addText((text) =>
				text.setValue(String(this.plugin.settings.maxCacheEntries ?? 100)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 1 && n <= 2000) {
						this.plugin.settings.maxCacheEntries = Math.floor(n);
						const {pruneCache} = await import("./cache/dslCache");
						this.plugin.dslCache = pruneCache(
							this.plugin.dslCache,
							this.plugin.settings.maxCacheEntries
						);
						await this.plugin.saveSettings();
						this.display();
					}
				})
			);

		containerEl.createEl("h3", {text: "LLM"});

		new Setting(containerEl)
			.setName("API 地址")
			.setDesc("OpenAI 兼容，例如 https://api.openai.com/v1")
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.llmBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.llmBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("仅存本库插件 data.json")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-…")
					.setValue(this.plugin.settings.llmApiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("模型")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o-mini / deepseek-…")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("面板数量")
			.setDesc("含逻辑总览 + 分支图，建议 4–5")
			.addSlider((slider) =>
				slider
					.setLimits(3, 6, 1)
					.setValue(this.plugin.settings.maxPanels)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxPanels = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最大输入字符")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.maxInputChars)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 4000) {
						this.plugin.settings.maxInputChars = Math.floor(n);
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("最大输出 Token")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.llmMaxTokens)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 2048) {
						this.plugin.settings.llmMaxTokens = Math.floor(n);
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("请求超时（毫秒）")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.llmTimeoutMs)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 15000) {
						this.plugin.settings.llmTimeoutMs = Math.floor(n);
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("温度")
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.llmTemperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.llmTemperature = value;
						await this.plugin.saveSettings();
					})
			);

		const effortRaw = (this.plugin.settings.llmReasoningEffort || "high").trim() || "high";
		const effortLower = effortRaw.toLowerCase();
		const isPreset = (REASONING_EFFORT_PRESETS as readonly string[]).includes(effortLower);
		new Setting(containerEl)
			.setName("LLM 思考强度")
			.setDesc(
				"OpenAI 兼容 reasoning_effort：none / low / medium / high / xhigh / max；也可手填网关自定义值。none 不传该字段。默认 high。"
			)
			.addDropdown((dropdown) => {
				for (const p of REASONING_EFFORT_PRESETS) {
					dropdown.addOption(p, p);
				}
				dropdown.addOption("__custom__", "custom（手填）");
				dropdown
					.setValue(isPreset ? effortLower : "__custom__")
					.onChange(async (value) => {
						if (value === "__custom__") {
							// keep current free-form if already custom; else seed empty for typing
							if (isPreset) {
								this.plugin.settings.llmReasoningEffort = "";
							}
						} else {
							this.plugin.settings.llmReasoningEffort = value;
						}
						await this.plugin.saveSettings();
						this.display();
					});
			})
			.addText((text) => {
				text
					.setPlaceholder("high 或自定义")
					.setValue(effortRaw)
					.onChange(async (value) => {
						const v = value.trim();
						this.plugin.settings.llmReasoningEffort = v || "high";
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h3", {text: "部署"});
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `${getVersionLabel()} · 构建后设置 INFOGRAPH_OBSIDIAN_PLUGIN_DIR 再 pnpm deploy → ${DEFAULT_DEPLOY_HINT}`,
		});
	}
}
