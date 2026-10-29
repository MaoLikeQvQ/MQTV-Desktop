import { updateCheckUrl } from '@/api/update';
import { BACKEND_URL } from '@/config/services';
import { describe, expect, it } from 'vitest';
import { parseUpdateResult, type AppUpdateInfo } from '@/domain/settings/app-update';
const info: AppUpdateInfo = { platform: 'macos', arch: 'arm64', osVersion: '26.0', packageName: 'com.maolike.mqtv.desktop', versionCode: 1, versionName: '0.1.0' };
const release = { updateAvailable: true, platform: 'macos', flavor: 'desktop', packageName: info.packageName, versionCode: 2, versionName: '0.2.0', notes: '修复播放', downloadUrl: '/api/apk/test-release' };
describe('desktop update contract', () => {
  it('sends the complete tvadmin desktop query', () => {
    const url = new URL(updateCheckUrl(info));
    expect(url.origin).toBe(BACKEND_URL);
    expect(url.pathname).toBe('/api/update');
    expect(Object.fromEntries(url.searchParams)).toEqual({ platform: 'macos', flavor: 'desktop', packageName: info.packageName, versionCode: '1', osVersion: '26.0', arch: 'arm64' });
    expect(new URL(updateCheckUrl({ ...info, platform: 'windows', arch: 'x64', osVersion: '10.0.26100' })).searchParams.get('platform')).toBe('windows');
  });
  it('distinguishes no compatible update from a valid newer release', () => {
    expect(parseUpdateResult({ updateAvailable: false }, info)).toEqual({ updateAvailable: false });
    expect(parseUpdateResult(release, info)).toEqual({ updateAvailable: true, versionName: '0.2.0', notes: '修复播放', downloadUrl: new URL('/api/apk/test-release', updateCheckUrl(info)).href });
  });
  it.each([{ error: 'bad query' }, null, { ...release, platform: 'windows' }, { ...release, packageName: 'other' }, { ...release, versionCode: 1 }, { ...release, downloadUrl: 'https://example.com/api/apk/test' }, { ...release, downloadUrl: '/api/admin' }])('rejects malformed or mismatched responses %j', value => {
    expect(() => parseUpdateResult(value, info)).toThrow();
  });
});
