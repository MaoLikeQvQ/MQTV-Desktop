import { updateCheckUrl } from '@/api/update';
import { DESKTOP_UPDATE_URL } from '@/config/services';
import { describe, expect, it } from 'vitest';
import { parseUpdateResult, type AppUpdateInfo } from '@/domain/settings/app-update';
import published from '../../../../releases/desktop-update.json';
const info: AppUpdateInfo = { platform: 'macos', arch: 'arm64', osVersion: '26.0', packageName: 'com.maolike.mqtv.desktop', versionCode: 99, versionName: '0.9.0' };
const mac = published.packages[0], windows = published.packages[1];
describe('GitHub desktop update manifest', () => {
  it('checks the public GitHub release attachment without device query parameters', () => {
    expect(updateCheckUrl()).toBe(DESKTOP_UPDATE_URL);
    expect(new URL(updateCheckUrl()).search).toBe('');
  });
  it('selects the matching platform and architecture', () => {
    expect(parseUpdateResult(published, info)).toEqual({ updateAvailable: true, versionName: published.versionName, notes: published.notes, downloadUrl: mac.downloadUrl });
    expect(parseUpdateResult(published, { ...info, platform: 'windows', arch: 'x64' })).toMatchObject({ downloadUrl: windows.downloadUrl });
    expect(parseUpdateResult(published, { ...info, arch: 'x64' })).toEqual({ updateAvailable: false });
    expect(parseUpdateResult(published, { ...info, platform: 'windows', arch: 'arm64' })).toEqual({ updateAvailable: false });
  });
  it('does not downgrade or reinstall the current build', () => {
    expect(parseUpdateResult(published, { ...info, versionCode: published.versionCode })).toEqual({ updateAvailable: false });
    expect(parseUpdateResult(published, { ...info, versionCode: published.versionCode + 1 })).toEqual({ updateAvailable: false });
  });
  it('honors optional minimum OS versions numerically', () => {
    const release = { ...published, packages: [{ ...mac, minOsVersion: '14.2' }] };
    expect(parseUpdateResult(release, { ...info, osVersion: '14.1.9' })).toEqual({ updateAvailable: false });
    expect(parseUpdateResult(release, { ...info, osVersion: '14.2.0' })).toMatchObject({ updateAvailable: true });
    expect(parseUpdateResult(release, { ...info, osVersion: '14.10' })).toMatchObject({ updateAvailable: true });
  });
  it.each([null, { updateAvailable: false }, { ...published, schemaVersion: 2 }, { ...published, packageName: 'other' }, { ...published, versionCode: 1.5 }, { ...published, packages: [] }, { ...published, packages: [mac, mac] }, { ...published, packages: [{ ...mac, minOsVersion: '14.x' }] }])('rejects malformed manifests %j', value => {
    expect(() => parseUpdateResult(value, info)).toThrow();
  });
  it.each([
    'https://example.com/setup.dmg',
    'https://github.com/other/repo/releases/download/v1/setup.dmg',
    'http://github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/setup.dmg',
    'https://github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/setup.exe',
    'https://github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/setup.dmg?token=secret',
    'https://github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/setup.dmg#fragment',
    'https://github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/a%2fb.dmg',
    'https://user:pass@github.com/MaoLikeQvQ/MQTV-Desktop/releases/download/v1/setup.dmg',
  ])('rejects untrusted or mismatched installers %s', downloadUrl => {
    expect(() => parseUpdateResult({ ...published, packages: [{ ...mac, downloadUrl }] }, info)).toThrow();
  });
});
