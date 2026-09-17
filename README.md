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
（MIT，Copyright (c) 2026 Corrine Hu）。详见 `THIRD_PARTY_NOTICES.md`（如有）与 `LICENSE`。

改造点：去掉 DSH 插件外壳，只保留纯 Node 连接内核，做成 opencode 侧的独立 OpenAI 兼容代理。

## 运行要求

- Node.js **22.19+ 或 24+**（TypeScript 由 Node 原生类型擦除直接运行，**无需构建**）
- Windows / macOS / Linux
- 本机已安装并登录 WorkBuddy 桌面端（代理只读它的登录态文件，不修改、不上传）

## 账号与隐私

- 本仓库**不包含任何账号凭据**。`keys/` 里的 `*.key` 在首次启动时随机生成（0600 权限）。
- 登录态来自 WorkBuddy 桌面端本地文件，只在内存中刷新，**永不写回、不落地、不联网外传**。
- 各平台读取路径见 `src/auth.ts` 的 `defaultDesktopAuthDirs()`；也可用环境变量覆盖：
  - `WORKBUDDY_CN_AUTH_FILE`
  - `WORKBUDDY_GLOBAL_AUTH_FILE`
  - `WORKBUDDY_AUTH_FILE`（兼容旧变量）

## 安装到 opencode

1. 把本目录放到 opencode 配置目录下，例如：
   - Windows：`%USERPROFILE%\.config\opencode\workbuddy-proxy`
   - macOS / Linux：`~/.config/opencode/workbuddy-proxy`
2. 启动代理：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
   ```
3. 把 provider 注入 opencode 配置（会自动备份 `opencode.jsonc`）：
   ```powershell
   node .\scripts\inject-config.cjs
   ```
4. 验证：
   ```powershell
   node .\scripts\verify-config.cjs
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
   ```

一次性完成 2–3 步，也可直接跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## 日常运维

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

## 目录结构

```
workbuddy-proxy/
  add-bom.cjs              给 .ps1 脚本补 UTF-8 BOM（Windows PowerShell 5.1 中文兼容）
  keys/                    运行时生成的持久 bearer key（不随仓库分发）
  logs/                    运行日志与 pid（不随仓库分发）
  scripts/                 启动 / 停止 / 状态 / 自启 / 配置注入
  src/
    auth.ts                只读桌面端登录态、内存内 token 刷新
    catalog.ts             模型目录（静态 fallback + 上游刷新）
    serve.ts               守护入口（双区域）
    shim.ts                OpenAI 兼容回环端点
    upstream.ts            上游网关客户端与协议映射
    version.ts             版本常量
```

## 许可

MIT。原始版权归 dingminhua / corrinehu 等项目作者所有，详见源码文件头部注释。
