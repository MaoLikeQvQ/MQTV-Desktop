import { describe, expect, it, vi } from 'vitest';
import { normalizeCustomFeed, canSearchCustomSource, supportedSourceCount, validateCustomResource } from '@/domain/resources/custom-feed';
import { resolveCustomResources } from '@/domain/resources/custom-resources';

const address='https://example.com/dm/dm.json';
const cms={key:'cms',name:'采集源',api:'https://example.com/api',type:1};
describe('custom feed normalization and validation',()=>{
  it('allows adapted default CMS and WoGG sources while respecting disabled and unsupported plugins', () => {
    const source = { ...cms, searchable: 1 };
    expect(canSearchCustomSource(source)).toBe(true);
    expect(canSearchCustomSource({ ...source, type: 3, api: 'csp_WoGGGuard' })).toBe(true);
    expect(canSearchCustomSource({ ...source, searchable: 0 })).toBe(false);
    expect(canSearchCustomSource({ ...source, type: 3, api: 'csp_AndroidOnly' })).toBe(false);
    expect(canSearchCustomSource({ ...source, api: 'https://example.com/rule.js' })).toBe(false);
  });
  it('normalizes standard responses and TVBox configs to the same Feed contract',()=>{
    const sites=[{...cms,searchable:1}];
    const standard=normalizeCustomFeed({version:'v1',count:1,sites},address);
    const tvbox=normalizeCustomFeed({sites:[cms]},address);
    expect(tvbox.sites).toEqual(standard.sites);
    expect(tvbox).toMatchObject({version:'tvbox',count:1});
    expect(supportedSourceCount(tvbox)).toBe(1);
  });
  it('resolves rule paths, preserves metadata and isolates duplicate keys',()=>{
    const feed=normalizeCustomFeed({spider:'./jar/fan.jar',parses:[{name:'解析'}],sites:[
      {...cms,key:'same',type:3,api:'./js/drpy.min.js',ext:'../rules/a.js'},
      {...cms,key:'same',type:3,api:'csp_Anime1',ext:{site:'https://example.com'}},
      {...cms,key:'same#2'},
    ]},address);
    expect(new Set(feed.sites.map(s=>s.key)).size).toBe(3);
    expect(feed.sites[0]).toMatchObject({api:'https://example.com/dm/js/drpy.min.js',ext:'https://example.com/rules/a.js',originalKey:'same',searchable:1});
    expect(feed.sites[1].api).toBe('csp_Anime1');
    expect(feed).toMatchObject({spider:'https://example.com/dm/jar/fan.jar',parses:[{name:'解析'}]});
    expect(supportedSourceCount(feed)).toBe(2);
  });
  it('does not treat JavaScript URLs, Android plugins, XML sources or disabled search as callable CMS',()=>{
    const feed=normalizeCustomFeed({sites:[
      {...cms,type:3,api:'https://example.com/drpy.js'},
      {...cms,key:'jar',type:3,api:'csp_Anime1'},
      {...cms,key:'xml',type:0}, {...cms,key:'off',searchable:0},
      {...cms,key:'quark',type:3,api:'csp_WoGGGuard'},
    ]},address);
    expect(supportedSourceCount(feed)).toBe(2);
  });
  it('rejects empty, unrelated and malformed responses before accepting an address',async()=>{
    for(const raw of [{},[],{sites:[]},{sites:[{}]},{version:7,sites:[cms]},{count:2,sites:[cms]}]){
      await expect(validateCustomResource(address,async()=>raw)).rejects.toThrow();
    }
    const fetcher=vi.fn();
    await expect(validateCustomResource('not a url',fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(validateCustomResource(address,async()=>{throw Error('HTTP 503');})).rejects.toThrow('HTTP 503');
  });
  it('reuses the validated response on addition and keeps multiple subscriptions isolated',async()=>{
    const fetcher=vi.fn(async()=>({spider:'./fan.jar',sites:[cms]}));
    const validated=await validateCustomResource(' '+address+' ',fetcher);
    const result=await resolveCustomResources([
      {id:'one',url:address,enabled:true},
      {id:'two',url:'https://another.test/config.json',enabled:true},
    ],fetcher,validated);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.feed.count).toBe(2);
    expect(result.feed.sites.map(s=>s.key)).toEqual(['one:cms','two:cms']);
    expect(result.feed.sites.map(s=>s.resourceUrl)).toEqual([address,'https://another.test/config.json']);
    expect(result.entries.map(e=>e.supportedCount)).toEqual([1,1]);
    expect(result.feed.subscriptions?.map(s=>s.config.spider)).toEqual(['https://example.com/dm/fan.jar','https://another.test/fan.jar']);
  });
});
