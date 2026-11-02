import { buildRequestUrl, serviceOrigin } from '@/utils/url';

// Vite replaces these public values at build time; native builds read the same env files.
export const BACKEND_URL = serviceOrigin(import.meta.env.VITE_API_BASE_URL, 'VITE_API_BASE_URL');
export const DOUBAN_URL = serviceOrigin(import.meta.env.VITE_DOUBAN_BASE_URL, 'VITE_DOUBAN_BASE_URL');
export const BANGUMI_URL = serviceOrigin(import.meta.env.VITE_BANGUMI_BASE_URL, 'VITE_BANGUMI_BASE_URL');
export const DEFAULT_RESOURCE_URL = buildRequestUrl('/api/resources', {}, BACKEND_URL);

// 桌面更新固定从项目的公开 GitHub Releases 获取，不携带本机设备或账号信息。
export const DESKTOP_RELEASES_URL = 'https://github.com/MaoLikeQvQ/MQTV-Desktop/releases';
export const DESKTOP_UPDATE_URL = DESKTOP_RELEASES_URL + '/latest/download/desktop-update.json';
