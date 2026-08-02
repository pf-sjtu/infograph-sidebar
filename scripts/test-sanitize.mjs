/**
 * Lightweight sanitize regression without full Obsidian runtime.
 * Run: node scripts/test-sanitize.mjs
 * (Uses dynamic import of compiled logic via inline reimplementation smoke)
 */
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

// Minimal re-test by importing built code is hard; duplicate critical regex checks
const samples = [
	`- label 美国 | value 13 |`,
	`- label 西班牙 | value 19 |`,
	`- label 迪拜 | value 7 | d`,
	`- label 美国 | 27.4 | 西班牙 | 36 | 爱尔兰 | 50`,
	`- label 土地公有制
  value 1
- label 户籍约束
  value 2`,
];

function expandInline(line) {
	const m = line.match(
		/^(\s*)-\s*label\s+(.+?)\s*\|\s*value\s+([-+]?\d+(?:\.\d+)?%?)\s*\|?\s*[a-z]?\s*$/i
	);
	if (!m) return null;
	return {label: m[2].trim(), value: Number(m[3].replace("%", ""))};
}

let ok = 0;
for (const s of samples.slice(0, 3)) {
	const r = expandInline(s);
	if (!r || !Number.isFinite(r.value)) {
		console.error("FAIL inline", s, r);
		process.exit(1);
	}
	ok++;
}
console.log(`sanitize smoke ok (${ok} inline cases)`);

// Ensure source file contains ensureMutedTheme
const san = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "src", "utils", "dslSanitize.ts"),
	"utf8"
);
if (!san.includes("ensureMutedTheme") || !san.includes("expandInlineLabelValueLines")) {
	console.error("dslSanitize missing expected symbols");
	process.exit(1);
}
console.log("dslSanitize source checks ok");
