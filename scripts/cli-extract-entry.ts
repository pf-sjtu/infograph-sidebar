import {extractInfographicDsl} from "../src/llm/extract";
import type {InfographicSettings} from "../src/settings";
import {DEFAULT_SETTINGS} from "../src/settings";

export async function runExtract(
	partial: Partial<InfographicSettings>,
	notePath: string,
	rawMarkdown: string
) {
	const settings: InfographicSettings = {
		...DEFAULT_SETTINGS,
		...partial,
		useTwoStageGen: false,
	};
	return extractInfographicDsl(settings, notePath, rawMarkdown, {
		onProgress: (m) => console.error("[progress]", m),
	});
}
