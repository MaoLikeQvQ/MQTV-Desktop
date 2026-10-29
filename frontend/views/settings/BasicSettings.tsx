import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { useEffect, useRef, useState } from 'react';
import { isDesktop, readAppUpdateInfo, openExternalUrl } from '@/platform/desktop';
import { checkAppUpdate } from '@/services/update';
import { Button, CircularProgress, IconButton, Tooltip } from '@mui/material';
import SystemUpdateIcon from '@mui/icons-material/SystemUpdateAltRounded';
import { type AppUpdateInfo, type UpdateResult } from '@/domain/settings/app-update';

/** 展示当前版本和手动更新入口，呈现检查、失败与新版下载反馈。 */
export function BasicSettings() {
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
  </div>;
}
