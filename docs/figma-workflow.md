# Figma 日签工作流

这份说明面向第一次使用 GitHub、命令行或 AI 辅助制作的人。所有账号、图片和成品都留在你自己的电脑与 Figma 账号中。

如果希望让模型读取你已选好的图片、提供可选的找图方案，并跨会话接续制作，请同时阅读 [模型辅助工作流](assisted-workflow.md)。Pixso 的接入也在该文档中说明。交接数据保存在本地，模型和设计云服务仍按各自连接处理内容。

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

## 4. 确定本次参考

给 AI 本次参考和最新反馈即可，不要求固定模板。想保持的构图或样式可以直接说明；模型根据最新要求制作。文字能看清、没有明显漏字即可，不反复精修已接受的视觉效果。

有适合的既有画板时可复用并替换文字、背景。若某天没有英文内容，不需要专门保留空白英文层。

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

确认本次明确指定的画板，在 Export 中选择 PNG 和原尺寸 `1x`，除非用户要求其他比例。把原始导出保存到 `.local/export-raw/`。

## 7. 批量压缩

在仓库根目录运行：

```powershell
npm run workflow -- batch-export --input .local/batch.json --output .local/delivery/new-batch
```

模型准备显式清单，只列本次原图和输出名，不扫描混有旧版本的目录。成功汇总给出指定 PNG，详细尺寸、字节/hash 留在本地 report.json，每张不超过 204,800 字节且保持原尺寸。断点恢复使用 `npm run workflow -- resume-batch --input .local/delivery/new-batch/report.json`。

旧压缩 CLI 仍可处理明确指定的文件，例如：

```powershell
npm run compress -- ".local/export-raw/synthetic.png" -o ".local/export/synthetic.png" --no-resize
```

默认流程不缩小像素；复杂图片无法达标时说明失败，不静默缩图。批次使用独立新目录，不覆盖旧结果。

## 8. 最后检查

快速确认指定 PNG 的文字可读、无明显漏字。程序核对 PNG、原尺寸和 204,800 字节限制；用户只接收 PNG，机器记录留在本地。正常制作少旁白，不额外建立严格审美门槛。

提交代码前打开 GitHub Desktop，只应看到工具或文档改动，不应看到 `.local/` 中的任何文件。

## 故障排查

- PowerShell 说找不到 `node` 或 `npm`：重新安装 Node.js 22 LTS，然后重新打开终端。
- `npm install` 出错：检查网络，并把不含密钥的完整报错交给 AI。
- 没有 PNG 被处理：确认文件扩展名是 `.png`，并确认命令中的路径存在。
- 子目录中的图片未处理：加上 `--recursive`。
- 输出已经存在：换空目录，或确认后加 `--overwrite`。
- 需要可视化操作：运行 `npm run dev`，保持终端开启，然后访问它显示的本地地址。
