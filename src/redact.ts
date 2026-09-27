/**
 * 错误信息脱敏：把本机用户目录前缀替换为 `~`，并把账号身份标识打码，
 * 避免日志/界面/截图泄露真实的 Windows 用户名、目录结构、手机号与邮箱。
 *
 * 只做「路径前缀归一」与「身份打码」，保留文件名与其余信息（便于排错），
 * 不改变任何逻辑，纯字符串处理。
 *
 * @module workbuddy-proxy/redact
 */

import { homedir } from 'node:os'

const HOME = homedir()

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
 * 账号库里的 label / nickname 就是手机号或邮箱，而旅行、签到、切换池这些
 * 日志几乎每条都带 label——实测 `logs\proxy.out.log` 里出现了 1200+ 个手机号、
 * 30 个邮箱。这些日志会随日志文件长期留在磁盘上，用户贴日志求助时也会
 * 直接把它们发出去。`redactPaths` 对它们完全无效（那不是路径）。
 *
 * 保留首尾各若干位，既能分辨「是哪个账号」，又认不出是谁。
 */
export function redactIdentity(text: string): string {
  if (text === '') return text
  return text
    // 中国大陆手机号：1 开头 11 位（1[3-9] + 9 位）。保留前 3 后 2
    // （13800138001 -> 181****13，足以区分账号但认不出是谁）。
    // 两侧的环视保证不会在更长的数字串（订单号、时间戳）里误匹配。
    .replace(/(?<!\d)(1[3-9]\d)\d{6}(\d{2})(?!\d)/g, '$1****$2')
    // 邮箱：保留首字符与域名，避免暴露完整地址
    .replace(/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2')
}

/** 日志与错误文案的统一出口：先打码身份，再归一路径。 */
export function redact(text: string): string {
  return redactPaths(redactIdentity(text))
}
