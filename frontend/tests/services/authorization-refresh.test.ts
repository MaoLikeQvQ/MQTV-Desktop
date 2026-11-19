import { beforeEach, expect, it, vi } from 'vitest';
import { refreshNetdiskAuthorizations, verifyInvitation } from '@/services/authorization-refresh';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

it('explicitly refreshes both providers without passing codes or calling local settings', async () => {
  invoke.mockImplementation(async (command: string) => ({ cached: true, accountId: command, refreshed: true }));
  const result = await refreshNetdiskAuthorizations();
  expect(invoke.mock.calls).toEqual([['quark_refresh', undefined], ['uc_refresh', undefined]]);
  expect(result.quark?.account?.accountId).toBe('quark_refresh');
  expect(result.uc?.account?.accountId).toBe('uc_refresh');
});

it('keeps the successful provider result when the other provider fails', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'quark_refresh') throw new Error('后台暂不可用，原授权已保留');
    return { cached: true, accountId: 'new-uc', refreshed: true };
  });
  const result = await refreshNetdiskAuthorizations();
  expect(result.quark?.error).toContain('后台暂不可用');
  expect(result.quark?.account).toBeUndefined();
  expect(result.uc?.account?.accountId).toBe('new-uc');
  expect(result.uc?.message).toBe('已从后台刷新授权');
});

it('reports local account protection and missing-code instructions separately', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'uc_refresh') throw '没有已验证的邀请码，请先在基础设置中验证后再刷新';
    return { cached: true, accountId: 'local-user', local: true, refreshed: false };
  });
  const result = await refreshNetdiskAuthorizations();
  expect(result.quark?.account?.local).toBe(true);
  expect(result.quark?.message).toBe('已保留本机扫码账号');
  expect(result.uc?.error).toContain('请先在基础设置中验证');
});

it('refreshes only the selected provider for its row action', async () => {
  invoke.mockResolvedValue({ cached: true, accountId: 'updated-uc', refreshed: true });
  const result = await refreshNetdiskAuthorizations('uc');
  expect(invoke.mock.calls).toEqual([['uc_refresh', undefined]]);
  expect(result.quark).toBeUndefined();
  expect(result.uc?.account?.accountId).toBe('updated-uc');
});

it('refreshes only the selected provider without contacting its peer', async () => {
  invoke.mockResolvedValue({ cached: true, accountId: 'selected-uc', refreshed: true });
  const result = await refreshNetdiskAuthorizations('uc');
  expect(invoke.mock.calls).toEqual([['uc_refresh', undefined]]);
  expect(result.quark).toBeUndefined();
  expect(result.uc?.account?.accountId).toBe('selected-uc');
});

it('falls back to UC only when Quark authorization is unavailable', async () => {
  invoke.mockRejectedValueOnce('邀请码缺失或错误');
  await expect(verifyInvitation('invalid-fixture')).rejects.toBe('邀请码缺失或错误');
  expect(invoke).toHaveBeenCalledTimes(1);

  invoke.mockClear();
  invoke.mockRejectedValueOnce('领取授权失败（HTTP 503）').mockResolvedValueOnce({ invitationVerified: true });
  await expect(verifyInvitation('valid-fixture')).resolves.toBeUndefined();
  expect(invoke.mock.calls).toEqual([
    ['quark_authorize_code', { authorizationCode: 'valid-fixture' }],
    ['uc_authorize_code', { authorizationCode: 'valid-fixture' }],
  ]);
});
