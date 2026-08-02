/**
 * Copy built plugin artifacts to the target Obsidian vault.
 *
 * Required:
 *   INFOGRAPH_OBSIDIAN_PLUGIN_DIR = path to vault plugin folder
 *   e.g. D:\Vault\.obsidian\plugins\infograph-sidebar
 *
 * Usage:
 *   $env:INFOGRAPH_OBSIDIAN_PLUGIN_DIR = "D:\path\to\.obsidian\plugins\infograph-sidebar"
 *   pnpm deploy
 */
import {copyFileSync, mkdirSync, existsSync, statSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const destDir = process.env.INFOGRAPH_OBSIDIAN_PLUGIN_DIR
	? resolve(process.env.INFOGRAPH_OBSIDIAN_PLUGIN_DIR)
	: null;

if (!destDir) {
	console.error(
		"Set INFOGRAPH_OBSIDIAN_PLUGIN_DIR to your vault plugin folder, e.g.\n" +
			'  $env:INFOGRAPH_OBSIDIAN_PLUGIN_DIR = "D:\\Vault\\.obsidian\\plugins\\infograph-sidebar"\n' +
			"  pnpm deploy"
	);
	process.exit(1);
}

const files = ["main.js", "manifest.json", "styles.css"];

function versionLabel() {
	try {
		const info = JSON.parse(readFileSync(join(root, "src", "build-info.json"), "utf8"));
		return `v${info.date}.b${info.build}`;
	} catch {
		return "vunknown";
	}
}

for (const f of files) {
	const src = join(root, f);
	if (!existsSync(src)) {
		console.error(`Missing build artifact: ${f} (run pnpm build first)`);
		process.exit(1);
	}
}

mkdirSync(destDir, {recursive: true});

for (const f of files) {
	const src = join(root, f);
	const dest = join(destDir, f);
	copyFileSync(src, dest);
	const size = statSync(dest).size;
	console.log(`Copied ${f} (${size} bytes) → ${dest}`);
}

const ver = versionLabel();
console.log(`\nDeploy complete · ${ver}`);
console.log("In Obsidian: reload plugins or restart, then enable Infograph Sidebar.");
console.log(`Plugin dir: ${destDir}`);
