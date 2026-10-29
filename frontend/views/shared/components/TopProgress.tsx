import { useEffect, useState } from 'react';

// Navigation-style activity feedback: never implies a measured percentage.
/** 展示顶部加载进度；短请求延迟显示，进行中停在完成前，结束后补满并隐藏。 */
export function TopProgress({ active }: { active: boolean }) {
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setProgress(value => value > 0 ? 100 : 0);
      const timer = window.setTimeout(() => { setVisible(false); setProgress(0); }, 250);
      return () => window.clearTimeout(timer);
    }
    setVisible(false); setProgress(0);
    // Fast cache hits and synchronous navigation should not flash a bar.
    const start = window.setTimeout(() => { setVisible(true); setProgress(12); }, 120);
    const tick = window.setInterval(() => setProgress(value => Math.min(90, value + (90 - value) * 0.12)), 400);
    return () => { window.clearTimeout(start); window.clearInterval(tick); };
  }, [active]);
  return <div className={`top-progress${visible ? ' is-visible' : ''}${!active ? ' is-complete' : ''}`} role={active ? 'progressbar' : undefined} aria-label={active ? '正在加载' : undefined} aria-hidden={!active}>
    <span style={{ transform: `scaleX(${progress / 100})` }} />
  </div>;
}
