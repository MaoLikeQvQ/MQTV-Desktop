import { authorizeQuarkCode, refreshQuarkAuthorization, type QuarkAccount } from '@/api/quark';
import { authorizeUcCode, refreshUcAuthorization } from '@/api/uc';

export type AuthorizationRefreshResult = { account?: QuarkAccount; error?: string; message: string };

/** 刷新全部网盘，分别返回每类授权的结果。 */
export function refreshNetdiskAuthorizations(): Promise<Record<'quark' | 'uc', AuthorizationRefreshResult>>;
/** 刷新指定网盘；只返回所选项目，失败时保留原授权。 */
export function refreshNetdiskAuthorizations(provider: 'quark' | 'uc' | undefined): Promise<Partial<Record<'quark' | 'uc', AuthorizationRefreshResult>>>;
/** 刷新指定网盘或全部网盘；保留部分成功的结果，失败时回传说明供原卡片继续展示旧状态。 */
export async function refreshNetdiskAuthorizations(provider?: 'quark' | 'uc'): Promise<Partial<Record<'quark' | 'uc', AuthorizationRefreshResult>>> {
  const selected = provider ? [provider] : ['quark', 'uc'] as const;
  const results = await Promise.allSettled(selected.map(value => value === 'quark' ? refreshQuarkAuthorization() : refreshUcAuthorization()));
  /** 将单个网盘结果转换为提示，不读取或传递原生层保存的邀请码。 */
  function result(index: number): AuthorizationRefreshResult {
    const settled = results[index];
    if (settled.status === 'rejected') return { error: String(settled.reason), message: '刷新失败，原授权已保留' };
    return { account: settled.value, message: ('refreshed' in settled.value && settled.value.refreshed) ? '已从后台刷新授权' : '已保留本机扫码账号' };
  }
  return Object.fromEntries(selected.map((value, index) => [value, result(index)]));
}

/** 沿用网盘授权接口验证邀请码，夸克服务无可用账号时交由 UC 验证。 */
export async function verifyInvitation(code: string): Promise<void> {
  try {
    await authorizeQuarkCode(code);
  } catch (reason) {
    if (!/\bHTTP 503\b/.test(String(reason))) throw reason;
    await authorizeUcCode(code);
  }
}
