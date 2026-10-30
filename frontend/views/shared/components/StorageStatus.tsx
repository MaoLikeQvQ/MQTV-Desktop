import { useState, useSyncExternalStore } from 'react';
import { Alert, Box, Button } from '@mui/material';
import { closeDiscardingPendingStorage } from '@/platform/storage';
import { desktopStorage } from '@/services/storage';

/** 持续展示数据库保存错误，提供显式重试或放弃未保存更改后退出。 */
export function StorageStatus() {
  const error = useSyncExternalStore(desktopStorage.subscribe, desktopStorage.getError);
  const [retrying, setRetrying] = useState(false);
  const [closeError, setCloseError] = useState('');
  /** 重试待写数据，失败时保留全局错误而不声称保存成功。 */
  async function retry(): Promise<void> {
    setRetrying(true);
    try { await desktopStorage.retry(); }
    catch { /* 错误仍由 desktopStorage 的持久状态展示。 */ }
    finally { setRetrying(false); }
  }
  /** 用户明确放弃后退出；窗口操作失败也在当前提示中展示。 */
  async function discardAndClose(): Promise<void> {
    try { await closeDiscardingPendingStorage(); }
    catch { setCloseError('关闭窗口失败，请使用系统退出操作。'); }
  }
  if (!error) return null;
  return <Box sx={{ position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: theme => theme.zIndex.tooltip + 2 }}>
    <Alert severity="error" action={<Box sx={{ display: 'flex', gap: 1 }}>
      <Button color="inherit" disabled={retrying} onClick={() => void retry()}>{retrying ? '正在重试' : '重试保存'}</Button>
      <Button color="inherit" disabled={retrying} onClick={() => void discardAndClose()}>放弃更改并退出</Button>
    </Box>}>
      {error.message}{closeError && ` ${closeError}`}
    </Alert>
  </Box>;
}
