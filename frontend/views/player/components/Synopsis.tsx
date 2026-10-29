import { useEffect, useId, useRef, useState } from 'react';

/** 默认展示三行剧情简介；文字超出时提供展开、收起操作，并随容器宽度重新判断。 */
export function Synopsis({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const id = useId();

  useEffect(() => {
    const node = paragraph.current;
    if (!node) return;
    /** 根据完整内容高度判断是否超过三行，短简介不显示多余的操作按钮。 */
    function measure() {
      if (!node) return;
      setOverflowing(node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * 3 + 1);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return <section className="watch-synopsis-section" aria-label="剧情简介">
    <h3>剧情简介</h3>
    <p ref={paragraph} id={id} className={`watch-synopsis${expanded ? ' is-expanded' : ''}`}>{text}</p>
    {overflowing && <button type="button" className="watch-synopsis-toggle" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '更多'}</button>}
  </section>;
}
