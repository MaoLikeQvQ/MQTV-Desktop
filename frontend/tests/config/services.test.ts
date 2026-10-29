import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it('reads service origins from environment overrides without changing source code', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://backend.example.test:8088/');
  vi.stubEnv('VITE_DOUBAN_BASE_URL', 'https://douban.example.test');
  vi.stubEnv('VITE_BANGUMI_BASE_URL', 'https://bangumi.example.test');
  vi.resetModules();
  const config = await import('@/config/services');
  expect(config.BACKEND_URL).toBe('http://backend.example.test:8088');
  expect(config.DEFAULT_RESOURCE_URL).toBe('http://backend.example.test:8088/api/resources');
  const { discoveryContent, animeSources } = await import('@/api/discovery');
  expect(new URL(discoveryContent('movie', '热门').key).origin).toBe(config.DOUBAN_URL);
  expect(new URL(animeSources.china.key).origin).toBe('https://douban.example.test');
  expect(Object.keys(animeSources)).toEqual(['japan', 'china']);
});
it('reports invalid configured domains instead of falling back to production', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://backend.example.test/api?token=1');
  vi.resetModules();
  await expect(import('@/config/services')).rejects.toThrow('VITE_API_BASE_URL');
});
