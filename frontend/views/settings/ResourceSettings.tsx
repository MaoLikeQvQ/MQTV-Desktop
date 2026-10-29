import { useOperationMessage } from '@/views/shared/components/OperationMessage';
import { useRef, useState } from 'react';
import { Button, TextField, Select, MenuItem, Switch, CircularProgress } from '@mui/material';
import RefreshIcon from '@mui/icons-material/RefreshRounded';
import { buildRequestUrl } from '@/utils/url';
import { inspectCustomResource } from '@/services/resources';
import { supportedSourceCount, type ValidatedResource } from '@/domain/resources/custom-feed';
import type { CustomResource } from '@/domain/resources/custom-resources';
/** 展示默认或自定义订阅配置，提供默认资源刷新及自定义订阅管理操作。 */
export function ResourceSettings({mode,busy,entries,onMode,onChange,onRefresh}: {
  mode:'default'|'custom';busy:boolean;count?:number;updatedAt?:number;entries:CustomResource[];
  onMode:(mode:'default'|'custom')=>Promise<boolean>;
  onRefresh:()=>Promise<boolean>;
  onChange:(entries:CustomResource[], validated?:ValidatedResource)=>Promise<void>;
}) {
  const [draft,setDraft]=useState('');
  const [editing,setEditing]=useState('');
  const [filter,setFilter]=useState('');
  const [parsing,setParsing]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const notify = useOperationMessage();
  const saveLock=useRef(false);
  const blocked=busy||parsing||refreshing;
  /** 主动获取最新默认资源；请求期间锁定操作，结果由应用统一提示。 */
  async function refreshDefault() {
    if (mode !== 'default' || blocked || saveLock.current) return;
    saveLock.current=true;setRefreshing(true);
    try { await onRefresh(); }
    finally { saveLock.current=false;setRefreshing(false); }
  }
  /** 先请求并统一订阅，校验成功后才提交配置；失败保留输入和原有订阅列表。 */
  async function save() {
    if (saveLock.current || blocked) return;
    let value:string;
    try {value=buildRequestUrl(draft.trim());}
    catch {notify('请输入有效的 HTTP(S) 资源地址', 'error');return;}
    if(entries.some(item=>item.url===value && item.id!==editing)) {notify('此地址已存在', 'error');return;}
    saveLock.current=true;setParsing(true);

    try {
      const validated=await inspectCustomResource(value);
      const entry={id:editing||crypto.randomUUID(),url:validated.url,enabled:true};
      const next=editing?entries.map(item=>item.id===editing?entry:item):[...entries,entry];
      await onChange(next,validated);
      const supported=supportedSourceCount(validated.feed);
      setDraft('');setEditing('');
      notify(`已添加 ${validated.feed.count} 个来源，当前支持搜索 ${supported} 个。`+
        (supported===0?' 当前没有可参与搜索的来源，请检查来源搜索开关或所需执行环境。':' 来源连通性和播放结果以实际使用为准。'), 'success');
    } catch(reason) {
      notify('未保存本次资源：'+(reason instanceof Error?reason.message:String(reason)), 'error');
    } finally {saveLock.current=false;setParsing(false);}
  }
  /** 锁定订阅删除或启用操作，等待请求及保存完成后才反馈结果并恢复交互。 */
  async function changeEntries(next: CustomResource[]) {
    if (blocked || saveLock.current) return;
    saveLock.current = true; setParsing(true);
    try { await onChange(next); notify('资源配置已保存。', 'success'); }
    catch (reason) { notify('保存资源失败：' + String(reason), 'error'); }
    finally { saveLock.current = false; setParsing(false); }
  }
  const shown=entries.filter(item=>item.url.toLowerCase().includes(filter.toLowerCase()));
  return <div className="resource-settings" role="tabpanel" id="settings-content" aria-labelledby="settings-resources">
    <div className="resource-setting-row"><span id="resource-mode-label">影片资源地址</span><div className="resource-setting-actions"><Select size="small" value={mode} disabled={blocked} labelId="resource-mode-label" onChange={event=>void onMode(event.target.value as 'default'|'custom')}><MenuItem value="default">默认</MenuItem><MenuItem value="custom">自定义</MenuItem></Select>{mode==='default'&&<Button size="small" disabled={blocked} startIcon={refreshing?<CircularProgress size={16} color="inherit"/>:<RefreshIcon/>} onClick={()=>void refreshDefault()}>{refreshing?'刷新中…':'刷新资源'}</Button>}</div></div>
    {mode==='custom'&&<div className="custom-resources">
      <form className="resource-entry-form" onSubmit={event=>{event.preventDefault();void save();}}><TextField size="small" placeholder="添加资源地址" slotProps={{htmlInput:{'aria-label':'资源地址'}}} value={draft} onChange={event=>setDraft(event.target.value)} fullWidth disabled={blocked}/><Button size="small" type="submit" disabled={blocked||!draft.trim()}>{parsing?'正在解析…':editing?'保存':'添加'}</Button>{editing&&<Button size="small" disabled={blocked} onClick={()=>{setEditing('');setDraft('');}}>取消</Button>}</form>
      {entries.length>3&&<TextField size="small" placeholder="查找资源地址" slotProps={{htmlInput:{'aria-label':'查找资源地址'}}} value={filter} onChange={event=>setFilter(event.target.value)}/>}
      <ul className="resource-entry-list">{shown.map(item=><li key={item.id}><div className="resource-entry-main"><span className="resource-entry-url" title={item.url}>{item.url}</span><span className="resource-entry-count">{item.enabled&&item.count!=null?item.count+' 个来源 · 支持 '+(item.supportedCount??'待检查')+' 个':''}</span><Button size="small" disabled={blocked} onClick={()=>{setEditing(item.id);setDraft(item.url);}}>编辑</Button><Button size="small" color="inherit" disabled={blocked} onClick={()=>{if(editing===item.id){setEditing('');setDraft('');}void changeEntries(entries.filter(v=>v.id!==item.id));}}>删除</Button><Switch size="small" checked={item.enabled} disabled={blocked} slotProps={{input:{'aria-label':'启用 '+item.url}}} onChange={(_,enabled)=>void changeEntries(entries.map(v=>v.id===item.id?{...v,enabled}:v))}/></div>{item.error&&<p className="resource-entry-error">已停用：{item.error}</p>}</li>)}</ul>
      {!entries.length&&<p className="resource-setting-note">添加时先获取并解析资源，成功后保存；启用订阅中受支持的来源共同参与搜索。</p>}
      {!!entries.length&&!shown.length&&<p className="resource-setting-note">没有匹配的资源地址</p>}
    </div>}

  </div>;
}
