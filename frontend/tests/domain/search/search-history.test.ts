import { describe, expect, it } from 'vitest';
import { normalizeSearchHistory, readSearchHistory, rememberSearch } from '@/domain/search/search-history';

describe('搜索历史', () => {
  it('保留最新十条，重复搜索移到最前面', () => {
    const history = Array.from({ length: 10 }, (_, i) => '影片' + i);
    expect(rememberSearch(history, ' 影片5 ')).toEqual(['影片5', ...history.filter(term => term !== '影片5')]);
    expect(rememberSearch(history, '新影片')).toEqual(['新影片', ...history.slice(0, 9)]);
  });
  it('过滤空白和非法值，不把空提交加入历史', () => {
    expect(normalizeSearchHistory([' A ', '', null, 2, 'A', ' B'])).toEqual(['A', 'B']);
    expect(rememberSearch(['A'], ' ')).toEqual(['A']);
  });
  it('恢复已保存数据并处理损坏 JSON', () => {
    expect(readSearchHistory({ getItem: () => 'not-json' })).toEqual([]);
    expect(readSearchHistory({ getItem: () => '[" A ","A","B"]' })).toEqual(['A', 'B']);
  });
});
