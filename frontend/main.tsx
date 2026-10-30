import React from 'react';
import ReactDOM from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import App from '@/views/app/App';
import { OperationMessageProvider } from '@/views/shared/components/OperationMessage';
import { StorageStatus } from '@/views/shared/components/StorageStatus';
import { isDesktop } from '@/platform/desktop';
import { installStorageCloseGuard, listenStorageChanges } from '@/platform/storage';
import { desktopStorage } from '@/services/storage';
import { theme } from '@/theme/appTheme';
import '@/styles/index.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

/** 桌面先恢复 SQLite 及旧数据，再挂载页面，失败时保留旧数据并显示可重试的启动错误。 */
async function startApplication(): Promise<void> {
  root.render(<p role="status" style={{ padding: 24 }}>正在读取本地数据…</p>);
  let unlistenChanges: (() => void) | undefined;
  try {
    if (isDesktop()) {
      unlistenChanges = await listenStorageChanges(desktopStorage.receiveChanges);
      await desktopStorage.initialize(window.location.hash === '#player' ? undefined : localStorage);
      await installStorageCloseGuard(desktopStorage.hasPending, desktopStorage.flush, desktopStorage.reportCloseError, { freeze: desktopStorage.freezeWrites, resume: desktopStorage.resumeWrites });
    }
    root.render(
      <React.StrictMode>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <OperationMessageProvider><App /><StorageStatus /></OperationMessageProvider>
        </ThemeProvider>
      </React.StrictMode>,
    );
  } catch {
    unlistenChanges?.();
    root.render(<div role="alert" style={{ padding: 24 }}>
      <p>无法初始化本地数据库或关闭保护，应用尚未启动。旧数据已保留，请检查磁盘空间和目录权限后重试。</p>
      <button onClick={() => void startApplication()}>重试</button>
    </div>);
  }
}

void startApplication();
