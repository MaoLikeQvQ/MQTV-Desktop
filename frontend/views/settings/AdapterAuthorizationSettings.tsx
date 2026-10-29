import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { useRef, useState } from 'react';
import { Button, TextField } from '@mui/material';
import type { Feed } from '@/domain/media/media';
import { nativeAdapter } from '@/domain/resources/native-source';
import { authorizeNativeAdapter, type AdapterAuthorization } from '@/api/adapters';

/** 接收外部授权 JSON，注入指定来源的原生会话，不写浏览器存储。 */
export function AdapterAuthorizationSettings({ feed, disabled }: { feed: Feed | null; disabled: boolean }) {
  const sources = feed?.sites.filter(source => nativeAdapter(source) && source.enabled !== false) ?? [];
  const [selected, setSelected] = useState('');
  const [input, setInput] = useState('');
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const source = sources.find(item => item.key === selected);
  /** 校验 JSON 的允许字段后注入或撤销会话授权，成功立即清除敏感输入。 */
  async function save(revoke = false) {
    if (!source || disabled || lock.current) return;
    lock.current = true;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      let value: AdapterAuthorization | null = null;
      if (!revoke) {
        let parsed: unknown;
        try { parsed = JSON.parse(input); } catch { throw new Error('授权内容不是有效 JSON'); }
        const keys = ['token', 'cookie', 'deviceId', 'version', 'userAgent'];
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).some(([key, value]) => !keys.includes(key) || typeof value !== 'string')) throw new Error('仅支持字符串字段 token、cookie、deviceId、version、userAgent');
        value = parsed as AdapterAuthorization;
      }
      await authorizeNativeAdapter(source, value);
      setInput(''); setMessage(revoke ? '已清除该来源的会话授权。' : '已应用到本次会话；退出应用后需重新提供。');
    } catch (reason) { setFailed(true); setMessage(String(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!sources.length) return null;
  return <section aria-label="线路外部授权"><h2>线路外部授权</h2>
    <p>公开来源无需填写。外部账号信息仅保存在原生进程内存，夸克继续使用上方授权管理。</p>
    <TextField select fullWidth label="来源" value={source ? selected : ''} disabled={disabled || busy} onChange={event => { setSelected(event.target.value); setInput(''); setMessage(''); }} slotProps={{ select: { native: true } }}>
      <option value="">请选择来源</option>{sources.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
    </TextField>
    {source && <><TextField fullWidth multiline minRows={4} label="外部授权 JSON" value={input} autoComplete="off" disabled={disabled || busy} onChange={event => setInput(event.target.value)} helperText="可包含 token、cookie、deviceId、version、userAgent，不写入订阅或播放历史。" />
      <Button disabled={disabled || busy || !input.trim()} onClick={() => void save()}>应用到本次会话</Button><Button disabled={disabled || busy} onClick={() => void save(true)}>清除会话授权</Button></>}
    {message && <OperationMessage severity={failed ? 'error' : 'success'}>{message}</OperationMessage>}
  </section>;
}
