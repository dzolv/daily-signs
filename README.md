# Daily Signs Toolkit

这是一个可重复使用的日签制作仓库。你可以在自己的 Figma 或 Pixso 中享受选图和调整构图，再让模型接手重复制作。仓库提供操作方案、本地交接记录 CLI，以及把 PNG 严格压缩到 200 KiB 以内的本地工具。

仓库不包含任何成品日签、背景图、源表格、Figma 文件或账号配置。Figma 登录信息、访问令牌、文件链接和节点编号也不应提交到 GitHub。

## 第一次使用

1. 安装并登录 [GitHub Desktop](https://desktop.github.com/) 和 [Codex](https://openai.com/codex/)。如果这是私有仓库，先接受维护者发来的协作者邀请。
2. 在 GitHub Desktop 选择 **File > Clone repository**，找到本仓库并克隆。如果列表没有它，在 **URL** 页签粘贴本仓库网页上的 HTTPS 地址。克隆就是把程序和说明下载到你的电脑，不会自动连接设计账号。
3. 在 Codex 中打开刚克隆的仓库目录，新建聊天，直接复制下面这段话。接下来由模型检查和运行程序，你不需要手填 JSON 或学习终端命令。

> 请先阅读 README.md、AGENTS.md、SECURITY.md 和 docs/pixso-permissions.md，带我在这台电脑上开始使用。先检查 Node.js 和 npm；缺少时引导我安装官方 Node.js 22 LTS，并说明需要我完成的操作。检查本地改动后，在仓库中运行 npm install、npm test 和 npm run build。再核实当前客户端是否提供 Pixso 连接，指导我本人登录授权，并在我指定的测试副本验证读取、必要编辑和原尺寸 1x PNG 导出。不要让我填写 JSON、粘贴密钥或把私人素材提交到 GitHub。遇到异常先诊断并做可逆的临时修复，保留我的数据和已有改动；确实有疑问时再问我。正常操作少旁白，先把这次明确指定的日签 PNG 做出来。

Pixso 账号由你本人登录；已有 Figma 的用户可使用替代路径。模型不能代替你完成账号授权，也不能从“已安装”推断连接成功。你只需提供本次参考、文案和有权使用的工作区域；安装和制作中的机械步骤交给模型。

日常从已打开的项目继续聊天即可，不必每次重新安装。仓库采用 GitHub 源码克隆使用；GitHub Release 可用于标记稳定版本，并非使用前提，也不要求下载额外安装包。

## 日常流程

所有私人素材都放在 `.local/` 中。这个目录已被 Git 忽略，不会正常进入提交。

```text
.local/
  input/          自己的背景图、文案和其他源文件
  export-raw/     从 Pixso / Figma 导出的原尺寸 1x PNG
  delivery/       每批独立目录中的指定交付 PNG 与机器记录
```

1. 在自己的 Pixso（或 Figma）文件中制作或复制日签画板。
2. 按当前参考与最新反馈制作，默认原尺寸 1x PNG 导出到 `.local/export-raw/`。不要求先固定模板，视觉检查以看清文字、无明显漏字为准。
3. 模型明确列出本次每张原始 PNG 与交付文件名，运行：

```powershell
npm run workflow -- batch-export --input .local/batch.json --output .local/delivery/new-batch
```

批次清单由模型准备，你只需拿到本次指定的 PNG。程序只处理清单里的图，不扫描旧版本；默认保留像素尺寸，成功输出不超过 200 KiB（204,800 字节），达不到则报告。中断后模型通过 `resume-batch --input .local/delivery/new-batch/report.json` 校验并继续，不重压已成功的相同输入。清单、回执与当前参考说明留在本地供新会话接续；远端设计仍由模型重新读取和判断。

Pixso 接入见 [docs/pixso-permissions.md](docs/pixso-permissions.md)，已有 Figma 的替代流程见 [docs/figma-workflow.md](docs/figma-workflow.md)。压缩器参数见 [tools/png-under-200k/README.md](tools/png-under-200k/README.md)。

## 模型辅助与实验路径

你自己选图时，可以把素材留在约定的 Figma / Pixso 区域，让模型直接读取并接手，无需重新转述。想探索新方向时，也可以让模型参考你指定的历史日签和选图习惯，提供一组候选方案，由你决定用哪张。

模型通过本地 CLI 保存素材快照、方案、已选内容和制作进度，新聊天可以从记录接着做。连接设计工具的能力由你使用的 AI 客户端提供；交接 CLI 本身不连接设计账号，也不自动启动模型。

使用方式与接入边界见 [模型辅助工作流](docs/assisted-workflow.md)，命令与输入格式见 [交接 CLI](tools/handoff/README.md)。这些命令主要供模型使用，你不需要填写交接表或 JSON。

目前先用 Pixso，不需要为这条路径注册或购买 Figma。第一次使用，模型会简短提醒你登录授权和指定画板，再在测试副本验证。采用项目范围的本地权限和按需设计工具权限，不默认要求整机 bypass；详见 [Pixso 首次接入与最小权限](docs/pixso-permissions.md)。提醒是否已经说过会保存在本地，日常使用不反复介绍。

实际操作前，模型会说明要读哪个区域、改什么、内容会交给哪些服务，以及文件存到哪里，取得你的许可再开始。你可以只同意读取，拒绝修改，或随时撤回；同一范围已明确同意时不反复询问。程序分别记录“已经介绍过”和“这次同意了哪些范围”，换账号、文件或扩大操作范围时重新检查。

## 常用命令

这些命令都在仓库根目录运行：

```powershell
npm install                 # 安装依赖
npm test                    # 检查压缩逻辑和 CLI
npm run dev                 # 打开压缩工具网页，终端会显示本地地址
npm run build               # 检查网页生产构建
npm run compress -- --help  # 查看 CLI 全部参数
npm run handoff -- --help   # 查看模型使用的本地交接命令
npm run workflow -- --help  # 模型聚合检查、保存导出/回执、比较真实设计观察
npm run setup -- status     # 模型检查是否需要首次权限说明，不登录也不修改配置
npm run consent -- --help   # 模型准备具体许可申请、记录答复并核对执行范围
npm run deps:status         # 离线检查是否到了依赖维护时间
npm run deps:check          # 查询兼容更新和安全公告，保存本地检查记录
```

压缩单张图：

```powershell
npm run compress -- ".local/export-raw/2026-08-01.png" -o ".local/export/2026-08-01.png" --no-resize
```

按指定清单批量压缩：

```powershell
npm run workflow -- batch-export --input .local/batch.json --output .local/delivery/new-batch
```

制作中优先让模型调用 [薄工作流 CLI](tools/workflow/README.md)：完整 MCP 导出交给程序解码、压缩并保存尺寸/字节/hash 回执；真实观察交给程序比较，只允许指定变化。模型负责审美与来源判断，不必每轮重写机械验证脚本。试排与预览也能记录，标签不冒充正式授权或验收。

## 依赖维护

交接 CLI 在创建或恢复任务时，会把依赖维护状态一并提供给模型。默认首次使用、超过 7 天未成功检查，或依赖清单/锁文件发生变化时提醒检查；最近检查正常时不要求重复联网。记录只保存在 `.local/maintenance/`。

模型按仓库规则在制作批次之间静默处理兼容更新，再运行测试、构建和复查。依赖使用明确的兼容版本范围与锁文件，避免 `latest` 无限制跨版本升级。需要破坏性升级、检查失败或仍有安全公告时才单独说明。

这是使用项目时触发的维护提示，不是后台定时服务；程序本身只检查和记录，升级由模型调用 npm 完成。细节见 [依赖维护工具](tools/maintenance/README.md)。

## 设计账号与隐私

Pixso / Figma 账号连接由你使用的 AI 客户端或设计服务自己管理，不由本仓库管理。每个人都应连接自己的账号，并使用自己有权操作的设计文件。不要把 API key、token、`.env`、MCP 配置、私人设计 URL 或文件/节点 ID 写进仓库，也不要为了求助把密钥粘贴到聊天里。

## 遇到问题

- `npm` 找不到或安装失败：让模型检查 Node.js/npm 和网络；需要本人安装或授权时按它的具体说明操作，不附带账号密钥。
- 网页打不开：保持 `npm run dev` 的终端窗口开启，访问终端显示的 `Local` 地址。
- 批次输出目录已存在：新批次换一个全新目录；继续原批次用 `resume-batch` 读取它的 report.json。`batch-export` 和 `save-export` 不支持覆盖；只有独立的 `compress` CLI 支持显式 `--overwrite`，使用前须确认可覆盖对应文件。
- 图片压缩失败：保留原尺寸并查看具体失败项；需要缩小尺寸时由用户决定，不自动改成 2x 导出或缩图。
- 不知道下一步：让 AI 先阅读本仓库三份说明文件，并说明你卡在哪一步。

模型可以先做可逆临时修复，让本次工作继续。仍有疑问时让它向你说明；需要维护者帮助，你可以用日常 IM 告知维护者，再由模型整理去掉私人信息的现象和必要证据。不要直接发送账号配置、完整私人记录或素材。要把修复放回仓库时，通过分支和 PR（改动提案）交维护者审查，见 [贡献与维护](CONTRIBUTING.md)。

## 更新仓库

让模型先检查本地改动，再使用 GitHub Desktop 的 **Fetch origin / Pull origin** 获取维护者已合并到 `main` 的更新。`main` 是日常使用的稳定代码线；修复分支经过 PR 审查后才合并回来。不要用强制重置、清理命令或整目录替换来更新，不删除 `.local/` 私人数据和已安装的 `node_modules`。若本地已有改动或冲突，先保留现场、让模型说明处理方案，再按授权解决。更新后由模型检查是否需要重新安装依赖，并运行测试和构建。

## 准备提交到 GitHub

提交前先运行测试，并确认 GitHub Desktop 的 Changes 列表中没有 `.local/`、图片、导出包、表格、`.env`、密钥或私人链接。安全规则见 [SECURITY.md](SECURITY.md)。

## 许可证

代码和文档采用 [MIT License](LICENSE)。仓库不包含第三方图片、字体、Figma 文件或其他内容素材；使用者需要自行确认其私人素材的授权。
