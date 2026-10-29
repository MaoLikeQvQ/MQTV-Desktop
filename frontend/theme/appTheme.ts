import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#24d3b8', contrastText: '#10221c' },
    secondary: { main: '#9bc6f4' },
    background: { default: '#121315', paper: '#18191c' },
    text: { primary: '#f0f1f2', secondary: '#a6abb3' },
    divider: '#ffffff12',
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    button: { textTransform: 'none', fontWeight: 550, fontSize: '0.8rem' },
  },
  shape: { borderRadius: 4 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 4, paddingInline: 16 } } },
    MuiAlert: { styleOverrides: { root: { fontSize: 12, borderRadius: 4 } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 4 } } },
    MuiOutlinedInput: { styleOverrides: { root: { fontSize: 13 } } },
  },
});
