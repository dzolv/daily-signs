# 本地接续记录（实验）

这个小程序让模型把任务输入、来源观察、候选建议、真实选择和执行进度保存到本机，下一次会话读取后接着做。女生仍在 Figma/Pixso 中挑图、拖动和缩放。模型可以根据有证据的习惯提出候选；候选不会自动变成选择，也不会代替她确认构图。

程序只读写本地 JSON、验证本地 PNG。它没有 Figma/Pixso 连接，不抓取网络图片，不操作远程文件，不启动模型或其他会话。连接器由使用者在自己的 AI 客户端配置；当前没有连接器时，模型应明确说明，只能整理用户提供的观察和本地文件。

重复文件操作优先用 [workflow 薄 CLI](../workflow/README.md)：聚合离线检查、完整导出自动保存/压缩回执、真实设计观察快照与允许变化比较。试排和接续不要求先完成正式选图/权利校验；trial/preview/production 标签不自动推动本状态机，也不代替 `finish`。

## 调用约定

从仓库根目录执行，或使用根目录的 `npm run handoff --`：

```powershell
node tools/handoff/cli.mjs --help
node tools/handoff/cli.mjs init synthetic-job --input .local/input/brief.json
node tools/handoff/cli.mjs status synthetic-job
node tools/handoff/cli.mjs handoff synthetic-job
```

输出都是一行 JSON，成功包含 `ok: true`、当前 `revision` 和完整的当前任务上下文；失败包含 `ok: false`、`error.code`、`error.message`，进程返回非零。只有 `--help` 输出人类可读文字。`status` 和 `handoff` 当前返回相同内容，前者便于检查，后者给下一次模型会话使用。

`init/status/handoff` 还返回 `setup`，提醒模型是否应介绍首次登录与最小权限；详见 [Pixso 首次接入](../../docs/pixso-permissions.md)。这不改变制作状态机，也不授权或验证任何设计连接。模型实际说明后通过 `npm run setup -- acknowledge --message "实际说明"` 保存本地提醒记录；不能把已提醒当成可开始制作。

实际许可使用 `npm run consent` 单独申请和记录；将许可 ID 通过已有 `record` 步骤放入该批次上下文。新执行者先核对对应人类指令，再用 `consent check` 检查本次账号/文件/节点/动作/工具/本地路径与用途。`claim` 令牌不是许可，handoff 也不会自动执行该检查或拦截远端调用。没有执行权时不要为记许可改写制作状态机；私有许可记录可先独立保存，认领后关联。

除 `init` 外，每次写入必须用最近一次返回的 `--revision N`。下面示例中的数字仅展示连续顺序；实际运行必须使用真实返回值。`claim` 返回 `activeClaim.token`；执行相关命令必须同时传入原样的 `--worker` 和 `--token`。不要把示例令牌当作真实令牌。

| 命令 | 必需参数 | 用途 |
| --- | --- | --- |
| `init JOB` | `--input` | 创建任务，不覆盖已有任务 |
| `capture JOB` | `--revision --input` | 保存已观察的来源快照；变化会撤销执行权和旧选择 |
| `propose JOB` | `--revision --input` | 保存有证据引用的候选，不设置选择 |
| `select JOB` | `--revision --input` | 记录来源中已有的选择，或用户明确选择 |
| `claim JOB` | `--revision --worker` | 一次只允许一个执行者；返回令牌 |
| `record JOB` | `--revision --worker --token --input` | 记录步骤、结果或阻塞 |
| `resume JOB` | `--revision --worker --token` | 原执行者从阻塞状态继续 |
| `release JOB` | `--revision --worker --token` | 结束当前执行权，保留记录供其他会话接手 |
| `finish JOB` | `--revision --worker --token --input` | 验证原始导出与最终 PNG 并记录交付 |
| `status JOB` / `handoff JOB` | 无 | 读取当前上下文，不需要 revision |

JOB、worker、资产和偏好 ID 只允许 1–64 个英文字母、数字、连字符、下划线，首位必须是字母或数字；不允许 Windows 设备名。输入 JSON 和所有素材、导出文件都必须在 `.local/` 内，路径使用仓库相对路径和正斜线。拒绝 `..`、绝对路径、反斜线、盘符/备用数据流、末尾空格/句点等 Windows 路径别名、`CON.png` 等设备名，以及路径中的符号链接和 junction。

## 输入 JSON

以下内容全部是假数据和占位描述。自行把 JSON 文件保存在 `.local/input/`。不要将真实文件编号、节点编号、素材、内容或凭据加入代码提交。

### 初始化

`.local/input/brief.json`：

```json
{
  "brief": "为合成示例制作一张日签",
  "constraints": ["使用本次参考和最新反馈", "文字清楚无明显漏字", "默认原尺寸1x PNG"],
  "expectedOutputCount": 1,
  "preferenceEvidence": [
    {
      "id": "habit-1",
      "certainty": "inferred",
      "observation": "过去的合成示例中多次选择安静背景",
      "evidence": "合成历史选择记录示例；尚未获得用户偏好确认",
      "provenance": {"status": "unknown"}
    }
  ]
}
```

`brief` 是非空文本，`constraints` 是文本数组。建议提供 `expectedOutputCount`（1–1000 的整数），最终交付必须恰好有这么多对原始/最终文件；省略时程序仅要求至少一张，无法判断是否漏交日期或画板。`preferenceEvidence` 可省略；每条必须有独立 ID、观察、证据、`certainty`（`inferred` 推测或 `confirmed` 用户已确认）和来源状态。不要把重复选择自动写成已确认偏好。约束是提供给模型的指令上下文，程序不会替模型理解或执行排版规则。

### 捕获已观察的来源

`.local/input/snapshot.json`：

```json
{
  "provider": "figma",
  "documentRef": "synthetic-document",
  "nodeRefs": ["synthetic-template-frame"],
  "capturedAt": "2026-01-01T00:00:00Z",
  "sourceVersion": "synthetic-document-version-1",
  "targetFingerprint": "synthetic-digest-of-target-layout-style-and-composition",
  "text": ["合成文案"],
  "assets": [
    {
      "id": "chosen",
      "role": "selected",
      "artifactKind": "source-image",
      "sourceRef": "synthetic-pre-agreed-selection-region",
      "localPath": ".local/input/synthetic-background.png",
      "source": {"status": "unknown"},
      "license": {"status": "unknown"}
    },
    {
      "id": "reference",
      "role": "reference",
      "artifactKind": "render",
      "sourceRef": "synthetic-reference-preview",
      "source": {"status": "unknown"},
      "license": {"status": "unknown"}
    }
  ]
}
```

```powershell
node tools/handoff/cli.mjs capture synthetic-job --revision 1 --input .local/input/snapshot.json
```

`provider` 允许 `figma`、`pixso`、`local`。上述字段均必需，只有资产的 `localPath` 可省略；文本、节点和资产列表可以为空。`sourceVersion` 记录来源版本；`targetFingerprint` 由模型/适配器根据实际观察的目标排版、样式、层级、图片构图生成，不能只抄整个文档的修改时间。程序计算的快照 ID 覆盖目标指纹、文字、资产角色/来源/授权和本地素材内容摘要，忽略 `capturedAt` 与 `sourceVersion` 的变化。仅重复观察不会撤销原执行权；目标内容变化会撤销旧选择与执行权。来源数据的数组顺序参与比较。`sourceObservation` 返回最近一次捕获的时间和版本，完整历史仍保留每次观察。

同一 provider、documentRef 和目标节点列表的捕获时间不得早于最近观察，否则返回 `STALE_OBSERVATION`。有了新的 revision 也不能用旧 JSON 覆盖新观察；需要重新读取来源。若用户把内容改回旧样子，可在实际重新观察后用新的时间记录。时间由观察者提供，程序不能独立验证远程时间真伪。

`role: reference` 是参考，`selected` 必须来自真实源文件证据，例如双方预先约定的“已选”画板区域。不能因模型喜欢某张图而写为 `selected`。`artifactKind: source-image` 是原图，`render` 是渲染/截图；渲染图不能冒充可还原的原始背景。程序不把任意链接下载成本地图片。

每项来源与授权必须明确写 `{ "status": "unknown" }`，或 `{ "status": "verified", "evidence": "实际证据说明或本地证据引用" }`。这里的 `verified` 表示输入提供者记录了已核实证据，**不是程序独立审核或法律保证**。模型断言不是授权证据。未知来源可以继续整理和探索；未知授权不能直接通过最终交付。

### 提出候选

`.local/input/proposal.json`：

```json
{
  "alternatives": [
    {
      "id": "quiet-option",
      "description": "基于有记录的观察，建议看这张安静背景；仍由用户挑选",
      "assetIds": ["reference"],
      "evidence": [
        {"kind": "snapshot", "id": "REPLACE_WITH_RETURNED_SNAPSHOT_ID"},
        {"kind": "preference", "id": "habit-1"}
      ]
    }
  ]
}
```

```powershell
node tools/handoff/cli.mjs propose synthetic-job --revision 2 --input .local/input/proposal.json
```

候选至少一条，每条有独立 ID、描述、资产 ID 数组和至少一个有效证据引用。资产必须在当前快照内；证据只能引用当前快照或初始化时记录的偏好。建议不会更改选择或赋予执行权。

### 记录实际选择

`.local/input/selection.json`：

```json
{
  "assetIds": ["chosen"],
  "basis": "source",
  "evidence": "合成示例：用户已把图片放入事先约定的已选画板区域",
  "rightsConfirmation": {
    "confirmedBy": "user",
    "statement": "合成示例：用户确认现有素材可用于此次交付",
    "evidence": "合成示例：实际用户授权说明的记录位置"
  }
}
```

```powershell
node tools/handoff/cli.mjs select synthetic-job --revision 3 --input .local/input/selection.json
```

`assetIds` 至少一项且属于当前快照。`basis: source` 要求每项已有 `role: selected`，适合用户平常的画板选图行为，不要求她重复在聊天确认。若用户直接明确选择参考图，可用 `basis: user` 并增加 `confirmation` 非空文本，忠实记录实际用户原话或等价说明。模型提出候选不算用户确认。

`rightsConfirmation` 可省略；它只在用户实际确认有权使用现有素材时记录，不要为了通过校验而编造。最终交付要求所有选中资产有 `license.status: verified` 的证据，或本次选择含这条真实用户权利确认。它不会将未知授权改写成已核实，也不代替法律判断。每次选择都会撤销旧执行权，包括重新选择同一张图；这样可以明确重新执行一次任务。

### 执行、阻塞与接续

开始执行前重新观察目标，并 `capture` 最新内容。程序无法察觉尚未录入的远程修改；但 `claim` 与 `finish` 都会重新计算选中本地素材的摘要，发现素材文件变化就拒绝执行，要求重新捕获与复核选择。

```powershell
node tools/handoff/cli.mjs claim synthetic-job --revision 4 --worker synthetic-worker
```

从输出取得真实令牌，后续命令都使用它。`.local/input/progress.json`：

```json
{"kind":"step","message":"合成示例：已按当前目标整理本地导出，排版仍以源文件为准"}
```

```powershell
node tools/handoff/cli.mjs record synthetic-job --revision 5 --worker synthetic-worker --token RETURNED_TOKEN --input .local/input/progress.json
```

`kind` 允许 `step`、`result`、`blocked`。记录 `blocked` 后，原执行者可执行 `resume` 继续；其他会话先读 `handoff`，有意接管时用当前执行令牌 `release` 再 `claim`。这些是协调记录，不是操作系统身份验证。执行权不自动超时，避免慢任务被另一模型重复执行。令牌和本地状态只供可信的本地协作会话使用。

若来源变化，新 `capture` 会撤销旧令牌；旧工作仍保留，但旧执行者不能报告成功。旧选择以 `priorSelection` 返回，并标记 `needsSelectionReview`。模型可根据最新源文件中同一已选区域的实际证据再次 `select`，无须让女生重复确认原本不变的选图。下一次会话先读 `handoff`，恢复 brief、约束、偏好证据、当前快照、真实选择、当前候选、进度、交付和历史，然后决定重新观察、继续或接管。不要依赖聊天记忆。

### 验证交付

默认把原尺寸 1x PNG 导出到 `.local/export-raw/`，再用显式清单 `workflow batch-export` 压缩到独立交付目录。不要扫描旧版本或猜最新文件；原尺寸无法达标则说明。交付前刷新源文件并 `capture`；若目标变化再复核选择/执行权。相同内容再次捕获不会撤销执行权，但会增加 revision。最新参考与反馈优先，不要求固定模板，视觉只需简短确认可读、无明显漏字。

`.local/input/delivery.json`：

```json
{
  "review": {
    "text": "合成示例：文字可读，无明显漏字",
    "exportScale": "合成示例：已观察原尺寸 1x PNG 导出"
  },
  "outputs": [
    {
      "rawPath": ".local/export-raw/synthetic-sign.png",
      "finalPath": ".local/export/synthetic-sign.png"
    }
  ]
}
```

```powershell
node tools/handoff/cli.mjs finish synthetic-job --revision 6 --worker synthetic-worker --token RETURNED_TOKEN --input .local/input/delivery.json
```

`finish` 要求非空的 `review.text` 与中性的 `review.exportScale`，简短说明可读性及实际导出比例即可，不额外要求严格审美验收。兼容旧 `raw2x` 作为比例证据，旧 `template`、`crop`、`raw2x` 字段原样保留，已有历史不改写。要求至少一对不同物理文件的原始/最终 PNG，数量须符合已指定的 expectedOutputCount，不能重复物理文件（包括大小写别名和硬链接）；最终文件逐张不超过 204,800 字节。程序记录实际摘要、尺寸、字节、快照及执行权，失败不写完成状态。它不证明画面/比例陈述或两文件来自同次压缩；正式权利检查保持有效，版权未知的试排继续使用 workflow 标签记录，不伪装 finish。

## 存储与恢复边界

状态保存在 `.local/handoff/JOB/state.json`。每次写入先以排他创建的 `lock` 拿锁，在锁内检查 revision，再把包含追加历史的完整状态写入同目录临时文件、同步并原子重命名。没有独立日志造成状态/日志两份写入不一致。旧快照、选择、执行权、进度和交付保留在状态内；`handoff` 返回当前快照和选择、历史进度/交付、事件摘要与保留数量，完整旧快照仍可在本机状态文件中查看。

如果两个会话同时写入，一个会得到 `BUSY` 或 `STALE_REVISION`。重新读取 `handoff`，确认实际进度再决定下一步，不要盲目重复外部操作。进程意外终止可能留下锁：先确认锁中 PID 对应的程序已退出、没有其他执行者写入，备份状态后人工删除该任务的 `lock`；程序不自动抢占不明锁。残留 `tmp-*.json` 不会被读取。单次输入 JSON 最大 2 MiB，状态最大 32 MiB，素材和原始导出最大 100 MiB；列表最多 1000 项、单段文字最多 10000 字符。超过规模请新建独立任务。

所有状态和令牌都是私人本地工作数据，不要提交。路径检查拒绝现有链接，但本程序不是对抗同机恶意进程同时替换目录的安全沙箱，也不检测 JSON 中是否误贴了凭据。只向可信本地模型提供状态，不向输入写入令牌、密码或账号配置。

验证命令：

```powershell
node --test tools/handoff/test/*.test.mjs
```
