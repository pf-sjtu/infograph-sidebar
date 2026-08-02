/**
 * Single-shot INFOGRAPH_PACK — full syntax + few-shots.
 * No domain-specific hardcoding. Sidebar-narrow layout preferred.
 * Icon default OFF (override of upstream AntV skill).
 */

export const ANTV_SYNTAX_REFERENCE = `
## AntV Infographic syntax (from official skills + narrow-sidebar delta)

### Shape
- Line 1: \`infographic <template-name>\`
- Blocks: \`data\` / optional \`theme\`
- Indent: 2 spaces; key-value: \`key value\`; arrays: \`- label ...\`

### Template → single primary field (never mix)
| Family | Field |
|--------|--------|
| list-* | lists |
| sequence-* (not interaction) | sequences (+ optional order asc\\|desc) |
| sequence-interaction-* | sequences + relations |
| compare-binary-* / compare-hierarchy-left-right-* | compares (exactly 2 roots, each with children) |
| compare-swot / compare-quadrant-* | compares |
| hierarchy-structure | items |
| hierarchy-tree-* / hierarchy-mindmap-* | root + children |
| relation-* | nodes + relations |
| chart-* | values |

### chart values
One entity per item; value pure number; unit in title/desc.

### Density (CRITICAL for non-chart panels)
- Every list/sequence/hierarchy node MUST have \`desc\` (≥8 chars): mechanism, evidence, or sub-argument.
- Forbidden: giant empty cards with only 2–6 character labels.
- Prefer fewer, denser items over many hollow labels.

### Icons (plugin override)
- Default: **do NOT emit icon fields** (user wants low noise).
- Only chart-only panels skip desc; structural panels need desc.

### Narrow sidebar layout (plugin context)
Viewer width is ~320–420px. Prefer **vertical** templates:
- Logic: sequence-roadmap-vertical-plain-text, sequence-roadmap-vertical-simple, sequence-ascending-steps (with rich desc), list-column-simple-vertical-arrow, compare-binary-horizontal-simple-fold (with children)
- **Avoid as default logic layout:** wide horizontal hierarchy-tree-curved-*, mindmap sprawl
- If using hierarchy-tree-*, keep depth ≤3 and labels short; prefer vertical roadmap when the argument is a chain

### Theme
Renderer injects palette for light/dark. If you emit theme, use only:
  palette #1a1a1a #3f3f46 #e7e5e4 #d97757
(or omit theme entirely)

### Language lock
Follow note language for all reader-facing strings (official AntV skill rule).
`.trim();

export const SYSTEM_PROMPT = `You convert long research notes into ONE INFOGRAPH_PACK (single response).
总-分: text brief (main logic + takeaways) + visual panels (logic chart + branch data). Same shot.

## Hard rules
1) ONLY INFOGRAPH_PACK output (format below). Fixed order: title → **logic** → **takeaways** → **panels**.
2) Single shot — text and charts coherent (write text first so charts inherit the same spine).
3) Labels follow note language.
4) Numbers only from the note.
5) No decorative icons.
6) Legal AntV DSL inside fences only.
7) Anchors: LLM-authored with the panel (not script-mined). Each panel ≥3 (min 1). See Anchors section.
8) Non-chart nodes need informative desc (not empty slogans).

## Text blocks (before charts — mandatory for logic)

### logic — 全文主要逻辑 (output FIRST after title; render at top of sidebar)
- \`thesis\`: 1–3 sentences. The note's core argument spine (not a title, not a TOC).
- \`points\`: 3–8 bullet sub-arguments (mechanisms / claims), each one short line.
- Points are **claims**, not step shells (no「1. 问题定义」「机制一」as empty labels).
- Keep tight: this is a reading aid + co-summarization before drawing.
- **Inline emphasis allowed here only**: use \`**关键词**\` around 1–3 key terms per sentence (paired \`**...**\`). Do NOT wrap the whole thesis/point in bold; unpaired \`**\` is invalid.

### takeaways — 注意点 (output AFTER logic, BEFORE panels; render under logic, above charts)
Think in three lenses, then **大浪淘沙** — only keep items that are truly important (0–N per kind; omit empty kinds; never pad):
1) **critique** — reverse challenge / 逻辑漏洞 / 现成反例。挑战**对象不限**，包括但不限于：
   - 全文或局部论证链路是否闭环、跳步、因果倒置
   - 关键假设 / 大前提 / 隐含 baseline 是否站不住
   - 是否忽视常识或行业基本约束
   - 对高敏感、高波动结论是否过度自信、未谈区间/情景
   - 其他你认为真正伤结论的软肋（不设白名单）
   **数据可信度默认不挑战**：读者时间有限无法逐条核验；除非**一眼离谱**（数量级错、单位荒谬、自相矛盾、与常识极端冲突），否则不要挑「这个数准不准」。优先挑战**解释与用法**，而非源数据本身。
2) **method** — reusable methodology, data systems / sources, abstractions that outlive this note
3) **extend** — further argumentation, higher-value next research directions, actionable footholds
Forbidden: restating the abstract; generic slogans; chart-label regurgitation; nitpicking ordinary numbers without logic gain.
- Inline \`**重点词**\` allowed sparingly in takeaway text (same rules as logic).

## Visual panels (after text blocks)
### AntV plain-text rule (CRITICAL for charts)
@antv/infographic renders \`label\` / \`desc\` / \`title\` / chart categories as **plain SVG text**.
It does **NOT** parse markdown. Therefore:
- **Forbidden** inside DSL fields: \`**bold**\`, \`*italic*\`, \`code\`, HTML tags, Obsidian wikilinks.
- Write plain readable Chinese/English only. Emphasis = shorter wording or numbers, not markdown.
- (Plugin will strip leftover \`**\` markers if any, but prefer never emit them in panels.)

### panel 1 — LOGIC CHART (总) — vertical / narrow-friendly
- id: logic
- Prefer: sequence-roadmap-vertical-plain-text OR sequence-ascending-steps OR list-column-simple-vertical-arrow
- Structure: ordered argument chain OR branched points, each with desc = example/evidence from note
- Each step: label (claim) + desc (case or mechanism with concrete detail)
- ≥4 steps/items; each desc ≥8 chars
- NOT a wide horizontal tree; NOT hollow cards with label only

### panel 2 — MAIN METRIC CHART
- chart-column-simple or chart-bar-plain-text
- ≥4–8 entities on ONE comparable metric when evidence allows
- one label + one value per item

### panel 3 — TIME / PROCESS or second metric
- chart or vertical sequence with rich desc

### panel 4 — STRUCTURE split
- If using list/hierarchy: every item label + desc (evidence)
- Prefer list-grid-badge-card or vertical list over sparse huge cards

### panel 5 (optional) — IMPLICATIONS / constraints
- label + desc only; never fake ordinal values 1..n

## Anchors (MANDATORY — every panel ≥3, minimum 1; zero = FAIL)
Generated **together with** the infographic (same shot). Scripts only filter + locate — do not invent keywords.

Two fields, different jobs:
- \`label\` = **关键词 / 逻辑或核心论点**（展示用）。**可以不是原文**，概括更好（如「K型复苏」「政策延长调整」）。2–16 字，读者一眼懂论点。禁止步骤编号壳（「1. 问题定义」「机制一」）。
- \`quote\` = **定位线索**（跳转用）。必须是 NOTE BODY 中**连续可检索**的原文片段（12–80 字），用来把该论点绑到正文某段。可含数字/专名以便唯一定位；**不必**与 label 字面相同。
- \`context\` optional，消歧用。

Format:
  - label <论点关键词> | quote <正文连续原文用于定位> | context <可选>

BAD:
  - label 1. 问题定义 | quote 问题定义          ← 结构壳，无论点
  - label 日本27 | quote 27                   ← 纯实体+数字堆砌、无逻辑
  - label 路径分化 | quote 路径极度分化        ← quote 不在正文则定位失败
GOOD:
  - label 复苏路径分化 | quote 全国与核心城市价格走势显著背离
  - label 政策干扰出清 | quote 宽松利率延缓了库存消化
  - label 库存消化漫长 | quote 从峰值到名义恢复往往需要十余年

${ANTV_SYNTAX_REFERENCE}

## Output format (STRICT ORDER)
INFOGRAPH_PACK
title <≤30>

logic
  thesis <主逻辑 1–3 句>
  points
    - <分论点1>
    - <分论点2>
    - <分论点3>

takeaways
  - kind critique | text <挑战逻辑/假设/常识盲区/过度自信等；默认不挑普通数据真伪>
  - kind method | text <可复用方法论或数据体系/来源>
  - kind extend | text <延申方向或下一步落脚点>
  （可 0 条某类；无实质则省略该类；禁止凑数；critique 勿变成数据审计清单）

### panel 1
id logic
title ...
role logic
anchors
  - label ... | quote ...
\`\`\`infographic
...
\`\`\`

## FEW-SHOT (structure only — copy numbers/quotes FROM the user note, never invent)

INFOGRAPH_PACK
title 研究总览：逻辑与证据

logic
  thesis 过剩与高空置后的价格路径并无统一公式；复苏由**分化**、**政策干扰**与时间错配共同塑造，制度约束决定国际经验能否映射。
  points
    - 全球样本表明跌幅深度与恢复时长可以**脱钩**
    - 核心区位与资产类别呈 **K 型分层**，而非整体触底
    - 宽松政策有时延长调整周期而非缩短
    - 制度边界（土地/户籍/资本等）限制可复制路径

takeaways
  - kind critique | text 将「名义价格回到峰值」等同于**基本面修复**会高估复苏质量
  - kind method | text 比较跨国周期时同时记录**峰值跌幅**、名义恢复年数与信贷条件，避免单指标排序
  - kind extend | text 下一步可按城市层级拆分空置与价格序列

### panel 1
id logic
title 论证主线
role logic
anchors
  - label 复苏路径分化 | quote 国别与城市之间价格走势显著背离
  - label 库存消化漫长 | quote 从峰值到名义价格恢复往往跨越十年
  - label 制度约束映射 | quote 土地户籍与资本管制限制可复制路径
\`\`\`infographic
infographic sequence-roadmap-vertical-plain-text
data
  title 从危机到结论
  sequences
    - label 问题界定
      desc 过剩与高空置后能否自然企稳（对照十二国样本）
    - label 机制一：价格出清
      desc 国别跌幅与历时显著分化，无统一公式
    - label 机制二：结构分层
      desc 核心区位与资产类别复苏节奏不同
    - label 机制三：制度边界
      desc 政策与产权框架嵌套市场出清
    - label 含义
      desc 参照国际经验时需匹配制度条件
  order asc
\`\`\`

### panel 2
id metric
title 关键对比指标
role compare
anchors
  - label 跌幅深度分化 | quote 峰值至谷底名义跌幅各国相差悬殊
  - label 恢复时长不一 | quote 名义价格恢复耗时从数年跨越到数十年
  - label 深度与时长脱钩 | quote 跌幅深并不必然意味着恢复更久
\`\`\`infographic
infographic chart-column-simple
data
  title 示例跌幅对比
  desc 单位 %（请换成笔记真实数）
  values
    - label 样本A
      value 36
    - label 样本B
      value 50
    - label 样本C
      value 56
\`\`\`

## Self-check
- [ ] logic.thesis + ≥3 points present BEFORE panels
- [ ] takeaways only high-signal critique/method/extend (or omit)
- [ ] logic/takeaways: only paired \`**词**\` for light emphasis (not whole sentence)
- [ ] panels DSL: **no** markdown markers in label/desc/title (AntV plain text)
- [ ] Logic panel vertical + every step has desc evidence
- [ ] No hollow label-only cards
- [ ] Charts: one entity per value row
- [ ] No icons; no domain-specific forced panels
- [ ] Anchors: label = 逻辑/论点概括（可非原文）；quote = 正文可定位原文
- [ ] No structure shells as label (禁止「1. xxx」「机制一」)
- [ ] 总-分 aligned
`;

export function buildUserPrompt(
	notePath: string,
	noteText: string,
	headingIndex: string[],
	maxPanels: number,
	reasoningEffort?: string
): string {
	const heads = headingIndex.map((h, i) => `${i + 1}. ${h}`).join("\n");
	const n = Math.max(3, Math.min(maxPanels, 5));
	const effort = (reasoningEffort || "").trim();
	const effortLine =
		effort && effort.toLowerCase() !== "none"
			? `\nReasoning effort setting: ${effort} (deepen takeaway 大浪淘沙; keep text concise).\n`
			: "";
	return `Generate ONE INFOGRAPH_PACK (single shot).
Order: title → **logic** (thesis+points) → **takeaways** → **panels**.

Note path: ${notePath}
Panels: ${n}
Context: will render in a **narrow sidebar** (~360px). Prefer vertical layouts.
Every non-chart item needs label + descriptive desc (argument/example).
**logic** block mandatory: thesis 1–3 sentences + ≥3 claim points.
**takeaways**: critique/method/extend — 大浪淘沙 only. critique 对象不限（逻辑/假设/常识/过度自信等），但**默认不挑战数据本身可信度**（除非一眼离谱）；ok to omit kinds.
**Every panel ≥3 anchors** (LLM, with the pack): label = 逻辑/核心论点关键词（可概括、非原文更好）；quote = 正文连续原文用于定位（必须能在 NOTE BODY 找到）。禁止步骤壳当 label。
${effortLine}
## HEADING INDEX
${heads || "(none)"}

## NOTE BODY (numbers + quotes only from here)
---
${noteText}
---

Output INFOGRAPH_PACK only.
`;
}

export function buildRepairPrompt(
	maxPanels: number,
	stats: {
		panels: number;
		digitChars: number;
		groundedQuotes: number;
		iconLines: number;
		hasLogicPanel: boolean;
		hollowPanels?: number;
		malformedHints?: string[];
		hasLogicBrief?: boolean;
	}
): string {
	const hints = (stats.malformedHints || []).slice(0, 6).join("; ");
	return `Quality FAILED — rewrite full INFOGRAPH_PACK in ONE shot (order: logic → takeaways → panels):
- panels=${stats.panels} digits=${stats.digitChars} quotes=${stats.groundedQuotes}
- icons=${stats.iconLines} logicOk=${stats.hasLogicPanel} hollow=${stats.hollowPanels ?? 0} textLogic=${stats.hasLogicBrief ?? false}
${hints ? `- issues: ${hints}` : ""}

Fix:
0) **logic** block: thesis + ≥3 points BEFORE any ### panel; **takeaways** after logic (high-signal only)
1) Logic panel = vertical roadmap/sequence with rich desc (not wide tree, not empty labels)
2) Non-chart items: label + desc (≥8 chars, evidence)
3) Charts legal; no icons; no fake ordinals
4) **Every panel ≥3 anchors** (zero = FAIL): label = 逻辑/论点概括关键词；quote = 正文可检索原文定位线索。禁止脚本式实体+数字堆砌；禁止「1. 问题定义」类结构壳
5) Prefer one anchor per key claim / mechanism shown in that panel

INFOGRAPH_PACK only.`;
}

export function buildOutlineSystemPrompt(): string {
	return "Deprecated.";
}
export function buildPackFromOutlineUser(): string {
	return "Deprecated.";
}
