/**
 * sync-opencode-config.mjs 的端到端校验：
 *   1. 跨区域展示名不污染（cn 的 hy3 不会是 global 的展示名）
 *   2. 非 workbuddy provider 字节级原样保留
 *   3. 遗留 workbuddy-acct* 被清除
 *   4. JSON.parse 合法
 *
 * 运行：node test/sync-config.test.mjs
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROXY_ROOT = dirname(HERE)
const SCRIPT = join(PROXY_ROOT, 'scripts', 'sync-opencode-config.mjs')

const FIXTURE = `{
  "plugin": ["x"],
  "skills": { "paths": ["~/.config/opencode/skills"] },
  "provider": {
    "trae-cn": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Trae 国内版",
      "options": { "baseURL": "http://127.0.0.1:39303/v1", "apiKey": "k" },
      "models": { "gpt-5.4": { "name": "GPT-5.4 (Trae)" } }
    },
    "workbuddy-cn": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy 国内版",
      "options": { "baseURL": "http://127.0.0.1:39301/v1", "apiKey": "k" },
      "models": {
        "auto": { "name": "Auto (WorkBuddy国内)" },
        "hy3": { "name": "Hy3 (WorkBuddy国内)" },
        "glm-5.3": { "name": "GLM-5.3 (WorkBuddy国内)", "limit": { "context": 1000000, "output": 48000 } },
        "new-cn-only-model": { "name": "OnlyInCn" }
      }
    },
    "workbuddy-global": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy 国际版",
      "options": { "baseURL": "http://127.0.0.1:39302/v1", "apiKey": "k" },
      "models": {
        "hy3": { "name": "Hy3 (global-only)" },
        "glm-5.3": { "name": "GLM-5.3 (国际)", "limit": { "context": 1000000, "output": 128000 } },
        "gpt-5.6-sol": { "name": "GPT-5.6-Sol (国际)" }
      }
    },
    "workbuddy-acct0": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy 账号A",
      "options": { "baseURL": "http://127.0.0.1:39320/v1", "apiKey": "k" },
      "models": { "auto": { "name": "auto" } }
    },
    "workbuddy-acct1": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy 账号B",
      "options": { "baseURL": "http://127.0.0.1:39321/v1", "apiKey": "k" },
      "models": { "auto": { "name": "auto" } }
    }
  },
  "model": "trae-cn/gpt-5.4"
}
`

const tmp = join(process.env['TEMP'] ?? process.cwd(), `sync-test-${process.pid}.jsonc`)
writeFileSync(tmp, FIXTURE, 'utf8')

const result = spawnSync('node', [SCRIPT, '--dry-run', `--config=${tmp}`], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 })
assert.equal(result.status, 0, `sync 失败: ${result.stderr}`)
const generated = result.stdout.slice(result.stdout.indexOf('{'))

test('trae-cn 完全未改动', () => {
  const t = FIXTURE.indexOf('"trae-cn"')
  const end = FIXTURE.indexOf('"workbuddy-cn"')
  const orig = FIXTURE.slice(t, end)
  const genIdx = generated.indexOf('"trae-cn"')
  const genEnd = generated.indexOf('"workbuddy-cn"')
  assert.equal(generated.slice(genIdx, genEnd), orig, 'trae-cn 块被改动')
})

test('遗留 workbuddy-acct* 已移除', () => {
  assert.ok(!generated.includes('"workbuddy-acct0"'), 'acct0 仍存在')
  assert.ok(!generated.includes('"workbuddy-acct1"'), 'acct1 仍存在')
})

test('cn 块 hy3 的展示名仍是 cn 的，不是 global 的', () => {
  const cnBlock = generated.slice(generated.indexOf('"workbuddy-cn"'), generated.indexOf('"workbuddy-global"'))
  const m = cnBlock.match(/"hy3"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/)
  assert.ok(m, 'cn 没有 hy3 条目')
  assert.equal(m[1], 'Hy3 (WorkBuddy国内)', `实际: ${m[1]}`)
})

test('cn 块 glm-5.3 沿用了配置里的 context/output（用户手调过就尊重）', () => {
  const cnBlock = generated.slice(generated.indexOf('"workbuddy-cn"'), generated.indexOf('"workbuddy-global"'))
  const block = cnBlock.match(/"glm-5.3"\s*:\s*\{[^}]*\}/)?.[0] ?? ''
  assert.ok(block.includes('"limit"'), `glm-5.3 没 limit：${block}`)
  assert.match(block, /"context"\s*:\s*1000000/)
  assert.match(block, /"output"\s*:\s*48000/)
})

test('global 块 hy3 的展示名是 global 的，不是 cn 的', () => {
  const globalBlock = generated.slice(generated.indexOf('"workbuddy-global"'))
  const m = globalBlock.match(/"hy3"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/)
  assert.ok(m, 'global 没有 hy3 条目')
  assert.equal(m[1], 'Hy3 (global-only)', `实际: ${m[1]}`)
})

test('JSON.parse 合法', () => {
  const parsed = JSON.parse(generated)
  assert.ok(parsed.provider['workbuddy-cn'])
  assert.ok(parsed.provider['workbuddy-global'])
  assert.ok(!('workbuddy-acct0' in parsed.provider))
})

if (existsSync(tmp)) unlinkSync(tmp)