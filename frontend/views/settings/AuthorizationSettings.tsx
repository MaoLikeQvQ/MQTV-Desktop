import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import RefreshIcon from '@mui/icons-material/Refresh';
import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '@/platform/desktop';
import { refreshNetdiskAuthorizations, type AuthorizationRefreshResult } from '@/services/authorization-refresh';
import { readQuarkSettings, createQuarkLogin, pollQuarkLogin, cancelQuarkLogin, type QuarkAccount as Account, type QuarkLoginSession as LoginSession } from '@/api/quark';
import { readUcSettings, createUcLogin, pollUcLogin, cancelUcLogin } from '@/api/uc';
import { IconButton, Button, CircularProgress, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';

const providers = {
  quark: { name: '夸克', title: 'K-K授权', icon: '夸', read: readQuarkSettings, create: createQuarkLogin, poll: pollQuarkLogin, cancel: cancelQuarkLogin },
  uc: { name: 'UC', title: 'U-C授权', icon: 'UC', read: readUcSettings, create: createUcLogin, poll: pollUcLogin, cancel: cancelUcLogin },
};

/** 分别展示夸克与 UC 授权入口；两类账号和扫码会话由原生层独立保存。 */
export function NetdiskSettings() {
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quarkBusy, setQuarkBusy] = useState(false);
  const [ucBusy, setUcBusy] = useState(false);
  const [results, setResults] = useState<Partial<Record<keyof typeof providers, AuthorizationRefreshResult>>>({});
  /** 用户点击时分别向后台刷新；任一失败仍更新另一张卡片，忙碌期间拒绝重复点击。 */
  async function refreshAuthorization(): Promise<void> {
    if (refreshLock.current || quarkBusy || ucBusy) return;
    refreshLock.current = true; setRefreshing(true);
    try { setResults(await refreshNetdiskAuthorizations()); }
    finally { refreshLock.current = false; setRefreshing(false); }
  }
  return <div role="tabpanel" id="settings-content" aria-labelledby="settings-authorizations">
    <div className="authorization-toolbar"><h2>权限信息</h2><IconButton aria-label="刷新授权" title="刷新授权" disabled={!isDesktop() || refreshing || quarkBusy || ucBusy} onClick={() => void refreshAuthorization()}>{refreshing ? <CircularProgress size={20} color="inherit" /> : <RefreshIcon />}</IconButton></div>
    <ProviderAuthorization provider="quark" refreshBusy={refreshing} refreshResult={results.quark} onBusy={setQuarkBusy} />
    <ProviderAuthorization provider="uc" refreshBusy={refreshing} refreshResult={results.uc} onBusy={setUcBusy} />
  </div>;
}

/** 保留原授权设置组件入口，显示当前已支持的网盘。 */
export const QuarkSettings = NetdiskSettings;

/** 协调指定网盘的状态、扫码登录；失败或取消继续保留其原账号。 */
function ProviderAuthorization({ provider, refreshBusy, refreshResult, onBusy }: { provider: keyof typeof providers; refreshBusy: boolean; refreshResult?: AuthorizationRefreshResult; onBusy: (busy: boolean) => void }) {
  const api = providers[provider];
  const notify = useOperationMessage();
  const qrLock = useRef(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<LoginSession>();
  const [error, setError] = useState('');
  const [state, setState] = useState('waiting');
  const [attempt, setAttempt] = useState(0);
  /** 读取原生授权状态并更新授权卡片。 */
  const refresh = () => api.read().then(setAccount);
  useEffect(() => { if (isDesktop()) refresh().then(() => setError('')).catch(e => setError(String(e))); }, [api]);
  useEffect(() => { onBusy(open || qrBusy); }, [open, qrBusy, onBusy]);
  useEffect(() => {
    if (!refreshResult) return;
    if (refreshResult.account) setAccount(refreshResult.account);
    setError(refreshResult.error || '');
  }, [refreshResult]);
  useEffect(() => {
    if (!open) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>; let id: string | undefined;
    qrLock.current = true; setQrBusy(true);
    setSession(undefined); setError(''); setState('waiting');
    /** 轮询当前扫码会话，完成或过期后停止；弹窗关闭后忽略响应。 */
    async function poll() {
      qrLock.current = true; setQrBusy(true);
      try {
        const result = await api.poll(id);
        if (disposed) return;
        setState(result.state); setError('');
        if (result.state === 'verified') { await refresh(); if (!disposed) notify('授权成功，已保存到本机', 'success'); return; }
        if (result.state === 'expired') { notify('二维码已过期，请重新生成', 'warning'); return; }
      } catch(e) { if (disposed) return; setError(String(e)); }
      finally { if (!disposed) { qrLock.current = false; setQrBusy(false); } }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    }
    void api.create().then(result => {
      id=result.id;
      if (disposed) { void api.cancel(id).catch(()=>{}); return; }
      setSession(result); timer=setTimeout(() => void poll(),3000);
    }).catch(e => {if(!disposed)setError(String(e));}).finally(() => { if (!disposed) { qrLock.current = false; setQrBusy(false); } });
    return () => {disposed=true;clearTimeout(timer);if(id)void api.cancel(id).catch(()=>{});};
  }, [open, attempt, api]);
  const qr = session ? qrcode(0,'M') : undefined;
  if (qr && session) { qr.addData(session.scanUrl); qr.make(); }
  return <>
    <div className="authorization-row">
      <button className="authorization-info" disabled={!isDesktop() || refreshBusy} onClick={()=>setOpen(true)}>
        <span className="authorization-copy"><strong>{api.title}</strong>{account?.name && <small>{account.name}</small>}</span>
        <span className={account?.cached?'authorization-status connected':'authorization-status'}>{account?.cached?'已授权':'待授权'}</span>
      </button>
    </div>
    {error && <OperationMessage severity="error">{error}</OperationMessage>}
    {refreshResult && !error && <OperationMessage severity="success">{refreshResult.message}</OperationMessage>}
    <Dialog open={open} onClose={()=>setOpen(false)} fullWidth maxWidth="xs"><DialogTitle>{api.title}</DialogTitle><DialogContent>
      <div className="authorization-qr">{state==='verified' ? <span>已授权</span> : state==='expired' ? <span>二维码已过期</span> : qr ? <img src={qr.createDataURL(6,24)} width="220" height="220" alt={`${api.name}网盘登录二维码`} /> : !error && <CircularProgress />}</div>

    </DialogContent><DialogActions>{state!=='verified' && <Button disabled={qrBusy} onClick={()=>{if(qrLock.current)return;qrLock.current=true;setQrBusy(true);setAttempt(value=>value+1);}}>{qrBusy?'请求中…':'重新生成'}</Button>}<Button onClick={()=>setOpen(false)}>{state==='verified'?'完成':'关闭'}</Button></DialogActions></Dialog>
  </>;
}

