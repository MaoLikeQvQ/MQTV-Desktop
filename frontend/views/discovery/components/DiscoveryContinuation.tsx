import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { useEffect, useRef, useState } from 'react';
import { Button, CircularProgress } from '@mui/material';
import type { DiscoveryItem } from '@/domain/discovery/discovery-cache';
import { createDiscoveryPagination, type PageLoader, type PaginationState } from '@/services/discovery-pagination';
import { DiscoveryCard } from '@/views/discovery/components/DiscoveryCard';

/** 在列表底部自动加载后续页，保留手动加载与失败重试入口；由父级按分类 key 隔离实例。 */
export function DiscoveryContinuation({ initial, loadPage, disabled, onPick, anime = false }: {
  initial: DiscoveryItem[]; loadPage: PageLoader; disabled: boolean; onPick: (title: string) => void; anime?: boolean;
}) {
  const [state, setState] = useState<PaginationState>({ items: [], loading: false, hasMore: true, error: '' });
  const sentinel = useRef<HTMLDivElement>(null);
  const pager = useRef<ReturnType<typeof createDiscoveryPagination> | null>(null);
  useEffect(() => {
    const current = createDiscoveryPagination(initial, loadPage, setState);
    pager.current = current;
    return () => { current.dispose(); pager.current = null; };
  }, []);
  useEffect(() => {
    if (!sentinel.current || !state.hasMore || state.error || state.loading || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void pager.current?.load();
    }, { rootMargin: '0px 0px 200px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [state.items.length, state.hasMore, state.error, state.loading]);
  return <div className="discovery-continuation" aria-busy={state.loading}>
    {state.items.length > 0 && <div className={anime ? 'anime-grid' : 'discovery-grid'}>{state.items.map(item =>
      <DiscoveryCard directCover key={item.id} item={item} disabled={disabled} onPick={onPick} />)}</div>}
    <div ref={sentinel} className="discovery-load-more" aria-live="polite">
      {state.loading ? <><CircularProgress size={18} /><span>正在加载更多…</span></> : state.error ?
        <><OperationMessage severity="warning">{state.error}</OperationMessage><Button size="small" onClick={() => void pager.current?.load(true)}>重试</Button></> : state.hasMore ?
          <Button size="small" onClick={() => void pager.current?.load()}>加载更多</Button> : <span>已经到底了</span>}
    </div>
  </div>;
}
