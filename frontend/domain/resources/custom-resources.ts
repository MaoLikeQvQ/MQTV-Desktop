import { buildRequestUrl } from '@/utils/url';
import type { Feed } from '@/domain/media/media';
import { normalizeCustomFeed, supportedSourceCount, type ValidatedResource } from '@/domain/resources/custom-feed';
export type CustomResource = { id: string; url: string; enabled: boolean; error?: string; count?: number; supportedCount?: number };
/** 读取自定义订阅列表并兼容迁移旧单地址配置，异常或缺失时返回空列表。 */
export function readCustomResources(storage: Pick<Storage,'getItem'>): CustomResource[] {
  try {
    const value=JSON.parse(storage.getItem('mqtv-custom-resources') || 'null');
    if(Array.isArray(value)) return value.filter(v=>typeof v?.id==='string' && typeof v?.url==='string').map(v=>({...v,enabled:v.enabled!==false}));
    const legacy=storage.getItem('mqtv-custom-feed-url');
    return legacy ? [{id:crypto.randomUUID(),url:legacy,enabled:true}] : [];
  } catch {return [];}
}
/** 将自定义订阅配置列表序列化保存到本机，不发起资源请求。 */
export function saveCustomResources(storage: Pick<Storage,'setItem'>, entries: CustomResource[]) {
  storage.setItem('mqtv-custom-resources',JSON.stringify(entries));
}
/**
 * 加载启用的订阅并合并资源，失败项单独标记停用，不影响其他订阅。
 * @param entries 用户配置的订阅列表。
 * @param fetcher 获取订阅原始响应的请求函数。
 * @param validated 添加时已校验的响应，合并时直接复用，避免对新地址重复请求。
 * @returns 更新后的订阅状态与保留来源信息的合并资源。
 */
export async function resolveCustomResources(entries: CustomResource[], fetcher:(url:string)=>Promise<unknown>, validated?: ValidatedResource) {
  const results=await Promise.all(entries.map(async entry=>{
    if(!entry.enabled) return {entry};
    try {
      const url=buildRequestUrl(entry.url,{});
      const feed=validated?.url === url ? validated.feed : normalizeCustomFeed(await fetcher(url), url);
      return {entry:{...entry,url,enabled:true,error:undefined,count:feed.count,supportedCount:supportedSourceCount(feed)},feed};
    } catch(e) {return {entry:{...entry,enabled:false,error:String(e instanceof Error?e.message:e),count:undefined,supportedCount:undefined}};}
  }));
  const sites=results.flatMap(({entry,feed})=>feed?feed.sites.map(source=>({...source,key:entry.id+':'+source.key,resourceUrl:entry.url,originalKey:source.originalKey ?? source.key})):[]);
  const subscriptions=results.flatMap(({entry,feed})=>{
    if(!feed) return [];
    const {sites: _sites,...config}=feed;
    return [{id:entry.id,url:entry.url,config}];
  });
  return {entries:results.map(r=>r.entry),feed:{version:'custom',count:sites.length,sites,subscriptions} as Feed};
}
