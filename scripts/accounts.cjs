/**
 * 账号库命令行工具（零依赖）。
 *
 * 用法：
 *   node scripts/accounts.cjs list                  列出账号库
 *   node scripts/accounts.cjs import-switch         从 workbuddy-switch 导入全部账号
 *   node scripts/accounts.cjs capture [cn|global]   把当前 live 登录态收录为新账号
 *   node scripts/accounts.cjs remove <key>          删除账号
 *   node scripts/accounts.cjs export <文件>          导出账号库（含 token，谨慎）
 *
 * 说明：账号库落在 state/accounts.json，含 token，绝不入库（已 gitignore）。
 *
 * @module workbuddy-proxy/scripts/accounts
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const STATE_DIR = path.join(ROOT, 'state')
const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json')

function regionOfDomain(domain) {
  const d = String(domain || '').trim().toLowerCase()
  if (d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai') || d.endsWith('workbuddy.ai')) return 'global'
  return 'cn'
}

function loadAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

function saveAccounts(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = ACCOUNTS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, ACCOUNTS_FILE)
}

function toStored(cred, region, source) {
  const uid = cred.uid || ''
  return {
    key: uid ? `${region}:${uid}` : `${region}:${cred.domain}`,
    label: cred.nickname || cred.uin || uid || cred.domain || 'unknown',
    region,
    domain: cred.domain || '',
    uid,
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken || '',
    expiresAtMs: cred.expiresAtMs || 0,
    ...(cred.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: cred.refreshExpiresAtMs }),
    ...(cred.enterpriseId === undefined ? {} : { enterpriseId: cred.enterpriseId }),
    ...(cred.nickname === undefined ? {} : { nickname: cred.nickname }),
    ...(cred.uin === undefined ? {} : { uin: cred.uin }),
    source,
    createdAtMs: Date.now(),
  }
}

/** 解析 live 文件（兼容嵌套 {auth,account} 与扁平形态）。 */
function parseLive(text, filePath) {
  let doc
  try { doc = JSON.parse(text) } catch { return undefined }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
  const auth = (typeof doc.auth === 'object' && doc.auth !== null) ? doc.auth : doc
  const identity = (typeof doc.account === 'object' && doc.account !== null) ? doc.account : doc
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const num = v => (typeof v === 'number' && v > 0) ? (v > 1e12 ? v : v * 1000) : 0
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: num(auth.expiresAt),
    ...(num(auth.refreshExpiresAt) ? { refreshExpiresAtMs: num(auth.refreshExpiresAt) } : {}),
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof identity.uid === 'string' ? identity.uid : '',
    ...(typeof identity.nickname === 'string' ? { nickname: identity.nickname } : {}),
    ...(typeof identity.uin === 'string' ? { uin: identity.uin } : {}),
    ...(typeof identity.enterpriseId === 'string' ? { enterpriseId: identity.enterpriseId } : {}),
  }
}

const LIVE_FILES = {
  cn: [
    path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    process.env.WORKBUDDY_CN_AUTH_FILE,
  ].filter(Boolean),
  global: [
    path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'),
    process.env.WORKBUDDY_GLOBAL_AUTH_FILE,
  ].filter(Boolean),
}

function cmdList() {
  const list = loadAccounts()
  if (list.length === 0) { console.log('账号库为空。可执行：node scripts/accounts.cjs import-switch'); return }
  console.log(`账号库（${list.length} 个）：\n`)
  list.forEach((a, i) => {
    const left = a.expiresAtMs ? Math.round((a.expiresAtMs - Date.now()) / 60000) : 0
    const state = left > 5 ? `有效(${left}分)` : (left > 0 ? `即将过期(${left}分)` : '已过期')
    console.log(`[${i}] ${a.label}  (${a.region})`)
    console.log(`    key      : ${a.key}`)
    console.log(`    domain   : ${a.domain}`)
    console.log(`    token    : ${state}   refresh: ${a.refreshToken ? '有' : '无'}`)
    console.log(`    端口     : ${39320 + i}`)
    console.log()
  })
}

function cmdImportSwitch() {
  const f = path.join(os.homedir(), '.wb-switch', 'accounts.json')
  if (!fs.existsSync(f)) { console.log(`未找到 ${f}（未安装 workbuddy-switch 或未在其中登录账号）`); return }
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!Array.isArray(raw)) { console.log('格式不符：期望数组'); return }
  const list = loadAccounts()
  let added = 0, updated = 0
  for (const sw of raw) {
    const accessToken = typeof sw.access_token === 'string' ? sw.access_token : ''
    if (accessToken === '') continue
    const domain = String(sw.domain || '')
    const variant = String(sw.variant || '')
    const region = variant === 'global' ? 'global' : variant === 'cn' ? 'cn' : regionOfDomain(domain)
    const cred = {
      accessToken,
      refreshToken: typeof sw.refresh_token === 'string' ? sw.refresh_token : '',
      expiresAtMs: typeof sw.expiresAt === 'number' ? sw.expiresAt : 0,
      ...(typeof sw.refreshExpiresAt === 'number' ? { refreshExpiresAtMs: sw.refreshExpiresAt } : {}),
      domain,
      uid: typeof sw.uid === 'string' ? sw.uid : '',
      ...(typeof sw.nickname === 'string' ? { nickname: sw.nickname } : {}),
      ...(typeof sw.enterpriseId === 'string' ? { enterpriseId: sw.enterpriseId } : {}),
    }
    const stored = toStored(cred, region, 'switch')
    if (typeof sw.id === 'string' && sw.id) stored.key = `switch:${sw.id}`
    const i = list.findIndex(x => x.key === stored.key)
    if (i === -1) { list.push(stored); added++ }
    else { list[i] = { ...stored, createdAtMs: list[i].createdAtMs }; updated++ }
  }
  saveAccounts(list)
  console.log(`导入完成：新增 ${added}，更新 ${updated}，共 ${list.length} 个账号`)
}

function cmdCapture(region) {
  const r = region === 'global' ? 'global' : 'cn'
  const files = LIVE_FILES[r]
  for (const fp of files) {
    if (!fs.existsSync(fp)) continue
    const cred = parseLive(fs.readFileSync(fp, 'utf8'), fp)
    if (!cred) { console.log(`解析失败：${fp}`); continue }
    const stored = toStored(cred, regionOfDomain(cred.domain) || r, 'live')
    const list = loadAccounts()
    const i = list.findIndex(x => x.key === stored.key)
    if (i === -1) { list.push(stored); console.log(`已收录新账号：${stored.label} (${stored.region})`) }
    else { list[i] = { ...stored, createdAtMs: list[i].createdAtMs }; console.log(`已更新账号：${stored.label} (${stored.region})`) }
    saveAccounts(list)
    return
  }
  console.log(`未找到 ${r} 的 live 登录态文件，请先在对应区域登录 WorkBuddy 桌面端`)
}

function cmdRemove(key) {
  const list = loadAccounts()
  const next = list.filter(a => a.key !== key)
  if (next.length === list.length) { console.log(`未找到账号：${key}`); return }
  saveAccounts(next)
  console.log(`已删除：${key}（剩余 ${next.length} 个）`)
}

function cmdExport(out) {
  if (!out) { console.log('用法：node scripts/accounts.cjs export <文件路径>'); return }
  saveAccounts(loadAccounts()) // 触发一次落盘
  fs.copyFileSync(ACCOUNTS_FILE, out)
  console.log(`已导出到 ${out}（注意：含 token，切勿提交或分享）`)
}

function main() {
  const [cmd, arg] = process.argv.slice(2)
  switch (cmd) {
    case 'list': cmdList(); break
    case 'import-switch': cmdImportSwitch(); break
    case 'capture': cmdCapture(arg); break
    case 'remove': cmdRemove(arg); break
    case 'export': cmdExport(arg); break
    default:
      console.log(`账号库工具

  node scripts/accounts.cjs list                 列出账号
  node scripts/accounts.cjs import-switch        从 workbuddy-switch 导入
  node scripts/accounts.cjs capture [cn|global]  收录当前 live 登录态
  node scripts/accounts.cjs remove <key>         删除账号
  node scripts/accounts.cjs export <文件>         导出（含 token，谨慎）

账号库：${ACCOUNTS_FILE}
账号端口：从 ${39320} 起（第 i 个账号 = 39320 + i）`)
  }
}

main()
