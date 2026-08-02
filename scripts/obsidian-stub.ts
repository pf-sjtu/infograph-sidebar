/** Minimal stub so CLI can bundle extract without real Obsidian. */
export class Notice {
	constructor(_msg?: string, _timeout?: number) {}
}
export class App {}
export class PluginSettingTab {
	constructor(_app?: unknown, _plugin?: unknown) {}
	display(): void {}
}
export class Setting {
	constructor(_el?: unknown) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addToggle() {
		return this;
	}
	addText() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addSlider() {
		return this;
	}
}
