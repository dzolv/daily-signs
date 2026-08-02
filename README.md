# Daily Signs Toolkit

这是一个可重复使用的日签制作仓库。版式和内容在你自己的 Figma 文件中完成；仓库只提供操作说明，以及把 PNG 严格压缩到 200 KiB 以内的本地工具。

仓库不包含任何成品日签、背景图、源表格、Figma 文件或账号配置。Figma 登录信息、访问令牌、文件链接和节点编号也不应提交到 GitHub。

## 第一次使用

推荐先安装：

1. [GitHub Desktop](https://desktop.github.com/)，用来下载和更新仓库。
2. [Node.js 22 LTS](https://nodejs.org/)，用来运行压缩工具。
3. Figma 桌面版或网页版，并登录你自己的账号。

如果这是私有仓库，先打开 GitHub 发来的协作者邀请并点 **Accept invitation**。然后在 GitHub Desktop 中选择 **File > Clone repository**，选择这个仓库并完成克隆。如果列表里没有它，选择 **URL** 页签，粘贴仓库网页上的 HTTPS 地址。随后在仓库目录打开 PowerShell，运行：

```powershell
npm install
npm test
```

以后若向 AI 求助，可以直接说：

> 请先阅读 README.md、AGENTS.md 和 docs/figma-workflow.md，再一步一步带我完成日签制作。不要让我把密钥、令牌、私人图片或 Figma 私有链接提交到 GitHub。

## 日常流程

所有私人素材都放在 `.local/` 中。这个目录已被 Git 忽略，不会正常进入提交。

```text
.local/
  input/          自己的背景图、文案和其他源文件
  export-raw/     从 Figma 导出的 2 倍 PNG
  export/         压缩后的交付 PNG
```

1. 在自己的 Figma 文件中制作或复制日签画板。
2. 以 2 倍 PNG 导出到 `.local/export-raw/`。
3. 在仓库根目录运行：

```powershell
npm run compress -- ".local/export-raw" -o ".local/export"
```

工具会批量处理目录内的 PNG，并确保成功输出不超过 200 KiB（204,800 字节）。默认会先尝试保持原尺寸；必要时才逐步缩小。若希望绝不改变尺寸，加上 `--no-resize`，但某些图片可能因此无法达到大小限制。

完整 Figma 流程见 [docs/figma-workflow.md](docs/figma-workflow.md)。压缩器参数见 [tools/png-under-200k/README.md](tools/png-under-200k/README.md)。

## 常用命令

这些命令都在仓库根目录运行：

```powershell
npm install                 # 安装依赖
npm test                    # 检查压缩逻辑和 CLI
npm run dev                 # 打开压缩工具网页，终端会显示本地地址
npm run build               # 检查网页生产构建
npm run compress -- --help  # 查看 CLI 全部参数
```

压缩单张图：

```powershell
npm run compress -- ".local/export-raw/2026-08-01.png" -o ".local/export/2026-08-01.png"
```

压缩整个目录：

```powershell
npm run compress -- ".local/export-raw" -o ".local/export"
```

## Figma 与隐私

Figma 账号连接由你使用的 AI 客户端或 Figma 自己管理，不由本仓库管理。每个人都应连接自己的账号，并使用自己的 Figma 文件。不要把 API key、token、`.env`、MCP 配置、私人 Figma URL 或文件/节点 ID 写进仓库，也不要为了求助把密钥粘贴到聊天里。

## 遇到问题

- `npm` 找不到：安装 Node.js 22 LTS，关闭并重新打开 PowerShell。
- `npm install` 失败：确认网络可用，并把完整错误信息交给 AI；不要附带账号密钥。
- 网页打不开：保持 `npm run dev` 的终端窗口开启，访问终端显示的 `Local` 地址。
- 输出文件已存在：换一个空输出目录，或确认要覆盖后在命令末尾加 `--overwrite`。
- 图片压缩失败：先允许默认缩放；必须保持尺寸时可用 `--no-resize`，但工具会在无法达标时明确报错。
- 不知道下一步：让 AI 先阅读本仓库三份说明文件，并说明你卡在哪一步。

## 准备提交到 GitHub

提交前先运行测试，并确认 GitHub Desktop 的 Changes 列表中没有 `.local/`、图片、导出包、表格、`.env`、密钥或私人链接。安全规则见 [SECURITY.md](SECURITY.md)。

## 许可证

代码和文档采用 [MIT License](LICENSE)。仓库不包含第三方图片、字体、Figma 文件或其他内容素材；使用者需要自行确认其私人素材的授权。
