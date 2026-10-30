import { expect, it } from 'vitest';
import { normalizeSearchKeyword } from '@/domain/search/search-keyword';

it('removes spaces throughout a query, including full-width and Unicode separators', () => {
  expect(normalizeSearchKeyword('  浪浪山 \t小\u3000妖\n怪\u00a0\u2003')).toBe('浪浪山小妖怪');
  expect(normalizeSearchKeyword('Spider Man 2')).toBe('SpiderMan2');
});

it('preserves non-whitespace title characters and rejects whitespace-only input', () => {
  expect(normalizeSearchKeyword('Re:从零开始（第2季）')).toBe('Re:从零开始（第2季）');
  expect(normalizeSearchKeyword(' \t\n\u3000')).toBe('');
});
