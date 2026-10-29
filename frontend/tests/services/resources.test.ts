import { describe, expect, it } from 'vitest';
import { persistCustomResourceState } from '@/services/resources';

describe('custom resource persistence',()=>{
  it('saves the subscription list, aggregated feed and custom mode together',()=>{
    const values=new Map<string,string>();
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
    const result={entries:[{id:'a',url:'https://example.com/',enabled:true}],feed:{version:'custom',count:0,sites:[]}};
    persistCustomResourceState(storage,result);
    expect(JSON.parse(values.get('mqtv-custom-resources')!)).toEqual(result.entries);
    expect(JSON.parse(values.get('mqtv-feed')!)).toEqual(result.feed);
    expect(values.get('mqtv-resource-mode')).toBe('custom');
  });
  it('restores the original list and cache if a later storage write fails',()=>{
    const values=new Map([['mqtv-custom-resources','original'],['mqtv-feed','old feed']]);
    const before=new Map(values);
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{
      if(key==='mqtv-resource-mode') throw Error('QuotaExceededError');values.set(key,value);
    },removeItem:(key:string)=>{values.delete(key);}};
    expect(()=>persistCustomResourceState(storage,{entries:[],feed:{version:'custom',count:0,sites:[]}})).toThrow('QuotaExceededError');
    expect(values).toEqual(before);
  });
});
