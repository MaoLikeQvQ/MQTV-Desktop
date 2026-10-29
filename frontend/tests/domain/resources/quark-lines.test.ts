import { describe, expect, it } from 'vitest';
import { quarkLine } from '@/domain/resources/quark-lines';
import type { Source } from '@/domain/media/media';
const source = (ext: unknown, api = 'csp_WoGG'): Source => ({ key: 'a', name: '网盘', api, type: 3, searchable: 0, enabled: false, ext });
describe('cloud line capabilities', () => {
  it('supports disabled WoGG sources and site arrays without enabling them', () => {
    const input = source({ siteUrl: ['https://www.wogg.net/', 'http://insecure.test', 'https://user:pass@bad.test'] });
    expect(quarkLine(input).sites).toEqual(['https://www.wogg.net/']);
    expect(input.enabled).toBe(false);
    expect(quarkLine(source('{"site":"https://example.com"}')).sites).toEqual(['https://example.com']);
  });
  it('adapts the enabled WoGGGuard line without an explicit site', () => {
    expect(quarkLine(source({ 'Cloud-drive': 'tvfan/Cloud-drive.txt' }, 'csp_WoGGGuard')).sites).toEqual(['https://www.wogg.net/']);
  });
  it('does not pretend arbitrary Android jars or token URLs are executable sites', () => {
    expect(quarkLine(source('https://example.com/token.json')).sites).toEqual([]);
    expect(quarkLine(source({ site: 'https://example.com' }, 'csp_Other')).sites).toEqual([]);
  });
});

