# Infograph Sidebar

面向研究笔记的 Obsidian 插件：用 **OpenAI 兼容 LLM** 在侧栏生成多面板信息图，并保留上游 **AntV Infographic** 的 ````infographic` 代码块渲染。

**基于 [shuuul/obsidian-infographic](https://github.com/shuuul/obsidian-infographic)**（Apache-2.0）。详见 `NOTICE` 与 `LICENSE`。

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README_CN.md">简体中文</a>
</p>

## 功能

1. **代码块** — 渲染 ````infographic`（JSON 或 AntV DSL）、实时预览、PNG/SVG 导出、PDF 快照（上游）
2. **侧栏** — LLM 输出 **逻辑总览 + 要点 + 多面板**；默认黑白灰 + 少量 Claude 橙
3. **原文锚点** — 从面板跳回笔记中的引用/标题
4. **自动生成策略** — 可配置（默认：有新保存且满间隔才自动再生成）
5. **停止生成** — 侧栏可中断进行中的请求

版本展示：`vYYYYMMDD.bN`（生产构建时自动 bump）。

## 安装（手动 / 开发）

1. 构建插件（见下文）
2. 将 `main.js`、`manifest.json`、`styles.css` 复制到：

   ```text
   <你的库>/.obsidian/plugins/infograph-sidebar/
   ```

3. Obsidian：**设置 → 社区插件** — 如需关闭限制模式，启用 **Infograph Sidebar**，重载

或使用部署脚本：

```bash
pnpm install
pnpm run build:esbuild
# PowerShell:
$env:INFOGRAPH_OBSIDIAN_PLUGIN_DIR = "D:\path\to\Vault\.obsidian\plugins\infograph-sidebar"
pnpm deploy
# 或: pnpm release   # build:esbuild + deploy
```

> **安全：** API Key 只保存在库内插件的 `data.json`（已被 gitignore）。切勿提交 `data.json` 或把密钥写进仓库。

## 设置

| 区域 | 内容 |
|------|------|
| 代码块 | 自动渲染、主题、失败行为 |
| LLM | OpenAI 兼容地址 / API Key / 模型、温度、输入长度、输出 Token、reasoning effort |
| 自动生成 | 策略、最小间隔、防抖、缓存上限、最短笔记字数 |

## 命令

| 命令 | 作用 |
|------|------|
| Open Infograph sidebar | 打开右侧栏 |
| Regenerate infographic for current note | 强制走 LLM（忽略缓存） |
| Clear infographic cache (current / all) | 清除缓存 |
| Insert template / Refresh in current note | 上游代码块辅助 |

## 使用流程

1. 打开较长的研究类 Markdown 笔记
2. 打开侧栏（功能区饼图图标或命令）
3. 在设置中配置 LLM，点 **重新生成**
4. 浏览多面板；用跳转芯片回到正文
5. 按需 **复制 DSL** / **插入笔记** / **导出**

缓存按笔记路径 + 内容 hash（含面板数版本键）命中。

### 密度建议

- 长研报优先用强推理模型
- 设置 → 最大面板 4–5、最大输入 ≥ 28000、最大输出 Token ≥ 8192
- 若输出偏口号，可再点一次重新生成

## 开发

```bash
pnpm install
pnpm run dev          # esbuild watch
pnpm run build        # tsc + 生产包
pnpm run lint
pnpm run test:sanitize
```

CLI 单次抽取（从本地 `data.json` 读凭据 — 勿提交该文件）：

```bash
node scripts/cli-gen.mjs --note path/to.md --data path/to/plugin/data.json --out tmp/pack_out.md
```

## 隐私与脱敏

| 项 | 状态 |
|----|------|
| API Key | 仅 vault `data.json`（gitignore） |
| 部署路径 | 仅环境变量 `INFOGRAPH_OBSIDIAN_PLUGIN_DIR` |
| `main.js` | 生成物，gitignore |
| `tmp/` | 本地调试，gitignore |
| `.env` | ignore |

## 许可证

Apache-2.0 — 见 `LICENSE` 与 `NOTICE`。
