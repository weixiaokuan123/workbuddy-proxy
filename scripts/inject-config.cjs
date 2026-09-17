const fs = require('node:fs')
const path = require('node:path')

const cfgPath = path.join(__dirname, '..', '..', 'opencode.jsonc')
// 插件安装目录（opencode 目录下的 workbuddy-proxy），随安装位置自动推导，
// 不写死任何用户主目录，便于分享给他人。
const proxyRoot = path.join(__dirname, '..')
const keyPath = (name) => path.join(proxyRoot, 'keys', name).replace(/\\/g, '/')
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
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
console.log('providers injected; backup at opencode.jsonc.bak.workbuddy')
