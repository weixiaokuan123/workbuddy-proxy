#!/usr/bin/env node
/**
 * 只读校验：确认 opencode.jsonc 里的 workbuddy provider 块结构正确。
 *
 * 依赖注入已由 sync-opencode-config.mjs 完成；本脚本不修改任何文件。
 * 检查项：
 *   1. 文件能被解析（容忍 jsonc 注释）
 *   2. workbuddy-cn / workbuddy-global 存在且 baseURL 指向本机两个入口
 *   3. apiKey 是 {file:...} 引用（不打印内容，避免泄漏）
 *   4. 无遗留的 workbuddy-acctN 块（那些端口已关闭）
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const opencodeDir = process.env.OPENCODE_CONFIG_DIR
  || path.join(os.homedir(), '.config', 'opencode')
const p = path.join(opencodeDir, 'opencode.jsonc')

/** 去掉行注释与块注释（跳过字符串内部），使 JSONC 可被 JSON.parse 解析。 */
function stripComments(s) {
  let out = ''
  let i = 0
  let inStr = false
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c
    i++
  }
  return out
}

let problems = 0
const fail = (msg) => { console.error(`  ✖ ${msg}`); problems++ }
const ok = (msg) => { console.log(`  ✓ ${msg}`) }

let raw
try {
  raw = fs.readFileSync(p, 'utf8')
} catch (error) {
  console.error(`无法读取 ${p}: ${error.message}`)
  process.exit(1)
}

let j
try {
  j = JSON.parse(stripComments(raw))
  ok(`JSON 可解析（${p}）`)
} catch (error) {
  console.error(`JSON 解析失败: ${error.message}`)
  process.exit(1)
}

const providers = j.provider ?? {}
console.log(`providers = ${Object.keys(providers).join(', ')}`)

for (const [key, port] of [['workbuddy-cn', 39301], ['workbuddy-global', 39302]]) {
  const prov = providers[key]
  if (prov === undefined) { fail(`${key} 缺失`); continue }
  const base = String(prov.options?.baseURL ?? '')
  if (base === `http://127.0.0.1:${port}/v1`) ok(`${key} baseURL → ${base}`)
  else fail(`${key} baseURL 异常: ${base}`)
  const apiKey = String(prov.options?.apiKey ?? '')
  if (apiKey.startsWith('{file:')) ok(`${key} apiKey 为 file 引用（${apiKey.replace(/[^/\\]+$/, '***')}）`)
  else fail(`${key} apiKey 非 file 引用`)
  const count = Object.keys(prov.models ?? {}).length
  if (count > 0) ok(`${key} 有 ${count} 个模型`)
  else fail(`${key} 没有任何模型`)
}

const stale = Object.keys(providers).filter(k => /^workbuddy-acct\d+$/.test(k))
if (stale.length === 0) ok('无遗留 workbuddy-acctN 块')
else fail(`存在遗留块（端口已关闭）：${stale.join(', ')}`)

console.log(problems === 0 ? '\n校验通过' : `\n发现 ${problems} 个问题`)
process.exit(problems === 0 ? 0 : 1)
