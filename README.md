# Resprout

**A canvas for divergent learning. Branch from curiosity and build your own map of understanding.**

**一个用于发散式学习的节点画布。从好奇心出发，生长并整理自己的理解地图。**

[English](#english) · [中文](#中文)

> Named after resprouting: cut a tree back to its stump and it doesn't die — it regrows, often with more shoots than before. Conversations deserve the same.

**Status: early-stage alpha.** The current interface is primarily Chinese. Expect rough edges, especially around automatic layout and generated interactive explanations.

---

## English

### What is Resprout?

Resprout turns a question into an explorable tree instead of a single scrolling chat. Select an interesting or confusing passage, ask a follow-up, and keep each direction visible on an infinite canvas. You can return to earlier branches, compare approaches, and gradually build a map of your understanding.

It is designed for **divergent learning**, not just conversation management. Text, examples, analogies, and generated interactive explanations are different ways to explore the same curiosity.

### Current features

- Infinite node canvas with zoom, minimap, selection, manual connections, and automatic arrangement.
- Drag-and-drop resizable PDF cards with continuous scrolling and drag-to-select regions for source-aware questions.
- Image cards for whole-image questions. PDF questions include the selected region as an image.
- Model context-window and vision-capability discovery, with unsupported image input rejected instead of silently ignored.
- Selection-based follow-ups with source highlighting and branch-specific context.
- Mainline and side-branch management with collapsible branches, expanded reading, node navigation, and manual mainline selection.
- Multiple model configurations with DeepSeek and OpenAI-compatible endpoints.
- Streaming responses and per-node model selection.
- Optional DeepSeek web search and page fetching to incorporate current sources into answers.
- Durable execution for ordinary text answers: request ID deduplication, committed progress, and restart reconciliation.
- Model-generated interactive HTML explanations rendered in a sandboxed iframe.
- Automatic runtime checks for rendering errors and control behavior, plus a separate model-based review of source fidelity, facts, and interaction logic.
- Local session history, JSON import/export, and local provider configuration.
- Bring your own API keys. No Resprout account or cloud synchronization is required.

### Requirements

- Node.js **22.19 or newer**
- A DeepSeek API key, or an API key and endpoint for an OpenAI-compatible provider, for model-generated content

### Run with the CLI

Run the alpha package without a global installation:

```bash
npx resprout@alpha
```

Or install the command globally:

```bash
npm install -g resprout@alpha
resprout
```

Resprout starts a local web application at **http://127.0.0.1:4173** and a local model sidecar at **127.0.0.1:8787**. The browser opens automatically unless `--no-open` is supplied.

The sidecar is a localhost-only proxy for your configured model provider; it does not download or run a model locally, and you do not need to open its address directly. Use `--sidecar-port` if the default port is unavailable.

```bash
resprout --help
resprout --version
resprout --port 4173 --sidecar-port 8787
resprout --no-open
```

The CLI only listens on `127.0.0.1`; it does not expose the application to your LAN by default. Stop both processes with `Ctrl+C`.

> Session history is stored per browser origin. Using a different frontend port or hostname can make existing history appear unavailable. Export important sessions before changing the address.

### Develop from source

Clone the repository, install dependencies, and start both the Vite frontend and the sidecar:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. To exercise the production CLI from source:

```bash
npm run build
npm start
```

Useful checks before submitting changes:

```bash
npm run build
npm pack --dry-run
```

Keep product plans, experiments, and other local-only material under `private/`. This directory is ignored by Git and excluded from npm packages.

### Data and privacy

| Data | Location |
| --- | --- |
| Session history | Browser `localStorage`, scoped to the current origin |
| Session backups | JSON files exported by the user; PDF and image binaries are not included |
| PDF and image originals | Browser IndexedDB (`resprout-files`), scoped to the current origin |
| Durable text-answer logs | `.resprout/durable/` during development; `~/.resprout/durable/` through the packaged CLI |
| Provider configuration during development | `.resprout/providers.json` in the development working directory |
| Provider configuration through the packaged CLI | `~/.resprout/providers.json` by default |

Set `RESPROUT_CONFIG_DIR` to override the local data directory for provider configuration and durable logs. Provider files are written with user-only permissions where supported.

Durable logs contain task state and text context, but no API keys or image blobs. The durable integration is experimental and currently limited to ordinary text answers. Image and PDF-page-image requests use pi-ai directly and are not written to the durable JSONL store.

API keys are not included in session exports. Keys saved through the interface are stored locally in the provider JSON file, **not in the operating system keychain**. Protect that file and never commit it to version control.

Prompts and conversation content are sent to the model provider you configure. When web search is enabled, the search query, a short form of the latest user question, and requested page URLs are sent to the DeepSeek search service. Search results and fetched page content are added to the model context. Resprout itself has no telemetry or hosted account service.

### Current limitations

- The application is an alpha prototype, not a stable desktop release.
- The interface is currently Chinese-only; this README is bilingual.
- Automatic layout for large or complex trees still needs improvement.
- Interactive generation and review can be slow or fail. Sandboxed runtime checks and model-based review do not guarantee factual or mathematical correctness; a text fallback may be shown instead.
- Durable recovery is experimental and limited to ordinary text answers. Multimodal requests do not resume through that path yet, and there is no durable compaction or DAG merge yet.
- Browser storage can be cleared by the browser or the user. Export important sessions regularly.
- There is no cloud sync, collaboration, plugin system, mobile app, or native desktop installer yet.
- The project does not yet have a comprehensive automated test suite.

### Roadmap

The near-term focus is the learning loop rather than a general-purpose agent workspace:

- Guided divergence with useful question suggestions.
- Cross-branch summaries, comparisons, and connections.
- Better automatic layout and context compression.
- More reliable interactive generation and reusable evaluation fixtures.
- Native desktop packaging and operating-system keychain integration.

### Project structure

```text
bin/       npm CLI launcher
src/       React canvas, learning interactions, and client state
sidecar/   Local model provider service
scripts/   Development server
```

### Contributing

Issues and small, focused contributions are welcome. For generation or interaction bugs, include the topic or generation stage, model name, reproduction steps, and diagnostic message when available. Remove API keys and private learning material before sharing logs or session files.

### Acknowledgments

Resprout uses the [pi](https://github.com/earendil-works/pi) ecosystem, licensed under [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE):

- `@earendil-works/pi-ai` for model provider adaptation and streaming responses.
- `@earendil-works/pi-durable` and `@earendil-works/chord` for durable execution and runtime context.

Resprout is an independent project and is not affiliated with or endorsed by Earendil Works.

### License

MIT. See [LICENSE](LICENSE). Third-party dependencies retain their respective licenses.

---

## 中文

### Resprout 是什么？

Resprout 把一个问题变成可以探索的树，而不是不断向下滚动的单一聊天。你可以选中感兴趣或没看懂的内容继续追问，让每个方向都保留在无限画布上，随时回到早期分支、比较不同思路，逐渐整理出自己的理解地图。

它面向的是**发散式学习**，不只是管理对话。文字、例子、类比和生成的交互解释，都是探索同一个疑问的不同方式。

### 当前功能

- 无限节点画布，支持缩放、小地图、框选、手动连线和自动整理。
- 拖入 PDF 生成文档卡片，支持连续滚动、拖动卡片四角调整大小，以及拖动框选后带出处提问。
- 支持独立图片节点整图提问，PDF 追问会附上框选区域的图片。
- 自动读取模型上下文窗口与视觉能力，未确认支持图片的模型会明确拒绝，而不是静默忽略。
- 划词追问、原文高亮和按分支继承上下文。
- 主线与侧枝管理，支持收起侧枝、展开阅读、定位节点和手动指定主线。
- 支持 DeepSeek 与 OpenAI 兼容端点，可配置多个供应商。
- 流式回答，并可为不同节点选择模型。
- 可选 DeepSeek 联网搜索与网页读取，将最新来源加入回答上下文。
- 普通文本回答支持持久执行：请求去重、提交进度、重启后按 answerId 对账恢复。
- 模型生成交互 HTML 解释，并在隔离 iframe 中展示。
- 自动检查渲染错误和控件行为，再通过另一次模型请求复核原文一致性、事实和交互逻辑。
- 本地历史会话、JSON 导入导出、本地供应商配置。
- 自带 API Key，不需要 Resprout 账号或云同步。

### 环境要求

- Node.js **22.19 或更高版本**
- 如果需要模型生成内容，需要 DeepSeek API Key，或 OpenAI 兼容供应商的 API Key 与端点

### 使用 CLI 启动

不全局安装，直接运行 Alpha 版本：

```bash
npx resprout@alpha
```

或者全局安装命令：

```bash
npm install -g resprout@alpha
resprout
```

启动后，本地网页地址为 **http://127.0.0.1:4173**，本地模型代理 sidecar 地址为 **http://127.0.0.1:8787**。默认自动打开浏览器，可通过 `--no-open` 关闭。

sidecar 是仅监听本机的模型供应商代理，不会下载或在本地运行模型，也不需要直接打开它的地址。如果默认端口已被占用，可使用 `--sidecar-port` 修改。

```bash
resprout --help
resprout --version
resprout --port 4173 --sidecar-port 8787
resprout --no-open
```

CLI 默认只监听 `127.0.0.1`，不会主动向局域网开放应用。按 `Ctrl+C` 可同时停止前后端进程。

> 历史会话按浏览器站点来源保存。更换前端端口或主机名后，原有历史可能看起来消失了。更换地址前请先导出重要会话。

### 从源码开发

克隆仓库后，安装依赖并同时启动 Vite 前端和 sidecar：

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址。需要从源码验证生产 CLI 时：

```bash
npm run build
npm start
```

提交改动前建议运行：

```bash
npm run build
npm pack --dry-run
```

产品计划、实验脚本和其他仅限本地的资料统一放在 `private/`。该目录会被 Git 忽略，也不会进入 npm 包。

### 数据与隐私

| 数据 | 保存位置 |
| --- | --- |
| 历史会话 | 浏览器 `localStorage`，按当前站点来源隔离 |
| 会话备份 | 用户主动导出的 JSON 文件，不包含 PDF 和图片二进制原件 |
| PDF 与图片原件 | 浏览器 IndexedDB（`resprout-files`），按当前站点来源隔离 |
| 普通文本回答的 durable 日志 | 开发时为 `.resprout/durable/`，发布版 CLI 为 `~/.resprout/durable/` |
| 源码开发时的供应商配置 | 开发目录下的 `.resprout/providers.json` |
| 通过发布版 CLI 启动时的供应商配置 | 默认 `~/.resprout/providers.json` |

可通过 `RESPROUT_CONFIG_DIR` 覆盖保存供应商配置和 durable 日志的本地数据目录。在操作系统支持的情况下，供应商文件按仅当前用户可读写权限保存。

durable 日志包含任务状态和文本上下文，但不包含 API Key 或图片二进制。该集成目前仍是实验能力，只用于普通文本回答；图片与 PDF 页图请求直接走 pi-ai，不写入 durable JSONL。

API Key 不会包含在会话导出文件中。通过界面保存的 Key 位于本地供应商 JSON 文件中，**尚未接入操作系统钥匙串**。请保护该文件，不要提交到版本控制。

提示词和对话内容会发送给你配置的模型供应商。开启联网搜索后，搜索词、最近一条用户问题的摘要和待抓取的网页 URL 会发送给 DeepSeek 搜索服务；搜索结果和网页正文会加入模型上下文。Resprout 自身没有遥测或托管账号服务。

### 当前限制

- 当前是 Alpha 原型，不是稳定的桌面正式版。
- 应用界面暂时只有中文；本 README 提供双语说明。
- 大型或复杂对话树的自动整理仍需改进。
- 交互生成和复核可能较慢或失败。隔离运行检查与模型复核不能保证事实或数学内容完全正确；失败时可能改为展示文字说明。
- durable 恢复目前属于实验能力，只覆盖普通文本回答；多模态请求暂不经过该路径恢复，也尚未接入 durable 压缩或 DAG 汇合。
- 浏览器本地数据可能被清理，请定期导出重要会话。
- 暂时没有云同步、协作、插件系统、移动应用或原生桌面安装包。
- 项目尚未建立完整的自动化测试体系。

### 路线图

近期重点是完善学习闭环，而不是扩张成通用 Agent 工作台：

- 有质量的引导式发散和问题推荐。
- 跨分支汇总、比较和建立联系。
- 更好的自动布局与上下文压缩。
- 更可靠的交互生成和可复用评测样例。
- 原生桌面打包与操作系统钥匙串接入。

### 项目结构

```text
bin/       npm CLI 启动器
src/       React 画布、学习交互和前端状态
sidecar/   本地模型供应商服务
scripts/   开发服务器
```

### 参与贡献

欢迎提交 Issue 和小而聚焦的改动。反馈生成或交互问题时，请尽量提供主题或生成阶段、模型名称、复现步骤和诊断信息。分享日志或会话文件前，请移除 API Key 和私人学习内容。

### 致谢与基础依赖

Resprout 使用基于 [MIT 协议](https://github.com/earendil-works/pi/blob/main/LICENSE)的 [pi](https://github.com/earendil-works/pi) 生态：

- `@earendil-works/pi-ai` 用于模型供应商适配和流式回答。
- `@earendil-works/pi-durable` 与 `@earendil-works/chord` 用于持久执行和运行时上下文。

Resprout 是独立项目，并非 Earendil Works 官方产品或受其背书的项目。

### 开源协议

MIT，详见 [LICENSE](LICENSE)。第三方依赖保留各自的开源协议。
