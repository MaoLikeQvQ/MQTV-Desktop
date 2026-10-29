import { buildRequestUrl, serviceOrigin } from '@/utils/url';

// Vite replaces these public values at build time; native builds read the same env files.
export const BACKEND_URL = serviceOrigin(import.meta.env.VITE_API_BASE_URL, 'VITE_API_BASE_URL');
export const DOUBAN_URL = serviceOrigin(import.meta.env.VITE_DOUBAN_BASE_URL, 'VITE_DOUBAN_BASE_URL');
export const BANGUMI_URL = serviceOrigin(import.meta.env.VITE_BANGUMI_BASE_URL, 'VITE_BANGUMI_BASE_URL');
export const DEFAULT_RESOURCE_URL = buildRequestUrl('/api/resources', {}, BACKEND_URL);
