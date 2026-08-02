export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatCompletionParams {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
	/** Abort / timeout ms (default 120s) */
	timeoutMs?: number;
	/** External abort (Stop button) */
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
	/**
	 * OpenAI-compatible reasoning effort (none|low|medium|high|xhigh|max|custom).
	 * When none/empty, field is omitted. Unsupported models typically ignore it.
	 */
	reasoningEffort?: string;
}

export async function chatCompletion(params: ChatCompletionParams): Promise<string> {
	const base = params.baseUrl.replace(/\/+$/, "");
	if (!base) throw new Error("未配置 API 地址，请在插件设置中填写。");
	if (!params.apiKey) throw new Error("未配置 API Key，请在插件设置中填写。");
	if (!params.model) throw new Error("未配置模型名称，请在插件设置中填写。");

	const url = `${base}/chat/completions`;
	const timeoutMs = params.timeoutMs ?? 120_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const onExternalAbort = () => controller.abort();
	if (params.signal) {
		if (params.signal.aborted) {
			clearTimeout(timer);
			throw new DOMException("Aborted", "AbortError");
		}
		params.signal.addEventListener("abort", onExternalAbort, {once: true});
	}

	const effort = (params.reasoningEffort || "").trim();
	const effortKey = effort.toLowerCase();
	const includeEffort = Boolean(effort) && effortKey !== "none";

	params.onProgress?.(
		includeEffort
			? `请求模型中（思考 ${effort} · 最长 ${Math.round(timeoutMs / 1000)}s）…`
			: `请求模型中（最长 ${Math.round(timeoutMs / 1000)}s）…`
	);

	try {
		const body: Record<string, unknown> = {
			model: params.model,
			messages: params.messages,
			temperature: params.temperature ?? 0.3,
			max_tokens: params.maxTokens ?? 4096,
		};
		// OpenAI-compatible: reasoning_effort; providers that do not support it ignore the field
		if (includeEffort) {
			body.reasoning_effort = effort;
		}

		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${params.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			const snippet = errBody.replace(/\s+/g, " ").slice(0, 280);
			if (res.status === 401 || res.status === 403) {
				throw new Error(`模型鉴权失败 HTTP ${res.status}：请检查 API Key`);
			}
			if (res.status === 429) {
				throw new Error(`模型限流 HTTP 429：请稍后重试${snippet ? ` · ${snippet}` : ""}`);
			}
			if (res.status >= 500) {
				throw new Error(`模型服务异常 HTTP ${res.status}${snippet ? `：${snippet}` : ""}`);
			}
			throw new Error(`模型 HTTP ${res.status}${snippet ? `：${snippet}` : ""}`);
		}

		let data: {
			choices?: Array<{message?: {content?: string}}>;
			error?: {message?: string};
		};
		try {
			data = (await res.json()) as typeof data;
		} catch {
			throw new Error("模型返回非 JSON，请检查 API 地址是否为 OpenAI 兼容 /chat/completions");
		}
		if (data.error?.message) {
			throw new Error(`模型错误：${String(data.error.message).slice(0, 280)}`);
		}
		const content = data.choices?.[0]?.message?.content;
		if (!content?.trim()) throw new Error("模型返回为空（choices[0].message.content 缺失）");
		return content;
	} catch (e) {
		if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) {
			// External stop button / note switch abort — not a timeout
			if (params.signal?.aborted) {
				throw new Error("已停止生成");
			}
			throw new Error(
				`模型请求超时（>${Math.round(timeoutMs / 1000)}s）。请检查网络/API 或减小输入长度。`
			);
		}
		throw e;
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener("abort", onExternalAbort);
	}
}
