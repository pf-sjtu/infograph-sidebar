/**
 * Prepare note text for LLM: abstract + outline + evidence lines.
 * Generic sampling only — no domain/country keyword hardcoding.
 */

export function prepareNoteText(raw: string, maxChars: number): string {
	let text = raw;
	if (text.startsWith("---")) {
		const end = text.indexOf("\n---", 3);
		if (end !== -1) text = text.slice(end + 4);
	}
	text = text.trim();
	if (text.length <= maxChars) return text;

	const lines = text.split("\n");
	const parts: string[] = [];
	let used = 0;
	const push = (line: string) => {
		if (used + line.length + 1 > maxChars) return false;
		parts.push(line);
		used += line.length + 1;
		return true;
	};

	// 1) Lead section (abstract / opening)
	let i = 0;
	const abstractCap = Math.min(Math.floor(maxChars * 0.32), 10000);
	let abstractUsed = 0;
	while (i < lines.length && abstractUsed < abstractCap) {
		const line = lines[i] ?? "";
		if (i > 20 && /^##\s+/.test(line)) break;
		if (!push(line)) break;
		abstractUsed += line.length + 1;
		i++;
	}
	push("");
	push("## [OUTLINE]");

	for (const line of lines) {
		if (/^#{1,4}\s+/.test(line)) {
			if (!push(line)) break;
		}
	}

	push("");
	push("## [EVIDENCE]");

	type Scored = {line: string; score: number; idx: number};
	const scored: Scored[] = [];
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx] ?? "";
		if (!line.trim() || /^#{1,6}\s/.test(line)) continue;
		let score = 0;
		if (/\d+(\.\d+)?%/.test(line)) score += 6;
		if (/\d{2,}[,.]?\d*/.test(line)) score += 3;
		if (/\d+(\.\d+)?\s*(年|倍|万|亿|bp|pp|个月|季度)/.test(line)) score += 4;
		if (/\*\*[^*]{2,}\*\*/.test(line)) score += 2;
		if (/\|.+\|/.test(line)) score += 3;
		if (line.length > 40 && line.length < 280) score += 1;
		if (score >= 4) scored.push({line: line.slice(0, 420), score, idx});
	}
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

	const picked = new Set<number>();
	for (const item of scored) {
		if (used >= maxChars - 200) break;
		if (picked.has(item.idx)) continue;
		let h = item.idx;
		while (h > 0 && !/^#{1,4}\s/.test(lines[h] ?? "")) h--;
		const head = lines[h];
		if (head && /^#{1,4}\s/.test(head) && !picked.has(h)) {
			picked.add(h);
			if (!push(head)) break;
		}
		picked.add(item.idx);
		if (!push(item.line)) break;
	}

	// Fill remaining budget with evenly spaced mid-document lines
	if (used < maxChars * 0.85) {
		const step = Math.max(3, Math.floor(lines.length / 40));
		for (let idx = Math.floor(lines.length * 0.1); idx < lines.length; idx += step) {
			if (used >= maxChars - 100) break;
			if (picked.has(idx)) continue;
			const line = lines[idx] ?? "";
			if (line.trim().length < 24) continue;
			picked.add(idx);
			if (!push(line.slice(0, 300))) break;
		}
	}

	return parts.join("\n") + "\n…(truncated)";
}

export function extractHeadingIndex(raw: string, max = 80): string[] {
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(/^(#{1,4})\s+(.+)$/);
		if (m) {
			out.push(m[2]!.trim());
			if (out.length >= max) break;
		}
	}
	return out;
}
