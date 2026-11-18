# codex-statusbar — Codex 桌面版底部数据统计条

给微软商店版 OpenAI Codex 桌面 app（`OpenAI.Codex_2p2nqsd0c76g0`，Electron）注入常驻的
底部数据统计条：**本问 tok/s · 累计轮步 · 上下文占用 · 总 token**，鼠标悬停出「会话统计」面板。
整体移植自 ZCode 桌面版状态栏（[zcode-statusbar](https://github.com/xyqmbyl/zcode-statusbar)），
摆放算法、自愈机制、悬浮面板一致；
数据源换成 Codex 自己落盘的真实数据，不猜、不截屏、不读聊天内容。

## 快速开始

1. **装 Node.js 22 或更新版本**（免费运行时，[nodejs.org](https://nodejs.org/zh-cn)）。
   已经装过的可跳过：命令行运行 `node -v` 确认 ≥ 22。
2. **下载本仓库**：点右上角 **Code → Download ZIP**，解压到任意文件夹（所有文件必须在同一目录）。
3. **双击 `codex-statusbar-autostart.vbs`**：无窗口起守护进程（幂等，已在跑就立即退出）。

之后打开 Codex（任务栏任意入口）就会看到底部统计条。想开机自动起：把 `codex-statusbar-autostart.vbs`
的快捷方式放进「启动」文件夹（`Win+R` → `shell:startup`）。

> - **依赖 Codex 桌面版带调试端口 9224**：由 [codex-bg](https://github.com/xyqmbyl/codex-bg)
>   的看门狗负责确保；本工具自己不启动、不杀 Codex 进程。
> - **停止 / 卸载**：`node codex-statusbar.mjs --stop` 撤掉统计条并停守护进程；删掉整个文件夹即彻底干净。
>   本工具不改动 Codex 的任何安装文件、不写注册表。

## 显示什么

```
[⟳] 本问 3 tok/s · 730 tok ｜ 累计 3 轮 3 步 ｜ 上下文 57% ｜ [库] 412k tok
```

- **本问**：最近一轮的吞吐与输出。进行中图标转圈；刚发问还没落盘时显示 `--`，不拿上一轮充数。
  吞吐是**纯生成口径**：输出 token ÷ `thread_items` 里 reasoning/agentMessage 的流式时长之和
  （工具执行、审批等待、排队 TTFT 都不在这两类区间里）。区间不可信时退回整轮口径并在悬浮面板标注。
  子代理并发生成的 token 计入分子、其时长不在主线程区间里，会使该值略微偏高。
- **上下文**：最后一条 `usage.input_tokens` ÷ `model_context_window`（真实窗口占用，input 已含缓存）。
  **≥35% 琥珀、≥60% 红色** —— 到红线就该交接换新会话了。
- **悬浮面板**：上下文明细、本问吞吐/耗时、缓存命中、模型名、会话标题与 id、工作目录。

## 数据从哪来（全部只读本地）

| 数据 | 来源 |
| --- | --- |
| 屏幕上的会话 | `state_5.sqlite` 的 `threads` 表，`recency_at_ms` 最新的未归档线程 |
| 真实 token 用量 | `~/.codex/sessions/**/*.jsonl` 的 `token_usage_record` / `token_count`（按 offset 增量读，换会话才整扫） |
| 轮次边界 | rollout 里的 `task_started` / `task_complete` |
| 轮次耗时 | `thread_history_1.sqlite` 的 `thread_turns.duration_ms` |
| 标题 | `threads.title` → `first_user_message` → `session_index.jsonl` → rollout 第一条真人 user 消息 |

## 启动链路（任务栏打开 Codex 就有）

```
登录 → 启动文件夹 codex-statusbar.lnk → 守护进程常驻（无窗口，幂等）
打开 Codex（任务栏任意入口）→ codex-bg 看门狗确保 --remote-debugging-port=9224
→ 守护进程连上 CDP → 注入统计条 → 跟随当前会话实时刷新（1.2s）
```

守护进程自己不启动 Codex、不杀进程；Codex 没开时它只是安静地等，端口没起时每拍重试。
注入是 `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`，页面刷新自动重装；
条被外部删掉会自愈；守护进程退出会自动撤条、还原输入框的内边距。

## 常用命令

```bash
node codex-statusbar.mjs --print   # 只打印当前指标，不注入（自检）
node codex-statusbar.mjs --stop    # 停止守护进程并撤掉统计条
node codex-statusbar.mjs --port 9224 --interval 1200
```

日志：`statusbar.log`。改了 `overlay-codex.js` 必须**抬 VERSION + 重启守护进程**，页面才会换新版。

切换聊天时会释放后台隐藏输入框的留白，重新绑定当前可见的输入框（overlay v7）。
在打开的会话中运行 `node _verify-visible.mjs`，可检查统计条可见、位于输入框下方，
以及留白没有残留在后台聊天中。

## 与 zcode-statusbar 的差异

- 条上「累计 tok/s」换成了**上下文占用**（Codex 的 rollout 没有逐请求生成耗时，
  累计速度没有诚实算法；而上下文占用是 Codex 会话最要命的指标）。
  本问 tok/s 用 `thread_items` 的流式时长还原出了纯生成口径，与 zcode 版对齐。
- Codex 的输入框卡片没有画底（壁纸工具调透明），布局探测在
  `composerBox` / `findComposerWrap` / `reserveRoom` 各加了一条
  「贴底包裹层的最后一个子元素 = 卡片」分支；页面里有**两个**可编辑元素
  （主 composer + 次级输入框），自检只量被垫那一层自己的最后子元素，
  不然会被另一个编辑器污染（实测踩过的坑，见代码注释）。
- 输入框离窗口底只有 ~3px（ZCode 是 16px），`reserveRoom` 的目标内边距
  会补上「现有空隙」的差额。

## 文件

- `codex-statusbar.mjs` —— 守护进程：读 SQLite/rollout 算指标 + CDP 推送
- `overlay-codex.js` —— 页面端覆盖层（排版与自愈逻辑来自 zcode-statusbar 的 overlay）
- `codex-statusbar-autostart.vbs` —— 无窗口启动器（幂等），启动文件夹 `codex-statusbar.lnk` 指向它
- `_probe-*.mjs` / `_shot.mjs` —— 诊断脚本（dump 祖先链 / 截图），运行时用不到

依赖：Node ≥ 22（`node:sqlite`）、Codex 桌面版带调试端口 9224（codex-bg 的看门狗负责）。
