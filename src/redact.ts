/**
 * 错误信息脱敏：把本机用户目录前缀替换为 `~`，并把账号身份标识打码，
 * 避免日志/界面/截图泄露真实的 Windows 用户名、目录结构、手机号与邮箱。
 *
 * ## 为什么要有「已知身份注册表」
 *
 * 正则只能拦「形态可识别」的标识（手机号、邮箱），拦不住中文昵称——
 * 2026-09 审计发现日志里一个中文昵称出现 6790 次而正则一个都没拦住。
 * 昵称无法从形态判断，唯一可靠的来源是**账号库本身**：昵称就是
 * accounts.json 里的 nickname/label 字段，运行期可枚举。
 *
 * 因此本模块维护一个进程内注册表：serve.ts 启动时与账号库变更时把全部
 * 身份字段注册进来，`redactIdentity` 先做注册表替换（长键优先，防前缀
 * 吞噬），再做正则兜底（拦注册表没来得及覆盖的新账号）。
 *
 * 只做「路径前缀归一」与「身份打码」，保留文件名与其余信息（便于排错），
 * 不改变任何逻辑，纯字符串处理。
 *
 * @module workbuddy-proxy/redact
 */

import { homedir } from 'node:os'

const HOME = homedir()

/** 打码格式：保留前 1 后 1（中文昵称 4 字就留「铁\*\*\*环」），可区分、认不出。 */
function maskName(name: string): string {
  if (name.length <= 2) return `${name[0] ?? ''}***`
  return `${name.slice(0, 1)}***${name.slice(-1)}`
}

/** 已知身份标识 → 掩码。serve.ts 启动时与账号库变更时灌入。 */
const knownIdentities = new Map<string, string>()

/** 长度倒序的键列表（缓存，注册表变更时重建），替换时长键优先防前缀吞噬。 */
let sortedKeys: string[] = []

function rebuildSortedKeys(): void {
  sortedKeys = [...knownIdentities.keys()].sort((a, b) => b.length - a.length)
}

/** 手机号/邮箱形态：正则兜底已用更好的格式处理，注册表不再重复接手。 */
const PHONE_SHAPED = /^1[3-9]\d{9}$/
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 注册一批身份标识（昵称/手机号/邮箱）。
 *
 * 只接受有信息量的值：空串、过短（≤1 字符）的会跳过——单字符替换
 * 会把正文里正常出现的字误吞掉。手机号/邮箱形态的值也跳过——
 * 正则兜底会给它们 `138****01` / `s***@example.net` 这种信息量更高的
 * 掩码，注册表的 `1***1` 反而更差。注册表只管正则**拦不住**的东西。
 * 注册表只增不减也安全：多余键最多多打一次码，不会漏。
 */
export function registerIdentities(names: ReadonlyArray<string | undefined | null>): void {
  let changed = false
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name.length < 2) continue
    if (PHONE_SHAPED.test(name) || EMAIL_SHAPED.test(name)) continue
    if (knownIdentities.has(name)) continue
    knownIdentities.set(name, maskName(name))
    changed = true
  }
  if (changed) rebuildSortedKeys()
}

/** 测试用：清空注册表。 */
export function resetIdentitiesForTest(): void {
  knownIdentities.clear()
  sortedKeys = []
}

/**
 * 把文本中的本机 home 目录路径替换为 `~`。
 * 兼容反斜杠/正斜杠两种写法（Windows 大小写不敏感）。
 */
export function redactPaths(text: string): string {
  if (text === '') return text
  let out = text
  // 1) 精确替换 homedir 的两种写法（整体替换，非贪婪）
  for (const p of [HOME, HOME.replace(/\\/g, '/')]) {
    if (p !== '') out = out.split(p).join('~')
  }
  // 2) 兜底：任何 `X:\Users\<name>` / `X:/Users/<name>` 形式
  out = out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, '~')
  return out
}

/**
 * 账号身份打码。
 *
 * 顺序必须是「注册表先行，正则兜底」：
 * 1. 注册表按长键优先替换——中文昵称只有这条路能拦住；
 * 2. 手机号/邮箱正则拦注册表没覆盖的（如刚切换登录还没注册的 live 昵称）。
 */
export function redactIdentity(text: string): string {
  if (text === '') return text
  let out = text
  // 1) 已知身份注册表（长键优先：若「13800138001」与「38001」都注册了，
  //    先换长的，避免短键把长键切残。
  if (sortedKeys.length > 0) {
    for (const key of sortedKeys) {
      if (out.includes(key)) out = out.split(key).join(knownIdentities.get(key) ?? '')
    }
  }
  // 2) 正则兜底
  return out
    // 中国大陆手机号：1 开头 11 位（1[3-9] + 9 位）。保留前 3 后 2
    // （13800138000 -> 138****00，足以区分账号但认不出是谁）。
    // 上面这个号码是**编造的示例**——本函数存在的意义就是让真实手机号不出现在
    // 日志里，注释本身更不该写真号（早先就犯过这个错）。
    // 两侧的环视保证不会在更长的数字串（订单号、时间戳）里误匹配。
    .replace(/(?<!\d)(1[3-9]\d)\d{6}(\d{2})(?!\d)/g, '$1****$2')
    // 邮箱：保留首字符与域名，避免暴露完整地址
    .replace(/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2')
}

/** 日志与错误文案的统一出口：先打码身份，再归一路径。 */
export function redact(text: string): string {
  return redactPaths(redactIdentity(text))
}
