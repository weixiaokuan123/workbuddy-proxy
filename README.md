# workbuddy-proxy

在 opencode 里使用 WorkBuddy（CodeBuddy）桌面端已登录模型的一个纯 Node 本地代理。

它把 WorkBuddy 桌面端的登录态转成 opencode 可直接调用的 **OpenAI 兼容** 端点：

- 国内版：`http://127.0.0.1:39301/v1`
- 国际版：`http://127.0.0.1:39302/v1`

一个进程同时服务两个区域，每个区域用独立的持久 `bearer key` 做本地鉴权。

## 来源

本项目改自 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
（MIT，Copyright (c) 2026 LaoDing），其设计又源自
[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
（MIT，Copyright (c) 2026 Corrine Hu）。详见 `THIRD_PARTY_NOTICES.md` 与 `LICENSE`。

改造点：去掉 DSH 插件外壳，只保留纯 Node 连接内核，做成 opencode 侧的独立 OpenAI 兼容代理。

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

## 账号与隐私

- 本仓库**不含任何账号凭据**。`keys/` 下的 `*.key` 在首次启动时随机生成（0600 权限），`logs/` 亦不入库。
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
| 端口未监听 | 查看 `logs\proxy.err.log`；确认 Node 为 22.19+/24+ |
| 报 `domain 区域不符` | 该端口收到了另一区域的账号，检查两个登录态文件是否串了 |
| opencode 里看不到新模型 | 重启 opencode；再跑 `verify-config.cjs` 确认注入成功 |
| `.ps1` 中文乱码 | 跑 `node add-bom.cjs` 补 BOM |

## 许可

MIT。原始版权归 dingminhua / corrinehu 等项目作者所有，详见源码文件头部注释与 `LICENSE`。
