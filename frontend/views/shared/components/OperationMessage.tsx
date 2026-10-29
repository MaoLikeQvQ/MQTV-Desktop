import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Box, Portal, type AlertColor } from '@mui/material';

type Message = { id: number; text: string; severity: AlertColor };
type Notify = (text: string, severity?: AlertColor) => void;
const MessageContext = createContext<Notify | null>(null);

/** 在应用顶部叠放操作消息；切换页面后继续显示，每条独立计时三秒并支持手动关闭。 */
export function OperationMessageProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [container, setContainer] = useState<Element | null>(document.fullscreenElement);
  const sequence = useRef(0);
  const notify = useCallback<Notify>((text, severity = 'info') => {
    setMessages(previous => [...previous, { id: ++sequence.current, text, severity }]);
  }, []);
  /** 只移除指定消息，避免并发操作的完成结果互相覆盖。 */
  const dismiss = useCallback((id: number) => {
    setMessages(previous => previous.filter(message => message.id !== id));
  }, []);
  useEffect(() => {
    /** 浏览器视频全屏时，将消息浮层挂到全屏元素内以保持可见。 */
    function followFullscreen() { setContainer(document.fullscreenElement); }
    document.addEventListener('fullscreenchange', followFullscreen);
    return () => document.removeEventListener('fullscreenchange', followFullscreen);
  }, []);
  return <MessageContext.Provider value={notify}>
    {children}
    {messages.length > 0 && <Portal container={container}>
      <Box sx={{ position: 'fixed', top: 24, left: '50%', transform: 'translateX(-50%)', zIndex: theme => theme.zIndex.tooltip + 1,
        display: 'flex', flexDirection: 'column', gap: 1, width: 'max-content', maxWidth: 'calc(100vw - 32px)', pointerEvents: 'none' }}>
        {messages.map(message => <TimedMessage key={message.id} message={message} onDismiss={dismiss} />)}
      </Box>
    </Portal>}
  </MessageContext.Provider>;
}

/** 为单条消息安排固定三秒关闭，不因鼠标悬停、页面重渲染或窗口失焦延长时间。 */
function TimedMessage({ message, onDismiss }: { message: Message; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(message.id), 3000);
    return () => window.clearTimeout(timer);
  }, [message.id, onDismiss]);
  return <Alert severity={message.severity} variant="standard" onClose={() => onDismiss(message.id)}
    sx={{ pointerEvents: 'auto', boxShadow: 6, alignItems: 'center', overflowWrap: 'anywhere', maxHeight: '40vh', overflowY: 'auto' }}>
    {message.text}
  </Alert>;
}

/** 获取统一操作提示入口，调用后立即弹出消息，由全局浮层管理生命周期。 */
export function useOperationMessage(): Notify {
  const notify = useContext(MessageContext);
  if (!notify) throw new Error('操作消息组件必须放在 OperationMessageProvider 内');
  return notify;
}

/** 将已有操作结果状态转为一次弹出消息，不占用触发组件的布局空间。 */
export function OperationMessage({ children, severity = 'info' }: { children: string; severity?: AlertColor }) {
  const notify = useOperationMessage();
  const shown = useRef<{ text: string; severity: AlertColor } | null>(null);
  useEffect(() => {
    if (shown.current?.text === children && shown.current.severity === severity) return;
    shown.current = { text: children, severity };
    if (children) notify(children, severity);
  }, [children, severity, notify]);
  return null;
}
