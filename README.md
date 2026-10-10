# AI 打工人 · DSH 客户端插件

一个挂在 DeepSeek Harness Web 界面**右下角**的像素风悬浮小挂件：一名坐在电脑前干活的 AI 员工，会随着当前会话的状态切换动作——摸鱼中、思考中、敲代码中、等待确认、完成任务。

- 纯客户端插件（挂在 shell 的 `shell.overlay` 插槽上），不是独立网页，也不是 iframe
- 全部图形由 DOM + CSS 关键帧绘制：**没有外部图片、没有 CDN、没有网络请求、没有额外依赖**
- 颜色读取 DSH 自己的 `--dsw-*` 主题变量，因此自动跟随浅色/深色主题
- 可拖动、可折叠成小头像、可关闭；关闭 / 折叠 / 位置 / 今日完成数都存在浏览器 localStorage，刷新与重启后仍然记得
- 任务完成时播放撒花动画，并把「今日完成 N 件」计数加一（跨天自动归零）

## 状态怎么来的

状态不是随机动画，而是从会话数据推导出来的：

| 显示 | 触发条件 |
| --- | --- |
| 等待确认 | `useSessionStatus` 里当前会话的 `pendingInteraction` 非空 |
| 敲代码中 | 当前会话 `running`，且行内 `updatedAt`（或本轮开始时间）在 2 秒内 |
| 思考中 | 当前会话 `running`，但已经安静超过 2 秒（通常在推理） |
| 完成任务 | 会话从 `running` 变成非 `running` 的那一次跳变（计数 +1，撒花 7 秒） |
| 摸鱼中 | 空闲，且超过 45 秒没有任何动静 |
| 待命中 | 没有选中任何会话 |

数据来源是两个 slot 标准属性（standardProps）：

- `useSessions`——会话列表快照 `{ ids, byId, phase, projectionsBySession }`；
- `useSessionStatus`——实时状态表 `Map<sessionId, { running, pendingInteraction, completionUnread }>`，
  由宿主通过 `api-session/status` 事件推送，是**唯一**会在一个回合进行中变化的状态源。

「当前会话」由 `byId` 中 `retainedBy.mainView > 0` 的那一行推导（DSH 侧边栏也这样找主会话），
宿主没有该字段时退回 `current`，再退回「列表里只有一个会话」。

## 交互

- **拖动**：按住标题栏拖动；也可以用键盘：聚焦标题栏后按方向键（按住 Shift 步长更大）
- **再来个撒花**：点一下挂件本体（小人的画面区），或聚焦它之后按 `Enter` / `空格`。纯动画，**不**计入「今日完成」
- **折叠**：点标题栏右侧 `—`，或按 `Esc`，变成右下角小头像（右上角有今日完成数角标）；点小头像展开
- **关闭**：点 `✕`，关闭状态会记住，下次打开 DSH 不再出现
- **重新打开**：清除 localStorage 里的 `dsh.aiWorker.closed.v1` 后刷新，或执行
  `localStorage.removeItem('dsh.aiWorker.closed.v1')`

## 目录结构

```
plugins/dsh-ai-worker/
├── package.json              # 插件清单：dsh.bundle.patch / dsh.client / dshhub / peerDependencies
├── build.mjs                 # 打包脚本：把 src 包成浏览器加载的 client bundle
├── verify.mjs                # 离线自检：模拟浏览器加载并跑通所有状态
├── cordis.patch.yml          # 包自带的 bundle 补丁：装包即自动登记 ai-worker 行
├── install.sh / uninstall.sh # 安装 / 卸载：调用 dsh plugin add / remove
├── src/client/ai-worker.js   # 全部源码（唯一的源文件）
└── lib/
    ├── index.js              # node 侧（空实现，只为让 Loader 里有一行条目）
    └── client.js             # 构建产物，DSH 实际下发给浏览器的文件
```

## 构建、自检、安装

```bash
cd plugins/dsh-ai-worker
node build.mjs     # 重新生成 lib/client.js
node verify.mjs    # 离线自检（不需要浏览器）
bash install.sh    # dsh plugin add：装进 profile（默认 web，认 DSH_PROFILE / DSH_BIN）
DSH_PROFILE=desktop bash install.sh    # 指定目标 profile（桌面版 DSH 用 desktop）
bash uninstall.sh  # dsh plugin remove：从 profile 卸载（同样认 DSH_PROFILE / DSH_BIN）
```

改完 `src/client/ai-worker.js` 之后要重新 `node build.mjs`，然后刷新页面。

## 它是一个标准 DSH 插件

本包按 DSH 插件规范组织，装进 profile 后**自带装载条目**，不需要手工改 profile 的 `cordis.patch.yml`：

| 文件 / 字段 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 包自带的 bundle 补丁：`- insert: - id: ai-worker, name: dsh-ai-worker` |
| `package.json` → `dsh.bundle.patch` | 告诉 DSH：装这个包时自动应用上面那份补丁 |
| `package.json` → `dsh.client` | 声明浏览器 bundle：`platform: web`，注入 layout / session，外部依赖 primitives |
| `package.json` → `dsh.manifestVersion` | manifest 格式版本，规范目前是 `1` |
| `package.json` → `engines.dsh` / `engines.node` | 兼容的 DSH / Node 区间。规范把运行时要求放在**顶层 `engines`**（与 `engines.node` 并列），并把 DSH 兼容性定义成声明式字段；`dsh.engines` 是被明确否决过的位置 |
| `package.json` → `peerDependencies` | 宿主提供的 UI 包；三个都标了 `optional`，解析不到也能跑 |

`install.sh` 只是 DSH 官方 CLI 的一层包装：

```bash
dsh plugin --profile desktop add "$(pwd)"
```

它把包装进 profile 的 `node_modules/` 并写进 `dsh.profile.bundles`；DSH 扫描到 `dsh.client` 声明后把 `lib/client.js` 作为浏览器 bundle 下发，浏览器里的 `window.__ModuleLoader__` 拿到它，`apply(ctx)` 把挂件注册进 `shell.overlay`。

> 0.2.0 起不再使用「复制目录 + 手工登记 profile 的 cordis.patch.yml」那套老办法：两条路同时走会出现重复的 `id: ai-worker`，DSH 可能拒绝加载。

## 已知边界

- 只挂在 DSH Web 界面；终端 TUI 没有这个插槽。
- 「思考中 / 敲代码中」由会话活跃度推断：推理阶段没有工具事件，会话行会安静下来，因此用「running 且 2 秒内有无更新」来区分两者；宿主没有行时钟时退回本轮开始时间，都没有则视为刚开始。这是启发式，不是精确的模型状态。
- 不再使用自造的 `dshhub` 块：显示名与简介由 README 和插件市场条目承载，宿主要求由 `engines.dsh` 承载——`dshhub` 不是 DSH manifest 规范字段，DSH 与插件市场都不读它。
- 0.2.1 起改用宿主真正提供的 `useSessionStatus`：0.2.0 依赖的 `useSessionPendingInteraction` 与 `jobsBySession` 在当前 DSH 构建里并不存在，导致挂件此前永远停在「待命中」。
- 折叠 / 关闭 / 位置按浏览器保存（localStorage），换浏览器或清缓存会重置。
