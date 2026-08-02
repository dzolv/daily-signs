# Figma 日签工作流

这份说明面向第一次使用 GitHub、命令行或 AI 辅助制作的人。所有账号、图片和成品都留在你自己的电脑与 Figma 账号中。

## 1. 下载仓库

安装 GitHub Desktop 并登录自己的 GitHub 账号。如果仓库是私有的，先在浏览器中接受 GitHub 协作者邀请。选择 **File > Clone repository**，选择本仓库和本地保存位置，再点 **Clone**。若仓库不在列表中，切换到 **URL** 页签，粘贴仓库网页上的 HTTPS 地址。

## 2. 安装工具

安装 Node.js 22 LTS。安装完成后关闭并重新打开 PowerShell，在 GitHub Desktop 中选择 **Repository > Open in PowerShell**，运行：

```powershell
npm install
npm test
```

测试通过后，依赖可以留在项目里，不需要每次重新安装。

## 3. 连接自己的 Figma

登录自己的 Figma 账号，新建或复制一份属于自己的 Figma 文件。若希望 AI 直接操作 Figma，请按照所用 AI 客户端的说明配置 Figma 集成。账号授权应保存在客户端或 Figma 中，不要写入此仓库。

可以让 AI 帮忙配置，但不要把 API key、token、私有文件链接、文件 ID 或节点 ID 粘贴进聊天或提交到 GitHub。

## 4. 确定样式模板

在 Figma 中选定一个最终画板作为模板，并明确告诉 AI：这个画板是唯一标准，除替换文本和背景外不要调整任何样式。文本位置保持固定；背景图片的大小和位置由你自己拖动、缩放和确认。

制作新日期时复制这个模板画板，按需要替换文字和背景。若某天没有英文内容，不需要专门保留空白英文层。

## 5. 整理私人文件

在仓库根目录新建以下目录。它们位于 `.local/` 下，Git 会忽略它们：

```text
.local/
  input/
  export-raw/
  export/
```

把背景图和源内容放入 `.local/input/`。不要把真实素材放进仓库其他目录。

## 6. 从 Figma 导出

检查每个画板的名称与背景构图，然后在 Figma 的 Export 设置中选择 PNG 和 `2x`。把原始导出文件保存到 `.local/export-raw/`。

## 7. 批量压缩

在仓库根目录运行：

```powershell
npm run compress -- ".local/export-raw" -o ".local/export"
```

成功行会显示输出路径、字节数、尺寸和压缩方式。输出文件位于 `.local/export/`，每张不超过 204,800 字节。

若输出已经存在，确认可以覆盖后运行：

```powershell
npm run compress -- ".local/export-raw" -o ".local/export" --overwrite
```

若绝对不能改变像素尺寸，可加 `--no-resize`。这会允许调色板压缩但禁止缩小尺寸，因此复杂图片可能无法压到 200 KiB。

## 8. 最后检查

逐张打开 `.local/export/` 中的图片，检查文字、背景构图、清晰度和文件名。让 AI 汇报时，应要求它确认每张文件都是有效 PNG，且大小不超过 204,800 字节。

提交代码前打开 GitHub Desktop，只应看到工具或文档改动，不应看到 `.local/` 中的任何文件。

## 故障排查

- PowerShell 说找不到 `node` 或 `npm`：重新安装 Node.js 22 LTS，然后重新打开终端。
- `npm install` 出错：检查网络，并把不含密钥的完整报错交给 AI。
- 没有 PNG 被处理：确认文件扩展名是 `.png`，并确认命令中的路径存在。
- 子目录中的图片未处理：加上 `--recursive`。
- 输出已经存在：换空目录，或确认后加 `--overwrite`。
- 需要可视化操作：运行 `npm run dev`，保持终端开启，然后访问它显示的本地地址。
