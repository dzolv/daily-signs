# 依赖检查

这是会话触发的轻量检查。交接 CLI 读取本地状态，首次运行、距成功检查满 7 天、依赖清单或锁文件变化、上次检查失败时提醒模型在制作空档处理。没有后台进程或定时任务；日签制作过程中不因维护而中断。

在仓库根目录运行：

```powershell
node tools/maintenance/cli.mjs status
node tools/maintenance/cli.mjs check
node tools/maintenance/cli.mjs status --days 14
```

`status` 只读取本地状态，不联网、不写文件；`check` 调用标准 `npm outdated --json` 和 `npm audit --json`，只检查，不安装、不升级。两者输出 JSON，`--days` 接受正整数。网络失败、超时、无效响应不刷新成功检查时间；失败检查返回非零退出码。发现更新或漏洞本身不算命令失败。

模型发现缺失依赖（`updates.missing`）时，应先在仓库根目录运行 `npm ci`；发现兼容更新后，应在空档运行 `npm update --prefix tools/png-under-200k`，再从仓库根目录运行 `npm test`、`npm run build`，最后重新检查。不得自动使用 `--force` 或跨主版本升级；需要这类处理时再说明原因和选择。检查成功且无需操作时保持安静，仅在失败或需要用户决定时汇报。

成功时间、清单/锁文件指纹、更新和漏洞摘要写入被 Git 忽略的 `.local/maintenance/dependencies.json`，不会保存原始 npm 日志。写入使用互斥锁和原子替换；并发检查返回 `BUSY`，检查期间依赖变化会要求重试。异常退出可能留下 `.local/maintenance/lock`，只有确认对应进程已退出后才移除。路径中包含符号链接或 junction 时拒绝写入。

代码集成可调用 `readMaintenanceStatus(root, now = new Date(), { days = 7 } = {})`；`due` 表示需要重新检查，`actionRequired` 同时包括上次发现的更新或漏洞。交接 CLI 的 `init`、`status`、`handoff` 成功结果通过 JSON 的 `maintenance` 字段提供状态，不写入 stderr；其他命令不做维护联网检查或写入。
