# Pixso 制作与导出的少绕路路径

供模型执行时参考。先发现当前宿主的工具与参数；以下经验不能代替工具说明、真实用户许可或执行结果。实际文件、节点和图片只留在 `.local/`。

## 复制现有参考

用户要求沿用现有画板时，优先使用工具明确提供的复制操作。当前 `apply_design` 的复制需要三个参数：源节点、目标父节点、属性。例如 `copy=C("synthetic-source", "synthetic-page", {"name":"试排"})`。不要漏掉父节点，也不要猜新节点编号；从操作结果取实际 ID。

复杂修改仍用当前工具要求的编辑接口，按其规范读回结果。复制、修改文字、导出是不同阶段，避免把复制和字体加载等多个不确定操作塞进一段脚本。脚本报错或超时可能已经留下部分内容：先按本次唯一画板名/返回 ID 核对，再决定后续动作，不盲目重放整批写入。服务超时只能恢复和减少影响，不能声称本仓库修好了远端服务。

## 完整导出留在执行环境

大图片不能先展示 Base64 给模型，再让模型抄成几十次写文件。把 `get_export_image` 的完整返回留在宿主变量里，优先使用宿主原生文件保存或 stdin；只有文件保存成功才运行 `workflow save-export`，它成功后才运行 `batch-export`。输入未保存时，创建输出目录不能解决问题。

如果宿主提供 `functions.exec` 与 Node REPL，可以在一个执行单元里自动分块传递完整结果。运行前先核对 `exportArgs` 和 `target` 的具体许可范围。这个片段用于**已经授权的新文件路径**；`target` 是该仓库 `.local/` 内的绝对路径，`exportArgs` 是已核对的文件/节点和 1x PNG 参数，运行前替换这两个变量。它只做数据传递，不启动另一个模型、不连接新的服务、不改权限：

```javascript
// functions.exec: tools 的实际名称以本会话发现结果为准。
const response = await tools.mcp__pixso__get_export_image(exportArgs);
if (response.isError) throw new Error('Pixso export failed');
const serialized = JSON.stringify(response);
const utf8Bytes = value => [...value].reduce((size, char) => {
  const code = char.codePointAt(0);
  return size + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4);
}, 0);
// 可保留 response，传递失败后先查文件，不必再次向 Pixso 导出。
store('pending-pixso-export', response);
for (let offset = 0; offset < serialized.length;) {
  let length = Math.min(40000, serialized.length - offset);
  let args;
  do {
    // 不在 Unicode 代理对中间切分，避免写文件时损坏非 ASCII 元数据。
    const last = serialized.charCodeAt(offset + length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length--;
    if (!length) throw new Error('Export transfer arguments are too large');
    const chunk = serialized.slice(offset, offset + length);
    args = {
      code: `const fs = await import('node:fs/promises'); const path = await import('node:path'); const target = ${JSON.stringify(target)}; await fs.mkdir(path.dirname(target), {recursive:true}); await fs.${offset === 0 ? 'writeFile' : 'appendFile'}(target, ${JSON.stringify(chunk)}, {encoding:'utf8', flag:${JSON.stringify(offset === 0 ? 'wx' : 'a')}});`,
      title: '保存完整 Pixso 导出'
    };
    // 计算工具参数编码后的字节数，给宿主调用大小限制留余量。
    if (utf8Bytes(JSON.stringify(args)) <= 48000) break;
    length = Math.floor(length / 2);
    if (!length) throw new Error('Export transfer arguments are too large');
  } while (true);
  const saved = await tools.mcp__node_repl__js(args);
  if (saved.isError) throw new Error('Export transfer stopped; inspect partial file');
  offset += length;
}
text({saved:true, path:target});
```

这是自动循环里的数据分段，不让模型生成或修改图片编码。只适用于传参大小限制；内容或权限审批拒绝时不得拆分绕过。首次使用 `wx` 防止覆盖已有文件。中途失败的文件不是完整导出，必须停止后续加工并检查；用全新路径重传保留的完整返回，不向残缺文件盲目追加。完整性由 `save-export` 的解码、PNG 检查与回执验证。宿主没有完整结果保存能力时，如实报告缺口，不从聊天历史拼图。

## 批量减少重复步骤

- 首次安装、说明和环境验证只做首次所需的部分；日常从离线开工检查与批次记录继续，不为每张图重装或重跑全部测试。
- 在实际授权覆盖的前提下，为同一批次整理一份具体范围：已知参考/目标节点、必要操作、工具和本地路径，保持用途描述稳定，各步骤用同一记录的子集检查。新节点创建后把实际 ID 汇总记录，不用模糊占位 ID 代替真实目标。新 ID 未列入旧许可时，按既有明确创建/编辑授权建立具体新请求、记录真实依据并再次检查，不自动扩展旧记录到后代或新节点。已有授权覆盖时无须逐节点重复问用户；这不授权无关节点、账号或文件。
- 根据工具上限把同类读取/复制/修改合并为适量调用，同一设计文件由一个执行者操作。每次调用检查返回结果，失败时先核对已完成部分。导出按实际支持的逐节点接口执行，不能凭空假设存在批量导出接口。
- 每份完整导出保存成功后才列入原图清单；原图还未导出的项目可以记失败并稍后恢复，不把缺一张图变成整批中断。压缩只运行一次显式批次，恢复跳过校验通过的已完成项。
- 批量时间包括共享准备时间和逐图制作、导出、检查时间。复制相同布局通常可摊薄准备成本，但 10 张与 30 张的真实耗时需要实测；本地压缩计时不能冒充 Pixso 制作全流程计时。
