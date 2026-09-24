#!/usr/bin/env node
/**
 * 同步 opencode.jsonc 里 workbuddy-* 的 provider 块。
 *
 * 背景：workbuddy-proxy 改成池化入口后，opencode 只需国内/国际两个 provider；
 * 账号库的增减不再需要手改配置。账号库是唯一数据源（state/accounts.json）。
 *
 * 设计约束（重要）：
 *  - opencode.jsonc 是**用户手写的带注释 JSONC**，且包含大量与本次改造无关的
 *    provider（trae / minimax / sensenseva / tokenrhythm …）。本脚本**只**重写
 *    key 以 `workbuddy-` 开头的 provider 块，其余字节级原样保留。
 *  - 不整体 JSON.parse → 不重新序列化，避免丢注释、改缩进、乱序。
 *  - 幂等：生成结果与现有内容一致时不写文件（不改 mtime，不触发 opencode 重载）。
 *
 * 用法：
 *   node scripts/sync-opencode-config.mjs             # 写入
 *   node scripts/sync-opencode-config.mjs --dry-run   # 只打印差异，不写
 *   node scripts/sync-opencode-config.mjs --check     # 不一致则退出码 2
 *
 * @module workbuddy-proxy/scripts/sync-opencode-config
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROXY_ROOT = dirname(HERE)
const OPENCODE_DIR = dirname(PROXY_ROOT)
// 注意：只认 --config 或默认路径。不要读 OPENCODE_CONFIG 环境变量——它可能被
// 其他宿主（如 openchamber）指向不相干的托管配置。
const CONFIG = process.argv.find(a => a.startsWith('--config='))?.slice('--config='.length)
  ?? join(OPENCODE_DIR, 'opencode.jsonc')

const argv = new Set(process.argv.slice(2))
const DRY_RUN = argv.has('--dry-run')
const CHECK = argv.has('--check')

/** 由代理暴露的模型目录生成 provider models 段。 */
function modelsBlock(models, indent, region, prior) {
  return models.map(m => {
    // 展示名优先级：配置里已有的 > 内置映射表 > 模型 id 本身
    const prev = prior.get(m.id)
    const name = prev?.name ?? DISPLAY_NAMES[region]?.[m.id] ?? m.name ?? m.id
    const lines = [
      `${indent}"${m.id}": {`,
      `${indent}  "name": ${JSON.stringify(name)},`,
    ]
    // 上下文上限沿用配置里已有的（用户手调过就尊重），新模型不写 limit 交由 opencode 默认
    if (prev?.context) lines.push(`${indent}  "limit": { "context": ${prev.context}, "output": ${prev.output ?? 32768} },`)
    // 末尾多余逗号去掉（JSON 不允许尾逗号）
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
    lines.push(`${indent}}`)
    return lines.join('\n')
  }).join(',\n')
}

/** 生成两个 provider 块（国内/国际），交给定位替换使用。 */
function buildProviders(plan, existingText = '') {
  const blocks = []
  for (const region of ['cn', 'global']) {
    const p = plan[region]
    if (p === undefined) continue
    const key = region === 'cn' ? 'workbuddy-cn' : 'workbuddy-global'
    // 关键：prior 必须 per-region 计算，否则 cn 的 `hy3` 会捡到 global 的展示名。
    const prior = existingModelMeta(existingText, key)
    const lines = [
      `    "${key}": {`,
      `      "npm": "@ai-sdk/openai-compatible",`,
      `      "name": ${JSON.stringify(region === 'cn' ? 'WorkBuddy 国内版' : 'WorkBuddy 国际版')},`,
      `      "options": {`,
      `        "baseURL": "http://127.0.0.1:${p.port}/v1",`,
      `        "apiKey": "{file:${p.keyFile}}"`,
      `      },`,
      `      "models": {`,
      modelsBlock(p.models, '        ', region, prior),
      `      }`,
      `    }`,
    ]
    blocks.push({ key, text: lines.join('\n') })
  }
  return blocks
}

/** 找出配置里遗留的 workbuddy-acctN provider（账号端口停用后应清除）。 */
function findStaleAccountProviders(text) {
  const out = []
  const re = /^[ \t]*"(workbuddy-acct\d+)"\s*:\s*\{/gm
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

/**
 * 在 JSONC 文本中定位某个 provider 块的字符区间。
 * 用「key 起始行 → 配对花括号」的方式扫描，注释与字符串内的花括号需跳过。
 */
function findProviderBlock(text, providerKey) {
  const anchor = new RegExp(`^([ \\t]*)"${providerKey.replace(/[-]/g, '\\-')}"\\s*:\\s*\\{`, 'm')
  const m = anchor.exec(text)
  if (m === null) return null

  const open = text.indexOf('{', m.index)
  let depth = 0
  let i = open
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++ } continue }
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === '"') { inString = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error(`provider ${providerKey} 花括号未配对`)

  // 连同行首缩进一起替换；吞掉紧随其后的逗号（若有），由调用方统一补
  let end = i + 1
  let start = m.index
  const trailing = /^\s*,/.exec(text.slice(end))
  if (trailing !== null) end += trailing[0].length
  else {
    // 该块是最后一个：向前吃掉分隔逗号，避免留下孤立的 ","
    const before = /,\s*$/.exec(text.slice(0, start))
    if (before !== null) start -= before[0].length
  }
  return { start, end }
}

/** 探测某个端口的模型目录；失败返回 null。 */
async function fetchModels(port, keyFile) {
  try {
    const key = (await readFile(keyFile, 'utf8')).trim()
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const data = await r.json()
    if (!Array.isArray(data?.data) || data.data.length === 0) return null
    return data.data.map(m => ({ id: m.id, name: m.id }))
  } catch {
    return null
  }
}

/** 兜底模型清单：代理未运行时保持配置可用（与改造前的清单一致）。 */
const FALLBACK = {
  cn: [
    'auto', 'hy4-preview', 'hy3', 'deepseek-v4.1-flash', 'deepseek-v4-pro',
    'glm-5.3', 'kimi-k3-1', 'kimi-k2.7', 'minimax-m3',
  ],
  global: [
    'auto', 'deepseek-v4.1-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gemini-3.5-flash', 'glm-5.3', 'kimi-k3',
  ],
}

/**
 * 展示名映射：上游只给模型 id，配置里的人类可读名由本表提供。
 * 找不到就退回 id 本身（不虚构）。
 */
const DISPLAY_NAMES = {
  cn: {
    'glm-5.3': 'GLM-5.3 (WorkBuddy国内)',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro (WorkBuddy国内)',
    'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash (WorkBuddy国内)',
    'kimi-k3-1': 'Kimi-K3 (WorkBuddy国内)',
    'kimi-k2.7': 'Kimi-K2.7 (WorkBuddy国内)',
    'minimax-m3': 'MiniMax-M3 (WorkBuddy国内)',
    hy3: 'Hy3 (WorkBuddy国内)',
    'hy4-preview': 'Hy4 Preview (WorkBuddy国内)',
    auto: 'Auto (WorkBuddy国内)',
  },
  global: {
    'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash (免费·国际)',
    'gpt-5.6-sol': 'GPT-5.6-Sol (国际)',
    'gpt-5.6-terra': 'GPT-5.6-Terra (国际)',
    'gpt-5.6-luna': 'GPT-5.6-Luna (国际)',
    'gemini-3.5-flash': 'Gemini-3.5-Flash (国际)',
    'glm-5.3': 'GLM-5.3 (国际)',
    'kimi-k3': 'Kimi-K3 (国际)',
  },
}

/**
 * 模型展示名与上下文上限：优先沿用配置里已有的值（用户手调过就尊重），
 * 新模型才用映射表 / id 兜底。
 *
 * 关键：只扫描 **workbuddy-cn / workbuddy-global 自己的块**。
 * 之前扫全文导致跨 provider 污染（国际版的 gpt-5.4 会捡到 Trae 的展示名）。
 */
function existingModelMeta(text, key) {
  const out = new Map()
  const range = findProviderBlock(text, key)
  if (range === null) return out
  const scope = text.slice(range.start, range.end)
  const modelsAt = scope.indexOf('"models"')
  if (modelsAt === -1) return out
  // 定位 models 对象体的起始 `{`，从其内部开始扫描模型条目。
  // 关键：不能从 `"models"` 键开始，否则正则首匹配会命中 `"models"` 本身，
  // 配对扫描会吞掉整个 models 对象，真正的模型条目一个都提不出来。
  const openBrace = scope.indexOf('{', modelsAt)
  if (openBrace === -1) return out
  const re = /"([A-Za-z0-9._-]+)"\s*:\s*\{/g
  re.lastIndex = openBrace + 1
  let m
  while ((m = re.exec(scope)) !== null) {
    // 嵌套的 `"limit": {` 也会被匹配到，但它的内容没有 `"name"`，会被 continue 跳过
    const open = scope.indexOf('{', m.index)
    if (open === -1) continue
    let depth = 0, inStr = false, p = open
    for (; p < scope.length; p++) {
      const c = scope[p]
      if (inStr) { if (c === '\\') { p++; continue } if (c === '"') inStr = false; continue }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) break }
    }
    const inner = scope.slice(open + 1, p)
    if (!inner.includes('"name"')) continue
    const name = /"name"\s*:\s*"([^"]*)"/.exec(inner)?.[1]
    const ctx = /"context"\s*:\s*(\d+)/.exec(inner)?.[1]
    const output = /"output"\s*:\s*(\d+)/.exec(inner)?.[1]
    if (name !== undefined) {
      out.set(m[1], {
        name,
        context: ctx ? Number(ctx) : undefined,
        output: output ? Number(output) : undefined,
      })
    }
    re.lastIndex = p + 1
  }
  return out
}

async function buildPlan() {
  const plan = {}
  for (const [region, port, keyName] of [['cn', 39301, 'cn.key'], ['global', 39302, 'global.key']]) {
    const keyFile = join(PROXY_ROOT, 'keys', keyName)
    const live = await fetchModels(port, keyFile)
    const ids = live ?? FALLBACK[region].map(id => ({ id, name: id }))
    plan[region] = { port, keyFile: keyFile.replace(/\\/g, '/'), models: ids, source: live ? 'live' : 'fallback' }
  }
  return plan
}

async function main() {
  const original = await readFile(CONFIG, 'utf8')
  const plan = await buildPlan()
  const blocks = buildProviders(plan, original)

  // 逐个替换已存在的块；记录替换区间避免位移互相影响
  let text = original
  const replaced = []
  for (const b of blocks) {
    const range = findProviderBlock(text, b.key)
    if (range === null) {
      process.stderr.write(`[warn] 未在配置里找到 ${b.key}，跳过（请先手动添加一个占位块）\n`)
      continue
    }
    text = text.slice(0, range.start) + b.text + ',' + text.slice(range.end)
    replaced.push(b.key)
  }

  // 账号端口已停用：清掉历史遗留的 workbuddy-acctN 块（它们指向已关闭的端口 39320+）。
  const removed = []
  for (const key of findStaleAccountProviders(text)) {
    const range = findProviderBlock(text, key)
    if (range === null) continue
    text = text.slice(0, range.start) + text.slice(range.end)
    removed.push(key)
  }

  const changed = text !== original
  const summary = `更新 ${replaced.join(', ') || '无'}`
    + (removed.length > 0 ? `；移除遗留 ${removed.join(', ')}` : '')
    + `（模型来源：${Object.values(plan).map(p => p.source).join('/')}）`
  if (!changed) {
    process.stdout.write('workbuddy provider 块已是最新，无需改动\n')
    return 0
  }
  if (CHECK) {
    process.stderr.write(`workbuddy provider 块与账号库/模型目录不一致：${summary}\n`)
    return 2
  }
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] ${summary}\n`)
    process.stdout.write(text)
    return 0
  }
  await writeFile(CONFIG, text, 'utf8')
  process.stdout.write(`${summary} → ${CONFIG}\n`)
  return 0
}

main().then(code => process.exit(code)).catch(err => {
  process.stderr.write(`同步失败：${err?.message ?? err}\n`)
  process.exit(1)
})
