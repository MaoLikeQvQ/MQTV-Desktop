import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isDesktop, readAppUpdateInfo, openExternalUrl } from '@/platform/desktop';
import { checkAppUpdate } from '@/services/update';
import { Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, TextField, Tooltip } from '@mui/material';
import { verifyInvitation } from '@/services/authorization-refresh';
import SystemUpdateIcon from '@mui/icons-material/SystemUpdateAltRounded';
import { type AppUpdateInfo, type UpdateResult } from '@/domain/settings/app-update';

/** 展示版本更新及邀请码入口，验证成功后通知应用解锁默认资源。 */
export function BasicSettings({ onInviteVerified }: { onInviteVerified: () => void }) {
  const notify = useOperationMessage();
  const inviteLock = useRef(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState('');

  /** 清空邀请码及失败提示，保留正在提交的验证请求。 */
  function closeInvite() {
    if (inviteLock.current) return;
    setInviteOpen(false);
    setCode('');
    setCodeError('');
  }

  /** 使用原有网盘授权接口验证邀请码，只有成功才解锁默认资源。 */
  async function verifyInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteLock.current || !code.trim()) return;
    inviteLock.current = true;
    setCodeBusy(true);
    setCodeError('');
    try {
      await verifyInvitation(code.trim());
      setCode('');
      setInviteOpen(false);
      onInviteVerified();
      notify('邀请码验证通过。', 'success');
    } catch (reason) {
      setCodeError(String(reason));
    } finally {
      inviteLock.current = false;
      setCodeBusy(false);
    }
  }

  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const downloadLock = useRef(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    let active = true;
    if (isDesktop()) void readAppUpdateInfo().then(value => {
      if (active) setInfo(value);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  /** 防止重复点击并检查当前设备可用更新，完成后恢复按钮状态。 */
  async function check() {
    if (lock.current || downloadLock.current || !isDesktop()) return;
    lock.current = true; setBusy(true); setError(''); setResult(null);
    try {
      const current = await readAppUpdateInfo();
      setInfo(current);
      setResult(await checkAppUpdate(current));
    } catch (reason) { setError('检查更新失败：' + String(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  /** 通过系统浏览器打开已校验的安装包链接，失败时弹出消息提示。 */
  async function download(url: string) {
    if (downloadLock.current || lock.current) return;
    downloadLock.current = true; setDownloading(true); setError('');
    try { await openExternalUrl(url); }
    catch (reason) { setError('打开下载地址失败：' + String(reason)); }
    finally { downloadLock.current = false; setDownloading(false); }
  }
  return <div className="resource-settings basic-settings" role="tabpanel" id="settings-content" aria-labelledby="settings-basic">
    <div className="resource-setting-row"><span>版本更新</span><div className="version-update-actions">
      <span className="version-current">{info ? '当前版本 ' + info.versionName + '（' + info.versionCode + '）' : '桌面版'}</span>
      <Tooltip title={busy ? '正在检查更新' : '检查更新'}><span><IconButton size="small" aria-label="检查版本更新" disabled={busy || downloading || !isDesktop()} onClick={() => void check()}>
        {busy ? <CircularProgress size={20} /> : <SystemUpdateIcon fontSize="small" />}
      </IconButton></span></Tooltip>
    </div></div>
    {!isDesktop() && <p className="resource-setting-note">请在桌面客户端中检查更新。</p>}
    <div className="version-update-feedback" aria-live="polite">
      {busy && <p className="resource-setting-note">正在检查更新…</p>}
      {error && <OperationMessage severity="error">{error}</OperationMessage>}
      {result && !result.updateAvailable && <OperationMessage severity="success">暂无适用于本机的新版本。</OperationMessage>}
      {result?.updateAvailable && <div><OperationMessage severity="success">{'发现新版本 ' + result.versionName}</OperationMessage><div>可下载版本 {result.versionName}</div>
        {result.notes && <p className="version-release-notes">{result.notes}</p>}
        <Button size="small" disabled={busy || downloading} onClick={() => void download(result.downloadUrl)}>{downloading ? '正在打开…' : '下载新版'}</Button>
      </div>}
    </div>
    <div className="resource-setting-row">
      <span>邀请码</span>
      <div className="resource-setting-actions">
        <Button size="small" disabled={!isDesktop()} onClick={() => setInviteOpen(true)}>验证</Button>
      </div>
    </div>
    <Dialog className="code-dialog" aria-labelledby="invite-dialog-title" open={inviteOpen} onClose={closeInvite} fullWidth maxWidth="xs">
      <DialogTitle id="invite-dialog-title">邀请码</DialogTitle>
      <form onSubmit={event => void verifyInvite(event)}>
        <DialogContent>
          <TextField autoFocus fullWidth size="small" placeholder="请输入邀请码" slotProps={{ htmlInput: { 'aria-label': '邀请码' } }}
            type="password" autoComplete="off" value={code} disabled={codeBusy} onChange={event => setCode(event.target.value)}
            error={!!codeError} helperText={codeError || undefined} />
        </DialogContent>
        <DialogActions>
          <Button size="small" color="inherit" disabled={codeBusy} onClick={closeInvite}>取消</Button>
          <Button size="small" type="submit" disabled={codeBusy || !code.trim()}
            startIcon={codeBusy ? <CircularProgress size={13} color="inherit" /> : undefined}>{codeBusy ? '正在验证…' : '验证'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  </div>;
}
