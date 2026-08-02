/**
 * CLI: single-shot pack generation against a markdown file.
 * Loads Obsidian plugin data.json for API settings (no key logging).
 *
 * Usage:
 *   node scripts/cli-gen.mjs --note "path/to.md" --data "path/to/data.json" [--out tmp/pack_out.md]
 *
 * --data must point to the plugin's data.json (contains API settings). Never commit that file.
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const args = process.argv.slice(2);
function getArg(name, def) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : def;
}

const noteArg = getArg("--note");
const dataArg = getArg("--data");
if (!noteArg || !dataArg) {
	console.error(
		"Usage: node scripts/cli-gen.mjs --note path/to.md --data path/to/plugin/data.json [--out tmp/pack_last.md] [--panels 5]"
	);
	process.exit(1);
}

const notePath = resolve(noteArg);
const outPath = resolve(getArg("--out", join(root, "tmp", "pack_last.md")));
const dataPath = resolve(dataArg);

if (!existsSync(notePath)) {
	console.error(`Note not found: ${notePath}`);
	process.exit(1);
}
if (!existsSync(dataPath)) {
	console.error(`data.json not found: ${dataPath}`);
	process.exit(1);
}

const bundlePath = join(root, "tmp", "cli-extract-bundle.cjs");
mkdirSync(join(root, "tmp"), {recursive: true});

await esbuild.build({
	entryPoints: [join(root, "scripts", "cli-extract-entry.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: bundlePath,
	external: [],
	sourcemap: false,
	alias: {
		obsidian: join(root, "scripts", "obsidian-stub.ts"),
	},
});

const require = createRequire(import.meta.url);
const {runExtract} = require(bundlePath);

const data = JSON.parse(readFileSync(dataPath, "utf8"));
const settings = data.settings || data;
const note = readFileSync(notePath, "utf8");

console.log("note chars", note.length);
console.log("model", settings.llmModel || "(empty)");
console.log("twoStage", settings.useTwoStageGen);

const result = await runExtract(
	{
		llmBaseUrl: settings.llmBaseUrl,
		llmApiKey: settings.llmApiKey,
		llmModel: settings.llmModel,
		llmTemperature: settings.llmTemperature ?? 0.25,
		maxInputChars: settings.maxInputChars ?? 28000,
		llmMaxTokens: settings.llmMaxTokens ?? 8192,
		llmTimeoutMs: settings.llmTimeoutMs ?? 180000,
		maxPanels: Number(getArg("--panels", settings.maxPanels ?? 5)),
		useTwoStageGen: false,
		minNoteChars: 40,
	},
	notePath,
	note
);

const pack = result.pack;
const report = {
	title: pack.title,
	panels: pack.panels.map((p) => ({
		id: p.id,
		title: p.title,
		template: (p.dsl.match(/^infographic\s+(\S+)/m) || [])[1],
		valuesCount: (p.dsl.match(/^\s*-\s*label\s+/gm) || []).length,
		anchors: (p.anchors || []).length,
		digitChars: (p.dsl.match(/\d/g) || []).length,
		dslPreview: p.dsl.slice(0, 200).replace(/\n/g, "\\n"),
	})),
	hasLogic: /hierarchy|sequence-ascending|logic|总览|结论/i.test(
		(pack.panels[0]?.id || "") + (pack.panels[0]?.title || "") + (pack.panels[0]?.dsl || "")
	),
	totalDigits: (result.dsl.match(/\d/g) || []).length,
};

writeFileSync(outPath, result.dsl, "utf8");
writeFileSync(outPath.replace(/\.md$/, ".json"), JSON.stringify({report, pack}, null, 2), "utf8");
writeFileSync(outPath.replace(/\.md$/, ".raw.txt"), result.rawModelOutput, "utf8");

console.log(JSON.stringify(report, null, 2));
console.log("wrote", outPath);
