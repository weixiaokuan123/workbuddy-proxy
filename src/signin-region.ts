/**
 * 签到目标按区域切分。
 *
 * 这条规则是从一个真实 bug 里长出来的：签到目标表是全局的（池化模式下每个
 * 账号都要独立签到），而 shim 按区域建立。原来两个「响应某区域」的出口都
 * 直接遍历全表，于是
 *   - 国际版的账号卡片把国内账号也列了出来；
 *   - 更糟的是，在国际版点「立即签到」会**顺带领取国内账号的积分**——
 *     这不只是显示错位，是真的动了别的区。
 *
 * travel 那边早就因为同样的问题踩过并修好，签到没跟上。抽成纯函数是为了
 * 让这条规则只有一处实现——否则下次新增出口时又得记得手动加 if。
 */

export interface SigninTargetLike {
  id: string
  region: 'cn' | 'global'
}

/**
 * 只返回属于该区域的目标。
 *
 * 注意这是**响应某个区域**时的过滤；后台的定时签到循环应当遍历全表，
 * 不该用这个函数——每个账号每天都要签到，与区域无关。
 */
export function targetsForRegion<T extends SigninTargetLike>(
  targets: readonly T[],
  region: 'cn' | 'global',
): T[] {
  return targets.filter(t => t.region === region)
}

/** 排除指定目标（兜底领取时要跳过端口自身那个）。 */
export function targetsExcept<T extends SigninTargetLike>(targets: readonly T[], selfId: string): T[] {
  return targets.filter(t => t.id !== selfId)
}
