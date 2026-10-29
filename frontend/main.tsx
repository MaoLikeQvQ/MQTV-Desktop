import React from 'react';
import ReactDOM from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import App from '@/views/app/App';
import { OperationMessageProvider } from '@/views/shared/components/OperationMessage';
import { theme } from '@/theme/appTheme';
import '@/styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <OperationMessageProvider><App /></OperationMessageProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
