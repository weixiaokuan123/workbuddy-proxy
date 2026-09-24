# workbuddy-proxy

在 opencode 里使用 WorkBuddy（CodeBuddy）桌面端已登录模型的一个纯 Node 本地代理。

它把 WorkBuddy 桌面端的登录态转成 opencode 可直接调用的 **OpenAI 兼容** 端点：

- 国内版：`http://127.0.0.1:39301/v1`
- 国际版：`http://127.0.0.1:39302/v1`

一个进程同时服务两个区域，每个区域用独立的持久 `bearer key` 做本地鉴权。

> **两点须知**
> 1. 本项目**参考 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 改写**，只保留其纯 Node 连接内核。
> 2. 本代理**内置多账号 + 自动切换**：opencode 侧只需国内/国际两个入口，
>    撞限流会自动换到同区域的其他账号。详见「多账号与自动切换」一节。

## 来源

本项目**参考（改写自）** [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
（MIT，Copyright (c) 2026 LaoDing）——它是一个 DeepSeek Harness（DSH）插件，用于把本机
WorkBuddy 的登录模型接到 DSH 上。其设计又源自
[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
（MIT，Copyright (c) 2026 Corrine Hu）。详见 `THIRD_PARTY_NOTICES.md` 与 `LICENSE`。

改造点：**去掉 DSH 插件外壳，只保留纯 Node 连接内核**，做成 opencode 侧的独立 OpenAI 兼容代理，
并刻意简化了账号处理逻辑（见下一节）。模型目录、上游协议映射、token 刷新等核心逻辑均沿用原项目。

## 多账号与自动切换（v1.3.1 起的默认形态）

本代理**自带多账号池 + 限流自动切换**，不依赖任何外部 switch App。

- **账号库**：`state/accounts.json`（含 token，已 gitignore，绝不入库），可直接导入
  [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 的 `~/.wb-switch/accounts.json`。
- **单一入口**：opencode 侧只有两个 provider —— 国内版 `127.0.0.1:39301`、
  国际版 `127.0.0.1:39302`。每个入口背后是**该区域的全部账号**（live 登录态 + 账号库）。
- **自动切换**：某账号撞限流（`code:6004`）时，代理在**同一次请求内**自动换到同区域
  的下一个可用账号，请求照常完成；你不需要知道背后换了谁。
- **冷却记忆**：被限流的账号会记下恢复时间（从「将在 … 重置」里解析），期间排在候选末尾；
  恢复后**自动重新参与**，无需手动干预。
- **自动恢复首选**：每次请求都重新计算顺序，本端口的 live 账号优先，所以限流解除后
  下次就自动回到你自己的账号。
- **不碰官方 live 文件**：账号库的 token 只存代理库；刷新结果也只写回库。

> v1.3.0 及更早：账号库**每个账号单独一个端口**（39320+），opencode 侧是多 provider。
> 该模式已改为默认关闭，如需单独调试某账号可设 `WORKBUDDY_ACCOUNT_PORTS=on` 恢复。

### 管理账号

```powershell
# 列出账号库（含 token 剩余时间）
node scripts\accounts.cjs list

# 收录当前 WorkBuddy 登录态为新账号（替代「扫码加账号」）
# 用法：先在 WorkBuddy 里登录目标账号，然后执行：
node scripts\accounts.cjs capture

# 删除账号
node scripts\accounts.cjs remove <key>
```

改完账号后同步 opencode 配置（见下节），无需手改 provider。

### 同步 opencode 配置

opencode 侧的 `workbuddy-*` provider 块由脚本生成，**不需要手写**：

```powershell
# 按当前账号库与实时模型目录刷新 opencode.jsonc（幂等）
node scripts\sync-opencode-config.mjs

# 只看会改什么，不落盘
node scripts\sync-opencode-config.mjs --dry-run

# CI/自检：不一致时退出码 2
node scripts\sync-opencode-config.mjs --check
```

脚本**只重写 key 以 `workbuddy-` 开头的 provider 块**，并清除历史遗留的
`workbuddy-acctN` 块；其余 provider（trae / minimax / 其他）字节级原样保留，
不丢注释、不改缩进。

> 账号加号/删号后：先跑同步脚本，再重启 opencode 让配置生效。
> 代理**不需要**重启（账号库在每次请求时实时读取）。

## 运行要求

- Node.js **22.19+ 或 24+**（TypeScript 由 Node 原生类型擦除直接运行，**无需构建、无需安装依赖**）
- 本机已安装并登录 **WorkBuddy 桌面端**（代理只读它的登录态文件，不修改、不上传）
- 操作系统：Windows（脚本为 PowerShell，开箱即用）/ macOS / Linux（见下方「其他平台」）

## 安装

### 1. 放到 opencode 配置目录

代理要求位于 opencode 配置目录下的 `workbuddy-proxy` 子目录中（脚本按此相对位置推导配置路径与 key 路径）。

**Windows（PowerShell）**

```powershell
git clone https://github.com/weixiaokuan123/workbuddy-proxy.git "$env:USERPROFILE\.config\opencode\workbuddy-proxy"
```

**macOS / Linux**

```bash
git clone https://github.com/weixiaokuan123/workbuddy-proxy.git ~/.config/opencode/workbuddy-proxy
```

> 若你的 opencode 配置不在默认位置，克隆到对应目录的同级 `workbuddy-proxy` 下即可，
> 也可在注入/验证时设置 `OPENCODE_CONFIG_DIR` 指向真实配置目录。

### 2. 一键安装（Windows，推荐）

```powershell
cd "$env:USERPROFILE\.config\opencode\workbuddy-proxy"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

`install.ps1` 依次完成：检查 Node 版本 → 给 `.ps1` 补 UTF-8 BOM → 启动代理 → 把 provider 注入 `opencode.jsonc`（自动备份为 `opencode.jsonc.bak.workbuddy`）。

### 3. 手动安装（分步）

```powershell
# 启动代理（后台隐藏窗口，写入 logs\proxy.pid）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1

# 注入 provider（自动备份 opencode.jsonc）
node .\scripts\inject-config.cjs

# 验证配置
node .\scripts\verify-config.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
```

### 4. 重启 opencode

**必须重启 opencode** 才会加载新注入的 provider。

### 5. 使用

重启后，在 opencode 里选择 `WorkBuddy 国内版` 或 `WorkBuddy 国际版` 下的模型即可。
两个区域相互独立：国内端点只认国内桌面端账号，国际端点只认国际（`workbuddy.ai`）账号。

## 其他平台（macOS / Linux）

`scripts/*.ps1` 是 PowerShell 脚本，在 macOS / Linux 上可直接用 `node` 跑核心：

```bash
# 前台启动（首次会生成 keys/*.key）
node src/serve.ts

# 注入 provider 配置
node scripts/inject-config.cjs

# 验证
node scripts/verify-config.cjs
```

其他终端里可直接用 `curl` 检查状态（把 `$KEY` 换成 `keys/cn.key` 内容）：

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:39301/status
```

## 日常运维（Windows）

| 操作 | 命令 |
| --- | --- |
| 启动 | `scripts\start.ps1` |
| 停止 | `scripts\stop.ps1` |
| 状态 | `scripts\status.ps1` |
| 开机自启 | `scripts\install-autostart.ps1` |
| 取消自启 | `scripts\uninstall-autostart.ps1` |

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WORKBUDDY_CN_PORT` | `39301` | 国内端点端口 |
| `WORKBUDDY_GLOBAL_PORT` | `39302` | 国际端点端口 |
| `WORKBUDDY_CN_AUTH_FILE` | 平台默认 | 国内登录态文件路径 |
| `WORKBUDDY_GLOBAL_AUTH_FILE` | 平台默认 | 国际登录态文件路径 |
| `WORKBUDDY_AUTH_FILE` | 无 | 兼容旧版单变量（区域专属变量优先） |
| `WORKBUDDY_ACCOUNT_PORTS` | `off` | `on` 时为账号库每个账号单独开端口（39320+），仅供调试 |
| `WORKBUDDY_ACCOUNT_PORT_BASE` | `39320` | 调试端口的起始端口 |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | opencode 配置目录（注入/验证脚本使用） |

## 多账号（内置，可替代 workbuddy-switch）

本代理**自带多账号池 + 限流自动切换**，不依赖外部 switch App。
完整说明见上文「多账号与自动切换」一节；此处补充运维细节。

- **账号库**：`state/accounts.json`（含 token，已 gitignore，绝不入库）。
- **默认不单独开端口**：账号库账号并入 `39301`/`39302` 的候选池，
  opencode 侧只有两个 provider。撞限流在池内自动换号。
- **不碰官方 live 文件**：账号的 token 只存代理库；刷新结果也只写回库。
  因此**无需关闭 WorkBuddy 桌面端**，也不会与客户端互相打架。
- 每个账号**独立随机签到**（07:00–10:00 各自随机），池化后依然逐个执行，互不影响。

端口分配：

| 端口 | 用途 |
| --- | --- |
| 39301 / 39302 | 跟随官方当前登录态（live），并承载该区域全部候选账号 |
| 39320 + i | 仅当 `WORKBUDDY_ACCOUNT_PORTS=on` 时，账号库第 i 个账号独立端口 |

查看池状态：

```powershell
# /status 的 pool 字段：池大小、每个账号的积分、是否冷却、谁是首选
$key = (Get-Content keys\cn.key -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:39301/status -Headers @{ Authorization = "Bearer $key" } | ConvertTo-Json -Depth 8
```

每个池条目除冷却状态外，还带该账号的积分：

```jsonc
"pool": {
  "size": 3,
  "preferredId": "live-cn",
  "entries": [
    { "id": "live-cn", "label": "cn·当前登录", "preferred": true, "rateLimited": false,
      "remainingSec": 0, "active": false, "credits": 2069, "packages": 10,
      "creditsCached": true, "creditsStale": false, "creditsAgeSec": 3 },
    { "id": "acct:switch:…", "label": "cn·什么铁环", "preferred": false, "rateLimited": false,
      "remainingSec": 0, "active": false, "credits": 1382, "packages": 20 },
    { "id": "acct:switch:…", "label": "cn·18180938113", "preferred": false, "rateLimited": false,
      "remainingSec": 0, "active": false, "credits": 2071, "packages": 4 }
  ]
}
```

- 积分查询带 **60 秒缓存**（按账号身份分区），面板高频轮询不会反复打上游；
  上游抖动时回退 15 分钟内的旧值并置 `creditsStale: true`。
- 某个账号积分查不到时，该条目给 `creditsError`，**不影响整个 `/status`**，也不影响它在池中的可用性。

## 限额用尽自动换号

某个账号的额度/频率用尽时，上游会返回这样的错误：

```json
{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-23 08:44:36 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"..."}
```

代理会**自动改用同区域的其他账号**继续完成本次请求，而不是把这个错误直接抛给你：

- **触发条件**：业务码 `6004`、HTTP `429`，或文案含「频率限制 / 超出频率 / too many requests」。
  注意上游有时用 **HTTP 200 + 错误信封**返回它，代理也能识别。
- **切换范围**：同一区域（cn / global）内的全部账号，包括 live 登录态与账号库里的账号。
  本端口对应的 live 账号优先；其余可用户账号按**最早恢复**排序，冷却中的排末尾。
- **记忆冷却**：被限流的账号会记下恢复时间（从「将在 … 重置」里解析），
  在恢复前**排在候选末尾**；解析不到时间则固定冷却 10 分钟。
- **全部用尽才报错**：报错文案会注明「已尝试 N 个同区域账号，其中 M 个因额度限流被跳过」。
- **不误伤真正的问题**：额度**永久**不足（积分不足 / HTTP 402）、请求本身不合法等，
  不会被当成限流去换号，仍是直接报错。单账号用户行为完全不变。

查看当前哪些账号处于限流冷却：

```powershell
# /status 带 pool（池视图，含每个账号的积分）与 failover（旧字段，保留兼容）
curl -H "Authorization: Bearer <该端口的 key>" http://127.0.0.1:39301/status
# → "pool": { "size": 3, "preferredId": "live-cn",
#             "entries": [ { "id": "live-cn", "label": "cn·当前登录", "preferred": true,
#                            "rateLimited": false, "remainingSec": 0, "credits": 2069, "packages": 10 }, … ] }
# → "failover": { "enabled": true, "candidates": 3, "rateLimited": [ { "id": "acct:…", "remainingSec": 1234 } ] }
```

> 区域内只有一个账号时不会启用切换，`"failover"` 字段缺失、`pool.size` 为 1。
> 等到该区域有第二个账号（加号或导入）后，切换自动生效，无需改配置。

## 每日自动签到

- 每天早上 **07:00–10:00 之间随机一个时刻**自动领取每日签到积分（国内/国际各自独立随机）。
- 计划时刻当天首次运行即固定，持久化在 `state/signin-state.json`（已 gitignore），重启不重摇。
- 端点：`POST {billing}/v2/billing/meter/checkin-activity-status`（状态）、`POST .../daily-checkin`（领取）。
- 三重防重：进程内当天门禁 + 领取前先查状态 + 服务端 `alreadyCheckedIn` 幂等。
- 环境变量：`WORKBUDDY_SIGNIN=off` 关闭；`WORKBUDDY_SIGNIN_START_HOUR=7`、`WORKBUDDY_SIGNIN_END_HOUR=10` 调整窗口。
- 查看状态：`GET http://127.0.0.1:39301/signin/status`；手动触发：`POST http://127.0.0.1:39301/signin/claim`（幂等）。

## 账号与隐私

- 本仓库**不含任何账号凭据**。`keys/` 下的 `*.key` 在首次启动时随机生成（0600 权限），`logs/`、`state/` 亦不入库。
- 登录态来自 WorkBuddy 桌面端本地文件，只在进程内存中刷新，**永不写回、不落地、不联网外传**。
- 各平台登录态读取路径见 `src/auth.ts` 的 `defaultDesktopAuthDirs()`，可用上表环境变量覆盖。

## 目录结构

```
workbuddy-proxy/
  add-bom.cjs              给 .ps1 脚本补 UTF-8 BOM（Windows PowerShell 5.1 中文兼容）
  keys/                    运行时生成的持久 bearer key（.gitignore 排除）
  logs/                    运行日志与 pid（.gitignore 排除）
  scripts/
    install.ps1            一键安装（Node 检查 + 补 BOM + 启动 + 注入配置）
    start.ps1              后台启动（隐藏窗口，写 pid）
    stop.ps1               停止
    status.ps1             查询两区域登录/积分/模型数
    install-autostart.ps1  注册登录时自启的计划任务
    uninstall-autostart.ps1 取消自启
    inject-config.cjs      兼容入口，转调 sync-opencode-config.mjs
    sync-opencode-config.mjs 按账号库/实时模型目录同步 workbuddy-* provider
    verify-config.cjs      只读校验配置结构（不打印 key 明文，查 acct 块残留）
  src/
    auth.ts                只读桌面端登录态、内存内 token 刷新
    accounts.ts            多账号库（兼容 workbuddy-switch 格式）+ live 去重
    account-store.ts       账号库凭据 store（刷新写回库）
    catalog.ts             模型目录（静态 fallback + 上游刷新）
    serve.ts               守护入口（双区域池化入口 + 可选调试端口）
    shim.ts                OpenAI 兼容回环端点（含限额自动换号）
    upstream.ts            上游网关客户端与协议映射
    version.ts             版本常量
  test/
    failover.test.ts       限额换号模拟测试（无需网络、不耗额度）
    pool.test.ts           池化切换与账号去重测试
```

运行测试（无副作用，不消耗任何账号额度）：

```powershell
node --test test/failover.test.ts test/pool.test.ts
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `/status` 显示 `signed-out` | 先在对应区域登录 WorkBuddy 桌面端；或检查 `WORKBUDDY_*_AUTH_FILE` 指向 |
| **想换账号** | 默认自动切换，无需手动操作。想单独调试某账号：`WORKBUDDY_ACCOUNT_PORTS=on` 后重启，端口 `39320+` |
| 加了账号但 opencode 里没有 | 跑 `node scripts\sync-opencode-config.mjs`，再重启 opencode |
| opencode 里还有「账号A/B/C/D」 | 那是遗留的 `workbuddy-acctN` provider，跑同步脚本会自动清除 |
| 切号后立刻 401 | 两个区域的账号串了，检查国内/国际 live 文件是否对调 |
| 端口未监听 | 查看 `logs\proxy.err.log`；确认 Node 为 22.19+/24+ |
| 报 `domain 区域不符` | 该端口收到了另一区域的账号，检查两个登录态文件是否串了 |
| 报错含「已尝试 N 个同区域账号」 | 该区域所有账号额度都已用尽（或都被限流）。查看 `/status` 的 `pool.entries` 得知各自恢复时间 |
| 某账号一直不被使用 | 它可能仍在限流冷却中，见 `/status` 的 `pool.entries[].rateLimited` |
| 账号库里的账号没进池子 | 它可能与 live 当前登录态是同一个号，启动日志会写「已从切换池剔除」 |
| opencode 里看不到新模型 | 跑同步脚本；重启 opencode 确认配置生效 |
| `.ps1` 中文乱码 | 跑 `node add-bom.cjs` 补 BOM |

## 许可

MIT。原始版权归 dingminhua / corrinehu 等项目作者所有，详见源码文件头部注释与 `LICENSE`。
