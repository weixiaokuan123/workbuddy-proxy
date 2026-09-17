const fs = require('node:fs')
const path = require('node:path')
// opencode 配置目录：默认 ~/.config/opencode，可用 OPENCODE_CONFIG_DIR 覆盖。
const opencodeDir = process.env.OPENCODE_CONFIG_DIR
  || path.join(require('node:os').homedir(), '.config', 'opencode')
const p = path.join(opencodeDir, 'opencode.jsonc')
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
console.log('JSON OK')
console.log('model =', j.model)
console.log('providers =', Object.keys(j.provider).join(', '))
console.log('cn baseURL =', j.provider['workbuddy-cn'].options.baseURL)
// 只确认 apiKey 指向 key 文件，不打印其内容（避免终端/日志泄漏本地 key）
const cnKey = String(j.provider['workbuddy-cn'].options.apiKey ?? '')
console.log('cn apiKey  =', cnKey.startsWith('{file:') ? cnKey.replace(/[^/\\]+$/, '***') : '(非 file 引用)')
console.log('cn models  =', Object.keys(j.provider['workbuddy-cn'].models).join(', '))
console.log('gl baseURL =', j.provider['workbuddy-global'].options.baseURL)
