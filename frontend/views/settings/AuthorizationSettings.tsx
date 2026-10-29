import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '@/platform/desktop';
import { readQuarkSettings, createQuarkLogin, pollQuarkLogin, cancelQuarkLogin, authorizeQuarkCode, type QuarkAccount as Account, type QuarkLoginSession as LoginSession } from '@/api/quark';
import { Button, CircularProgress, TextField, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';

/** 展示本机夸克授权状态，协调扫码会话和内测授权码弹窗。 */
export function QuarkSettings() {
  const notify = useOperationMessage();
  const codeLock = useRef(false);
  const qrLock = useRef(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [codeOpen,setCodeOpen]=useState(false);
  const [code,setCode]=useState('');
  const [codeBusy,setCodeBusy]=useState(false);
  const [codeError,setCodeError]=useState('');
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<LoginSession>();
  const [error, setError] = useState('');
  const [state, setState] = useState('waiting');
  const [attempt, setAttempt] = useState(0);
  /** 读取原生授权状态并更新授权卡片。 */
  const refresh = () => readQuarkSettings().then(setAccount);
  useEffect(() => { if (isDesktop()) refresh().catch(e => setError(String(e))); }, []);
  useEffect(() => {
    if (!open) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>; let id: string | undefined;
    qrLock.current = true; setQrBusy(true);
    setSession(undefined); setError(''); setState('waiting');
    /** 轮询当前扫码会话，完成或过期后停止；弹窗关闭后忽略响应。 */
    async function poll() {
      qrLock.current = true; setQrBusy(true);
      try {
        const result = await pollQuarkLogin(id);
        if (disposed) return;
        setState(result.state); setError('');
        if (result.state === 'verified') { await refresh(); if (!disposed) notify('授权成功，已保存到本机', 'success'); return; }
        if (result.state === 'expired') { notify('二维码已过期，请重新生成', 'warning'); return; }
      } catch(e) { if (disposed) return; setError(String(e)); }
      finally { if (!disposed) { qrLock.current = false; setQrBusy(false); } }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    }
    void createQuarkLogin().then(result => {
      id=result.id;
      if (disposed) { void cancelQuarkLogin(id).catch(()=>{}); return; }
      setSession(result); timer=setTimeout(() => void poll(),3000);
    }).catch(e => {if(!disposed)setError(String(e));}).finally(() => { if (!disposed) { qrLock.current = false; setQrBusy(false); } });
    return () => {disposed=true;clearTimeout(timer);if(id)void cancelQuarkLogin(id).catch(()=>{});};
  }, [open, attempt]);
  const qr = session ? qrcode(0,'M') : undefined;
  if (qr && session) { qr.addData(session.scanUrl); qr.make(); }
  return <div role="tabpanel" id="settings-content" aria-labelledby="settings-authorizations">
    <button className="authorization-row" disabled={!isDesktop()} onClick={()=>setOpen(true)}>
      <span className="authorization-icon">夸</span><span className="authorization-copy"><strong>夸克网盘</strong><span>{account?.cached ? account.name || '已连接账号' : '未授权'}</span><small>{account?.cached ? account.local ? '扫码授权 · 已保存在本机' : '服务授权 · 已保存在本机' : '扫码登录，授权保存在本机'}</small></span>
      <span className={account?.cached?'authorization-status connected':'authorization-status'}>{account?.cached?'已授权':'待授权'}</span><span aria-hidden="true">›</span>
    </button>
    <div className="authorization-code-entry"><span>内测授权</span><Button size="small" disabled={!isDesktop()} onClick={()=>{setCodeError('');setCode('');setCodeOpen(true);}}>使用授权码</Button></div>
    <Dialog className="code-dialog" aria-labelledby="code-dialog-title" open={codeOpen} onClose={()=>{if(!codeBusy){setCodeOpen(false);setCode('');}}} fullWidth maxWidth="xs"><DialogTitle id="code-dialog-title"><span className="code-dialog-badge">内测</span>获取网盘授权</DialogTitle><form onSubmit={event=>{
      event.preventDefault();if(codeLock.current||!code.trim())return;codeLock.current=true;setCodeBusy(true);setCodeError('');
      void authorizeQuarkCode(code.trim()).then(result=>{setAccount(result);setCode('');setCodeOpen(false);notify('授权成功，已保存到本机', 'success');}).catch(e=>setCodeError(String(e))).finally(()=>{codeLock.current=false;setCodeBusy(false);});
    }}><DialogContent><p className="code-dialog-description">输入内测授权码，连接夸克网盘。</p><TextField autoFocus fullWidth size="small" placeholder="请输入授权码" slotProps={{htmlInput:{'aria-label':'内测授权码'}}} type="password" autoComplete="off" value={code} disabled={codeBusy} onChange={event=>setCode(event.target.value)} helperText="授权保存在本机，成功后替换当前账号。"/></DialogContent><DialogActions><Button size="small" color="inherit" disabled={codeBusy} onClick={()=>{setCodeOpen(false);setCode('');}}>取消</Button><Button size="small" variant="text" startIcon={codeBusy?<CircularProgress size={13} color="inherit"/>:undefined} type="submit" disabled={codeBusy||!code.trim()}>{codeBusy?'正在获取…':'获取授权'}</Button></DialogActions></form></Dialog>
    {codeError && <OperationMessage severity="error">{codeError}</OperationMessage>}
    {error && <OperationMessage severity="error">{error}</OperationMessage>}
    <Dialog open={open} onClose={()=>setOpen(false)} fullWidth maxWidth="xs"><DialogTitle>夸克网盘授权</DialogTitle><DialogContent>
      <div className="authorization-qr">{state==='verified' ? <span>已授权</span> : state==='expired' ? <span>二维码已过期</span> : qr ? <img src={qr.createDataURL(6,24)} width="220" height="220" alt="夸克网盘登录二维码" /> : !error && <CircularProgress />}</div>
      <p className="authorization-instruction">{state==='verified' ? '播放时将使用此账号的本地授权。' : '使用夸克 App 扫描二维码，并在手机上确认登录。'}</p>
      {account?.cached && state!=='verified' && <p className="authorization-instruction">扫码成功后将替换当前夸克授权，完成前继续保留原授权。</p>}

    </DialogContent><DialogActions>{state!=='verified' && <Button disabled={qrBusy} onClick={()=>{if(qrLock.current)return;qrLock.current=true;setQrBusy(true);setAttempt(value=>value+1);}}>{qrBusy?'请求中…':'重新生成'}</Button>}<Button onClick={()=>setOpen(false)}>{state==='verified'?'完成':'关闭'}</Button></DialogActions></Dialog>
  </div>;
}

