#!/usr/bin/env node
/**
 * 兼容入口：把 opencode.jsonc 的 workbuddy provider 块同步为最新。
 *
 * 历史上本脚本自己维护一份硬编码模型清单，并为每个账号库账号生成
 * 一个独立的 workbuddy-acctN provider（端口 39320+）。现在已改为
 * 「单一入口 + 全池自动切换」，账号端口默认关闭，那份清单与 acct 块
 * 都成了过期数据。
 *
 * 因此本脚本不再自己写配置，而是原样转调 sync-opencode-config.mjs ——
 * 后者从账号库 + 实时模型目录生成 workbuddy-* 块，并清除遗留 acct 块。
 * 保留本文件是为了不破坏 install.ps1 与既有文档里的调用路径。
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const target = path.join(__dirname, 'sync-opencode-config.mjs')
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

if (result.error) {
  console.error('[inject-config] 调用 sync-opencode-config.mjs 失败：', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
