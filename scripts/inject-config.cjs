const fs = require('node:fs')
const path = require('node:path')

const cfgPath = path.join(__dirname, '..', '..', 'opencode.jsonc')
let raw = fs.readFileSync(cfgPath, 'utf8')

// 去掉 JSONC 注释（行注释 // 与块注释），简单处理以能解析
const strip = (s) => {
  let out = ''
  let i = 0
  let inStr = false
  let quote = ''
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c
    i++
  }
  return out
}

const cfg = JSON.parse(strip(raw))
cfg.provider = cfg.provider || {}

const root = path.join(__dirname, '..')
const keyPath = (f) => path.join(root, 'keys', f).replace(/\\/g, '/')

const limit = (context, output) => ({ context, output })
const textOnly = () => ({ modalities: { input: ['text'], output: ['text'] } })

// 国内版：模型 id 以线上 /v1/models 实际返回为准（2026-09 抓取）
cfg.provider['workbuddy-cn'] = {
  npm: '@ai-sdk/openai-compatible',
  name: 'WorkBuddy 国内版',
  options: {
    baseURL: 'http://127.0.0.1:39301/v1',
    apiKey: `{file:${keyPath('cn.key')}}`
  },
  models: {
    'glm-5.3': { name: 'GLM-5.3 (WorkBuddy国内)', limit: limit(1000000, 48000) },
    'deepseek-v4-pro': { name: 'DeepSeek-V4-Pro (WorkBuddy国内)', limit: limit(1000000, 50000) },
    'deepseek-v4.1-flash': { name: 'DeepSeek-V4.1-Flash (WorkBuddy国内)', limit: limit(1000000, 50000) },
    'kimi-k3-1': { name: 'Kimi-K3 (WorkBuddy国内)', limit: limit(1000000, 32000) },
    'kimi-k2.7': { name: 'Kimi-K2.7 (WorkBuddy国内)', limit: limit(256000, 32000) },
    'minimax-m3': { name: 'MiniMax-M3 (WorkBuddy国内)', limit: limit(512000, 128000) },
    'hy3': { name: 'Hy3 (WorkBuddy国内)', limit: limit(192000, 64000) },
    'hy4-preview': { name: 'Hy4 Preview (WorkBuddy国内)' },
    'auto': { name: 'Auto (WorkBuddy国内)' }
  }
}

// 国际版：待登录 WorkBuddy AI 后自动可用；模型为桌面通道 20 个 roster
cfg.provider['workbuddy-global'] = {
  npm: '@ai-sdk/openai-compatible',
  name: 'WorkBuddy 国际版',
  options: {
    baseURL: 'http://127.0.0.1:39302/v1',
    apiKey: `{file:${keyPath('global.key')}}`
  },
  models: {
    'deepseek-v4.1-flash': { name: 'DeepSeek-V4.1-Flash (免费·国际)', limit: limit(1000000, 128000) },
    'gpt-5.6-sol': { name: 'GPT-5.6-Sol (国际)', limit: limit(1000000, 128000), ...textOnly() },
    'gpt-5.6-terra': { name: 'GPT-5.6-Terra (国际)', limit: limit(1000000, 128000), ...textOnly() },
    'gpt-5.6-luna': { name: 'GPT-5.6-Luna (国际)', limit: limit(1000000, 128000), ...textOnly() },
    'gemini-3.5-flash': { name: 'Gemini-3.5-Flash (国际)', limit: limit(1000000, 65536), ...textOnly() },
    'glm-5.3': { name: 'GLM-5.3 (国际)', limit: limit(1000000, 48000) },
    'kimi-k3': { name: 'Kimi-K3 (国际)', limit: limit(1000000, 32000) }
  }
}

fs.copyFileSync(cfgPath, cfgPath + '.bak.workbuddy')

// ===== 多账号：从账号库为每个账号自动生成一个 provider =====
// 端口规则与 src/serve.ts 一致：第 i 个账号 = 39320 + i
async function injectAccountProviders() {
  let accounts = []
  try {
    const raw = fs.readFileSync(path.join(root, 'state', 'accounts.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) accounts = parsed
  } catch { /* 无账号库则跳过 */ }

  if (accounts.length === 0) return 0

  // 用第一个账号端点的模型目录作为模板（拉不到就用国内默认列表）
  let templateModels = null
  try {
    const keyFile = path.join(root, 'keys', 'acct-0.key')
    const key = fs.readFileSync(keyFile, 'utf8').trim()
    const res = await fetch('http://127.0.0.1:39320/v1/models', {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const j = await res.json()
      if (Array.isArray(j.data) && j.data.length > 0) templateModels = j.data
    }
  } catch { /* 代理未启动时用默认 */ }

  const baseModels = templateModels
    ?? Object.entries(cfg.provider['workbuddy-cn']?.models ?? {}).map(([id]) => ({ id }))

  let count = 0
  accounts.forEach((a, i) => {
    const port = 39320 + i
    const providerId = `workbuddy-acct${i}`
    const models = {}
    for (const m of baseModels) {
      if (typeof m === 'string') models[m] = { name: m }
      else models[m.id] = { name: m.id }
    }
    cfg.provider[providerId] = {
      npm: '@ai-sdk/openai-compatible',
      name: `WorkBuddy·${a.nickname || a.uin || a.label || ('账号' + i)}`,
      options: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: `{file:${keyPath(`acct-${i}.key`)}}`,
      },
      models,
    }
    count++
  })
  return count
}

injectAccountProviders().then(accountCount => {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.log('providers injected; backup at opencode.jsonc.bak.workbuddy')
  const providers = Object.keys(cfg.provider).filter(k => k.startsWith('workbuddy'))
  console.log('WorkBuddy providers:', providers.join(', '))
  console.log(accountCount > 0
    ? `已注入 ${accountCount} 个账号 provider（端口 39320 起）`
    : '未发现账号库（state/accounts.json），仅注入 live 两个区域')
}).catch(e => {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.error('账号 provider 注入失败（已写入基础 provider）:', e.message)
})
