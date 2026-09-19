# workbuddy-proxy

在 opencode 里使用 WorkBuddy（CodeBuddy）桌面端已登录模型的一个纯 Node 本地代理。

它把 WorkBuddy 桌面端的登录态转成 opencode 可直接调用的 **OpenAI 兼容** 端点：

- 国内版：`http://127.0.0.1:39301/v1`
- 国际版：`http://127.0.0.1:39302/v1`

一个进程同时服务两个区域，每个区域用独立的持久 `bearer key` 做本地鉴权。

> **两点须知**
> 1. 本项目**参考 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 改写**，只保留其纯 Node 连接内核。
> 2. 本代理**不能切换账号**，只使用当前登录的账号；如需切换请配合
>    **[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)**。详见「不支持切换账号」一节。

## 来源

本项目**参考（改写自）** [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
（MIT，Copyright (c) 2026 LaoDing）——它是一个 DeepSeek Harness（DSH）插件，用于把本机
WorkBuddy 的登录模型接到 DSH 上。其设计又源自
[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
（MIT，Copyright (c) 2026 Corrine Hu）。详见 `THIRD_PARTY_NOTICES.md` 与 `LICENSE`。

改造点：**去掉 DSH 插件外壳，只保留纯 Node 连接内核**，做成 opencode 侧的独立 OpenAI 兼容代理，
并刻意简化了账号处理逻辑（见下一节）。模型目录、上游协议映射、token 刷新等核心逻辑均沿用原项目。

## 不支持切换账号：请配合 workbuddy-switch 使用

**本代理本身不具备、也不打算提供账号切换能力。** 它被刻意设计成「只读当前登录态」：

- 每次请求都**实时重读**对应区域的 live 认证文件（国内 `workbuddy-desktop.info`，国际 `workbuddy-desktop-ai.info`），无缓存、无 mtime/hash 门禁；
- **不做多账号选择、不做 selected 锁定、不扫描历史时间戳备份**；
- token 刷新结果**只存在进程内存**，绝不写回桌面端文件、不落地任何副本。

因此，**切换账号必须依赖第三方工具**：

> **[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)** —— WorkBuddy / CodeBuddy CLI / CodeBuddy CN IDE 账号切换桌面 App（Tauri，MIT）。

workbuddy-switch 负责把目标账号写入 live 认证文件；本代理在下一次请求时自动跟随。
**不装它就只能用当前已登录的那一个账号。**

使用流程：

1. 用 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 切换到想用的账号；
2. 无需重启本代理，下一次对话请求即使用新账号；
3. 若切号后立刻报 401，检查是否两个区域（国内/国际）的账号串了——本代理会校验 `domain` 与端口是否匹配。

> 之所以这样设计：账号切换涉及备份/关闭桌面端/写入/重启等重操作，且要处理多账号密钥存储，
> 交给专门的工具更稳妥；本代理保持无状态、可随时跟随，避免账号状态两处维护而互相打架。

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
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | opencode 配置目录（注入/验证脚本使用） |

## 多账号（内置，可替代 workbuddy-switch）

本代理**自带多账号能力**，不依赖外部 switch App。

- **账号库**：`state/accounts.json`（含 token，已 gitignore，绝不入库）。
- **每个账号一个端口**：第 i 个账号监听 `39320 + i`，opencode 侧自动生成对应 provider，
  **多个账号可同时使用、并行跑任务**——这是「切换式」工具做不到的。
- **不碰官方 live 文件**：账号的 token 只存代理库；刷新结果也只写回库。
  因此**无需关闭 WorkBuddy 桌面端**，也不会与客户端互相打架。

### 管理账号

```powershell
# 列出账号库（含 token 剩余时间、对应端口）
node scripts\accounts.cjs list

# 从 workbuddy-switch 导入（已装 switch 时零迁移成本）
node scripts\accounts.cjs import-switch

# 收录当前 WorkBuddy 登录态为新账号（替代「扫码加账号」）
# 用法：先在 WorkBuddy 里登录目标账号，然后执行：
node scripts\accounts.cjs capture cn

# 删除账号
node scripts\accounts.cjs remove <key>
```

改完账号后重新注入 provider 并重启 opencode：

```powershell
node scripts\inject-config.cjs
```

端口分配（`src/serve.ts` 的 `ACCOUNT_PORT_BASE`，默认 39320）：

| 端口 | 用途 |
| --- | --- |
| 39301 / 39302 | 跟随官方当前登录态（live 模式）|
| 39320 | 账号库第 0 个账号 |
| 39321 | 账号库第 1 个账号 |
| … | 以此类推 |

每个账号**独立随机签到**（07:00–10:00 各自随机），互不影响。

> 关于加新账号：本代理不内嵌 OAuth 扫码流程（那是登录态最脆弱的部分）。
> 加账号只需「在 WorkBuddy 里登录一次 + `capture` 一下」，比扫码更简单。

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
    inject-config.cjs      把两个 provider 注入 opencode.jsonc（自动备份）
    verify-config.cjs      校验注入结果（不打印 key 明文）
  src/
    auth.ts                只读桌面端登录态、内存内 token 刷新
    catalog.ts             模型目录（静态 fallback + 上游刷新）
    serve.ts               守护入口（双区域）
    shim.ts                OpenAI 兼容回环端点
    upstream.ts            上游网关客户端与协议映射
    version.ts             版本常量
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `/status` 显示 `signed-out` | 先在对应区域登录 WorkBuddy 桌面端；或检查 `WORKBUDDY_*_AUTH_FILE` 指向 |
| **想换账号** | 本代理不支持切号，请用 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 切换；切换后无需重启代理 |
| 切号后立刻 401 | 两个区域的账号串了，检查国内/国际 live 文件是否对调 |
| 端口未监听 | 查看 `logs\proxy.err.log`；确认 Node 为 22.19+/24+ |
| 报 `domain 区域不符` | 该端口收到了另一区域的账号，检查两个登录态文件是否串了 |
| opencode 里看不到新模型 | 重启 opencode；再跑 `verify-config.cjs` 确认注入成功 |
| `.ps1` 中文乱码 | 跑 `node add-bom.cjs` 补 BOM |

## 许可

MIT。原始版权归 dingminhua / corrinehu 等项目作者所有，详见源码文件头部注释与 `LICENSE`。
