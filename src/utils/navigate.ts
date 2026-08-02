import type {App, TFile} from "obsidian";
import {MarkdownView, Notice} from "obsidian";
import type {ResolvedAnchor} from "../types/pack";
import {offsetToLineCh, resolveAnchor} from "./anchorResolve";

export interface JumpResult {
	ok: boolean;
	reason?: string;
}

/**
 * Open note and select/scroll to a resolved text span.
 * Handles: missing file, preview mode, bad offsets, content drift.
 */
export async function jumpToResolvedAnchor(
	app: App,
	file: TFile,
	anchor: ResolvedAnchor,
	/** Re-resolve against latest file text (content may have changed) */
	latestText?: string
): Promise<JumpResult> {
	let target = anchor;

	if (latestText !== undefined) {
		target = resolveAnchor(latestText, anchor);
	}

	if (target.status === "empty" || target.status === "too_short") {
		new Notice(target.message || "定位标记无效");
		return {ok: false, reason: target.status};
	}
	if (target.status === "missing" || target.start < 0) {
		new Notice(target.message || `未在正文找到：${target.label}`);
		return {ok: false, reason: "missing"};
	}

	// Open file in a markdown leaf (prefer existing)
	let leaf = app.workspace.getLeavesOfType("markdown").find((l) => {
		const v = l.view;
		return v instanceof MarkdownView && v.file?.path === file.path;
	});
	if (!leaf) {
		leaf = app.workspace.getLeaf(false);
		await leaf.openFile(file, {active: true});
	} else {
		app.workspace.setActiveLeaf(leaf, {focus: true});
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path !== file.path) {
			await leaf.openFile(file, {active: true});
		}
	}

	const view = leaf.view;
	if (!(view instanceof MarkdownView)) {
		new Notice("无法打开 Markdown 视图");
		return {ok: false, reason: "no_markdown_view"};
	}

	// Prefer editing/source surface for reliable selection
	try {
		if (view.getMode() === "preview") {
			// Toggle to live preview / source when possible
			const state = view.getState();
			await view.setState({...state, mode: "source"}, {history: false});
		}
	} catch {
		// ignore — some builds use different state keys
	}

	// Wait a tick for editor to attach
	await new Promise((r) => window.setTimeout(r, 30));

	const editor = view.editor;
	if (!editor) {
		new Notice("编辑器未就绪，请再点一次");
		return {ok: false, reason: "no_editor"};
	}

	const text = editor.getValue();
	// Re-validate offsets against editor buffer (may differ if CRLF / unsaved)
	let start = target.start;
	let end = target.end;
	const slice = text.slice(start, end);
	const quote = target.quote;
	if (!slice || (quote && !slice.includes(quote.slice(0, Math.min(12, quote.length))) && text.indexOf(quote) !== start)) {
		const fresh = resolveAnchor(text, target);
		if (fresh.status === "ok" || fresh.status === "ambiguous") {
			start = fresh.start;
			end = fresh.end;
			target = fresh;
		} else {
			new Notice(fresh.message || "正文已变化，无法定位该片段");
			return {ok: false, reason: "drift"};
		}
	}

	const from = editor.offsetToPos ? editor.offsetToPos(start) : offsetToLineCh(text, start);
	const to = editor.offsetToPos ? editor.offsetToPos(end) : offsetToLineCh(text, end);

	try {
		editor.setSelection(from, to);
		editor.scrollIntoView({from, to}, true);
		editor.focus();
	} catch (e) {
		console.warn("[Infograph] setSelection failed", e);
		// line/ch fallback
		const f = offsetToLineCh(text, start);
		const t = offsetToLineCh(text, end);
		editor.setCursor(f);
		editor.scrollIntoView({from: f, to: t}, true);
	}

	if (target.status === "ambiguous") {
		new Notice(target.message || `多处匹配（${target.matchCount}），已定位一处`, 4000);
	}

	return {ok: true};
}

/** @deprecated heading-based — kept for any residual callers */
export async function jumpToNoteLocation(
	app: App,
	file: TFile,
	heading: string,
	query?: string
): Promise<void> {
	const text = await app.vault.cachedRead(file);
	const resolved = resolveAnchor(text, {
		label: query || heading,
		quote: query || heading,
		heading,
		query,
	});
	await jumpToResolvedAnchor(app, file, resolved, text);
}
