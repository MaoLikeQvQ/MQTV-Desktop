import { describe, expect, it } from 'vitest';
import { isQuarkShare, netdiskKind, playableLines } from '@/domain/media/netdisk';

describe('Quark-only netdisk episodes', () => {
  it('removes other disk flags with opaque IDs while retaining ordinary script IDs', () => {
    const lines = ['夸克', 'UC网盘', '阿里云盘', '百度', '天翼', '115', '123盘', '网盘线路', '高清'].map(name => ({ name, episodes: [{ name: '第一集', url: 'opaque:42' }] }));
    expect(playableLines(lines).map(line => line.name)).toEqual(['夸克', '高清']);
  });
  it('uses share hosts before flags and removes empty lines and invalid Quark pages', () => {
    const lines = [{ name: '混合', episodes: [
      { name: '百度', url: 'https://pan.baidu.com/s/a' },
      { name: '阿里', url: 'https://alipan.com/s/a' },
      { name: '夸克', url: 'https://pan.quark.cn/s/a' },
      { name: '视频', url: 'https://media.example/a.m3u8' },
      { name: '首页', url: 'https://pan.quark.cn/' },
    ] }, { name: '备用', episodes: [{ name: 'UC', url: 'https://drive.uc.cn/s/a' }] }];
    expect(playableLines(lines)).toEqual([{ name: '混合', episodes: lines[0].episodes.slice(2, 4) }]);
    expect(playableLines([{ name: '阿里', episodes: [{ name: '实际夸克', url: 'https://pan.quark.cn/s/a' }] }])).toHaveLength(1);
  });
  it('matches domain boundaries and accepts only valid HTTPS Quark shares', () => {
    expect(netdiskKind('https://www.aliyundrive.com/s/a')).toBe('other');
    expect(netdiskKind('https://pan.baidu.com.example/a.mp4')).toBeNull();
    expect(isQuarkShare('https://pan.quark.cn/s/a?pwd=1234')).toBe(true);
    for (const value of ['http://pan.quark.cn/s/a', 'https://pan.quark.cn/s/', 'https://pan.quark.cn.evil/s/a', 'https://user@pan.quark.cn/s/a']) expect(isQuarkShare(value)).toBe(false);
  });
});
