import { invoke } from '@tauri-apps/api/core';
import { DOUBAN_URL } from '@/config/services';
import { requestJson } from '@/utils/request';
import { buildRequestUrl } from '@/utils/url';
import type { Channel } from '@/router';

/** 构造豆瓣分类请求；海外分类分别读取各地区，原始响应交由业务层合并。 */
export function discoveryContent(channel: Channel, filter: string, page = 0) {
  if (channel === 'recommended' && filter === 'douban_movie_weekly') {
    const key = buildRequestUrl('/chart', {}, DOUBAN_URL);
    return { key, requests: [{ key,
      /** 通过原生层读取并解析豆瓣一周口碑榜网页，返回原始影片列表。 */
      load: () => invoke<unknown>('douban_weekly', { url: key }),
    }] };
  }
  let urls: string[];
  if (channel === 'recommended' && ['douban_tv_global', 'douban_show_global'].includes(filter)) {
    const tags = filter === 'douban_tv_global' ? '电视剧' : '综艺';
    urls = ['美国', '英国', '日本', '韩国'].map(countries => buildRequestUrl('/j/new_search_subjects', {
      tags, countries, sort: 'U', range: '0,10', start: page * 20,
    }, DOUBAN_URL));
  } else if ((channel === 'recommended' && filter === 'douban_show_chinese') || channel === 'variety') {
    urls = [buildRequestUrl('/j/new_search_subjects', {
      tags: channel === 'recommended' ? '综艺,中国大陆' : '综艺', sort: 'U', range: '0,10', start: page * 20,
    }, DOUBAN_URL)];
  } else {
    const movie = channel === 'movie';
    urls = [buildRequestUrl('/j/search_subjects', {
      type: movie ? 'movie' : 'tv', tag: channel === 'recommended' ? movie ? '热门' : '国产剧' : filter === '最新' ? '热门' : filter,
      sort: filter === '最新' ? 'time' : 'recommend', page_limit: 30, page_start: page * 30,
    }, DOUBAN_URL)];
  }
  return {
    key: urls.length === 1 ? urls[0] : JSON.stringify(urls),
    requests: urls.map(url => ({
      key: url,
      /** 请求单个地区的原始豆瓣列表，调用顺序由业务层决定。 */
      load: () => requestJson(url),
    })),
  };
}

/** 根据动漫地区生成豆瓣请求地址，统一编码地区标签和分页参数。 */
export function animeListUrl(region: 'japan' | 'china', page = 0): string {
  return region === 'china'
    ? buildRequestUrl('/j/new_search_subjects', { sort: 'U', range: '0,10', tags: '中国大陆,动画', start: page * 20 }, DOUBAN_URL)
    : buildRequestUrl('/j/search_subjects', { type: 'tv', tag: '日本动画', sort: 'recommend', page_limit: '24', page_start: page * 24 }, DOUBAN_URL);
}
/** 创建指定地区动漫列表的请求描述，加载时返回接口原始响应。 */
export function animeList(region: 'japan' | 'china', page = 0) {
  const key = animeListUrl(region, page);
  return {
    key,
    /** 请求指定地区动漫的原始列表，数据解析由业务层执行。 */
    load: () => requestJson(key),
  };
}
export const animeSources = {
  japan: animeList('japan'),
  china: animeList('china'),
};

/** 查询豆瓣影片候选的原始数据，业务层按榜单 ID 精确匹配封面。 */
export function weeklyCoverCandidates(title: string): Promise<unknown> {
  return requestJson(buildRequestUrl('/j/subject_suggest', { q: title }, DOUBAN_URL));
}
