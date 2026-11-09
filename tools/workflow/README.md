# 制作中的薄 CLI

模型优先把检查、保存和比较交给程序，自己处理设计判断与工具调用。不新增 MCP 客户端，不联网抓图，不启动模型，不读取凭据，也不写授权决定。输入、输出和回执均在 Git 忽略的 `.local/`；以下为合成示例。

## 开工检查

```powershell
npm run workflow -- preflight --consent synthetic-consent --scope .local/input/scope.json
npm run workflow -- preflight --local-only
```

聚合现有 setup、离线依赖状态和指定 consent scope check，不联网、不更新、不新增批准。缺少许可/范围、待确认、拒绝、撤回或扩大范围不能得到 `ready: true`。`needsHumanAction` 表示许可尚未覆盖；先核对真实人类指令，已有同范围授权无须再问。

`--local-only` 的 `remoteReady: null` 表示远端范围未检查。普通检查的 `remoteReady` 仅表示本地范围通过；`hostAccessVerified: false` 表示未证明 OAuth、宿主审批、真实工具或目标可用。首次说明和维护到期以非阻塞 `issues` 返回；仍按仓库规则解释与安排空档维护，不打断当前制作。

## 保存完整导出并压缩

宿主调用真实 `get_export_image` 后，直接将完整返回变量序列化到 `.local/` 数据文件，或把完整返回送入 stdin。不要由模型转写、截取或重组 Base64，不要把图片数据插值进 shell 命令；宿主可对完整返回自动 JSON 序列化并传递给文件工具。宿主无法完整传递时说明缺口。CLI 不调用 MCP；保留和序列化返回仍由宿主工具负责。

大返回的宿主自动传递示例见 [Pixso 执行说明](../../docs/pixso-execution.md)。传参大小限制应由宿主循环处理，不让模型逐块转写；权限/内容审批拒绝不能靠分块绕过。先确认输入数据已完整保存，再运行 `save-export`，成功后再批压。程序会创建必要输出父目录，但不能生成缺失的输入图片。

```powershell
npm run workflow -- save-export --input .local/input/synthetic-mcp-return.json --output .local/export-raw/synthetic-preview.png --compress .local/export/synthetic-preview.png --kind trial
```

支持 `content[].text` 中的 JSON 包裹 Base64、多层明显 JSON、`content[].data` 图片块、直接 Base64 和 PNG data URL。一次只允许一张不同 PNG；重复表示同图可接受。只返回 URL 时失败，不自动下载。`--input -` 从 stdin 读取；文件须在 `.local/`。文本最大 140 MiB，PNG 最大 100 MiB、4000 万像素，只接受完整可解码的单帧 PNG。

保存前检查 PNG 容器并完整解码。默认从 Pixso 导出原尺寸 1x；`--compress` 复用网页/原 CLI 压缩核心，最终不超过 204,800 字节，默认保尺寸，`--allow-resize` 才允许缩小，`--lossless-only` 仅无损。成功回执含实际路径、尺寸、字节/hash，默认保存到原始输出路径加 `.receipt.json`，可用 `--receipt` 指定。全部输出排他新建，正常错误清理本次新建文件。多文件不是跨文件事务，崩溃后先检查落盘文件，再用新名重试。

`--kind trial|preview|production` 默认 `preview`，只是标签。回执始终明确 `authorizationVerified: false`、`visualReviewVerified: false`。试排/预览无须伪造正式选图或素材许可，不改变 handoff 状态。正式交付继续使用 `handoff finish` 及真实权利、视觉核对证据。

## 显式批次与本地恢复

模型根据已导出的真实 PNG 准备清单，不让用户填表，不扫描整个 export-raw 或猜最新版。可记录最新参考、brief 和 Pixso 定位；不用固定模板。例如：

```json
{
  "brief": "采用最新参考，文字可读无明显漏字",
  "reference": "本次用户参考的私有本地记录",
  "target": {"provider": "pixso", "documentRef": "synthetic-document"},
  "items": [
    {"rawPath": ".local/export-raw/synthetic-chosen.png", "outputName": "日签-1.png"}
  ]
}
```

```powershell
npm run workflow -- batch-export --input .local/batch.json --output .local/delivery/new-batch
npm run workflow -- resume-batch --input .local/delivery/new-batch/report.json
# 也可显式提供同一清单与原批次目录：
npm run workflow -- resume-batch --input .local/batch.json --output .local/delivery/new-batch
```

输出目录必须全新；只输出清单指定 PNG，拒绝重复文件名（含大小写）和越界路径，单个输出名不能含目录。复用现有压缩核心，默认保留输入尺寸，不静默缩图或升到 2x。无法在原尺寸达到 204,800 字节则记录失败，其他项继续。终端只返回一行汇总，详细的 manifest.json、report.json 留在该本地目录，每项记录原图/成图尺寸、字节、hash 或具体失败。

清单里的原图文件或其父目录尚不存在时，只记录该项失败并继续其他项，不创建输入目录。补齐实际导出后再恢复；路径越界或链接等不安全输入仍在开工前拒绝。输出父目录会自动创建，无须先手工建立空目录。

恢复时拿锁后重新读最新记录，校验已成功的原图与输出 hash/可解码性，跳过成功的相同输入。先前缺失输入补齐后可恢复；已记录输入变化、成功输出损坏/缺失、清单变化会报告，不能误用旧结果或覆盖输出，应建立新批次。崩溃留下未记录输出或 batch.lock 时先查实际文件与 PID，不能自动覆盖或抢锁。用户只拿指定 PNG，机器记录是新聊天的本地批压交接入口；云端仍需模型重新读取、使用已有 Pixso 工具和判断，本 CLI 不自动连接或设计。

## 真实观察快照与允许变化

把真实读取的节点属性按稳定标识放到 `nodes` 对象。例如：

```json
{
  "provider": "pixso",
  "documentRef": "synthetic-document",
  "capturedAt": "2026-01-01T00:00:00Z",
  "nodes": {
    "synthetic-frame": {"cornerRadius": 30, "width": 300, "height": 400},
    "synthetic-photo": {"imageRef": "synthetic-image", "crop": [0, 0, 1, 1]},
    "synthetic-mask": {"opacity": 0.15},
    "synthetic-text": {"characters": "合成文字"}
  }
}
```

```powershell
npm run workflow -- snapshot --input .local/input/synthetic-observation.json --output .local/snapshots/before.json
# 重新读取实际设计并保存 after-observation.json 后：
npm run workflow -- snapshot --input .local/input/after-observation.json --output .local/snapshots/after.json
npm run workflow -- compare --before .local/snapshots/before.json --after .local/snapshots/after.json --allow /nodes/synthetic-text/characters
```

快照规范对象键序并保存 hash，数组顺序参与比较。`capturedAt` 与 `sourceVersion` 单独保留，不参与内容 hash。比较先验证 hash，列实际增删/变化及前后值。无 `--allow` 时仅报告；有 `--allow` 时断言变化只在指定 JSON Pointer 子树，否则退出码 1。可重复指定，标识内的 `/`、`~` 分别写 `~1`、`~0`。不要允许整个 `/nodes` 变化后声称保护了构图。

只存实际观察字段；需要保护的圆角、蒙版、图片身份/裁剪、层级和文字应明确读到并保存，缺项不能写成未变。比较只能证明两份观察中记录值的变化，不能证明未读属性、像素画面、来源或审美。试排和真实接续均可使用，无需建立正式生产任务。文件事实与设计差异交给程序，不再逐轮临时编写导出验证脚本。

除 `--help` 外输出一行 JSON，错误 `ok: false` 并非零退出。`preflight` 未准备好、`compare` 不符合允许变化时，检查命令仍是 `ok: true` 但退出码 1，必须读取结果字段。
