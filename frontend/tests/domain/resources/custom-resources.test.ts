import { describe,expect,it,vi } from 'vitest';
import { parseFeed } from '@/domain/media/media';
import { resolveCustomResources,readCustomResources } from '@/domain/resources/custom-resources';
const feed={version:'v1',count:1,sites:[{key:'same',name:'A',api:'https://example.com/api',type:1,searchable:1}]};
describe('custom resource subscriptions',()=>{
  it('aggregates standard and TVBox addresses into the default Feed contract',async()=>{
    const result=await resolveCustomResources([
      {id:'standard',url:'https://standard.test/feed.json',enabled:true},
      {id:'tvbox',url:'https://tvbox.test/config.json',enabled:true},
    ],async url=>url.includes('standard.test')?feed:{sites:[
      {key:'same',name:'B',api:'https://tvbox.test/api',type:1},
      {key:'cloud',name:'网盘',api:'csp_WoGGGuard',type:3},
    ]});
    const parsed=parseFeed(JSON.parse(JSON.stringify(result.feed)));
    expect(parsed).toEqual(result.feed);
    expect(parsed).toMatchObject({version:'custom',count:3});
    expect(parsed.sites.map(source=>[source.key,source.name,source.searchable])).toEqual([
      ['standard:same','A',1],['tvbox:same','B',1],['tvbox:cloud','网盘',1],
    ]);
    expect(parsed.sites.map(source=>source.resourceUrl)).toEqual([
      'https://standard.test/feed.json','https://tvbox.test/config.json','https://tvbox.test/config.json',
    ]);
  });
  it('requests all enabled addresses, isolates failures and merges healthy feeds without key collisions',async()=>{
    const fetcher=vi.fn(async(url:string)=>{if(url.includes('broken')) throw Error('HTTP 502');return feed;});
    const result=await resolveCustomResources([
      {id:'a',url:'https://one.test/',enabled:true},
      {id:'b',url:'https://two.test/',enabled:true},
      {id:'c',url:'https://broken.test/',enabled:true},
      {id:'d',url:'https://disabled.test/',enabled:false},
    ],fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.feed.sites.map(s=>s.key)).toEqual(['a:same','b:same']);
    expect(result.entries[2]).toMatchObject({enabled:false,error:'HTTP 502'});
    expect(result.entries[3].enabled).toBe(false);
  });
  it('stores invalid addresses and invalid feeds as visible disabled entries',async()=>{
    const result=await resolveCustomResources([{id:'a',url:'not a url',enabled:true},{id:'b',url:'https://bad.test/',enabled:true}],async()=>({}));
    expect(result.feed.count).toBe(0);
    expect(result.entries.every(e=>!e.enabled&&!!e.error)).toBe(true);
  });
  it('allows a fixed or retried entry to recover and migrates previously saved entries as enabled',async()=>{
    const result=await resolveCustomResources([{id:'a',url:'https://fixed.test/',enabled:true,error:'offline'}],async()=>feed);
    expect(result.entries[0]).toMatchObject({enabled:true,error:undefined,count:1});
    expect(readCustomResources({getItem:()=>JSON.stringify([{id:'old',url:'https://old.test/'}])})[0].enabled).toBe(true);
  });
});
