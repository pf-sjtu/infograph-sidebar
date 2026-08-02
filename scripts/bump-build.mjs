/**
 * Bump build-info.json: set date=today (local) and increment build number.
 * Usage: node scripts/bump-build.mjs
 */
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "src", "build-info.json");

const now = new Date();
const y = now.getFullYear();
const m = String(now.getMonth() + 1).padStart(2, "0");
const d = String(now.getDate()).padStart(2, "0");
const date = `${y}${m}${d}`;

let prev = {date: "00000000", build: 0};
try {
	prev = JSON.parse(readFileSync(path, "utf8"));
} catch {
	// fresh
}

const build = (prev.date === date ? Number(prev.build) || 0 : 0) + 1;
const next = {date, build};
writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
console.log(`build-info → v${date}.b${build}`);
