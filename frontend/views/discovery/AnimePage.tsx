import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { DiscoveryContinuation } from '@/views/discovery/components/DiscoveryContinuation';
import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '@/platform/desktop';
import { animeSources as sources, animeContent } from '@/services/discovery';
import { Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/RefreshRounded';
import { DiscoveryCard, DiscoverySkeletonCard } from '@/views/discovery/components/DiscoveryCard';
import { createDiscoveryCache, type DiscoveryCache, type DiscoveryItem } from '@/domain/discovery/discovery-cache';
import { animeDate, dailyAnime } from '@/domain/discovery/anime';

const cache = createDiscoveryCache(localStorage);
type SourceKey = keyof typeof sources;
type SectionState = { data: DiscoveryCache | null; loading: boolean; error: string };
type Sections = Record<SourceKey, SectionState>;

/** 展示今日推荐与地区动漫列表，协调各数据源的缓存和加载进度。 */
export function AnimePage({ disabled, onPick, onLoadingChange }: { disabled: boolean; onPick: (title: string) => void; onLoadingChange: (loading: boolean) => void }) {
  const [date, setDate] = useState(() => animeDate());
  const [shuffling, setShuffling] = useState(false);
  const shuffleLock = useRef(false);
  const loadingRef = useRef(false);
  const [batch, setBatch] = useState(0);
  const [retry, setRetry] = useState(0);
  const [sections, setSections] = useState<Sections>(() => Object.fromEntries(Object.entries(sources).map(([key, source]) => {
    const data = cache.read(source.key);
    return [key, { data, loading: !data && isDesktop(), error: '' }];
  })) as Sections);
  useEffect(() => {
    /** 检查北京时间日期是否变化，仅在跨日时更新日期状态。 */
    const check = () => setDate(previous => { const next = animeDate(); return previous.key === next.key ? previous : next; });
    const timer = window.setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, []);
  useEffect(() => { setBatch(0); }, [date.key, date.weekday]);
  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    const keys = Object.keys(sources) as SourceKey[];
    loadingRef.current = true;
    onLoadingChange(keys.some(key => cache.needsRefresh(sources[key].key)));
    /** 按页面日本、中国的顺序发起并发请求，每个结果独立更新区域，不等待其他接口。 */
    async function loadSections() {
      await Promise.all(keys.map(async key => {
        const source = sources[key], saved = cache.read(source.key);
        setSections(previous => ({ ...previous, [key]: { data: saved, loading: true, error: '' } }));
        try {
          const data = await cache.load(source.key, source.load);
          if (active) setSections(previous => ({ ...previous, [key]: { data, loading: false, error: '' } }));
        } catch {
          if (active) setSections(previous => ({ ...previous, [key]: { data: saved, loading: false, error: saved ? '更新失败，已保留上次内容。' : '暂时无法加载，请稍后重试。' } }));
        }
      }));
      if (active) { loadingRef.current = false; onLoadingChange(false); }
    }
    void loadSections();
    return () => { active = false; loadingRef.current = false; onLoadingChange(false); };
  }, [retry, date.key, onLoadingChange]);

  /** 地区仍在加载或上次切换动画未结束时忽略重复点击；换一换仅切换已缓存条目。 */
  function shuffle() {
    if (loadingRef.current || shuffleLock.current) return;
    shuffleLock.current = true; setShuffling(true); setBatch(value => value + 1);
  }
  /** 以图标动画结束作为本次切换完成信号，恢复下一次点击。 */
  function finishShuffle() {
    shuffleLock.current = false; setShuffling(false);
  }
  /** 加载期间忽略重复重试，显式重试只解除失败缓存。 */
  function retryContent() {
    if (loadingRef.current) return;
    loadingRef.current = true; cache.retryFailed(); setRetry(value => value + 1);
  }
  const recommendations = dailyAnime(sections.japan.data?.items ?? [], sections.china.data?.items ?? [], date.key, batch);
  const dailyLoading = !recommendations.length && (sections.japan.loading || sections.china.loading);
  /** 根据加载状态、条目和空数据文案渲染动漫卡片区域。 */
  const renderCards = (items: DiscoveryItem[], loading: boolean, count: number, empty: string) => loading && !items.length ?
    <div className="anime-grid" role="status" aria-label="正在加载动漫">{Array.from({ length: count }, (_, i) => <DiscoverySkeletonCard key={i} />)}</div> : items.length ?
    <div className="anime-grid">{items.map(item => <DiscoveryCard directCover key={item.id} item={item} disabled={disabled} onPick={onPick} />)}</div> : <div className="anime-empty">{isDesktop() ? empty : '请在桌面应用中查看动漫内容。'}</div>;
  return <div className="anime-page" aria-label="动漫内容">
    <section className="anime-section" aria-labelledby="anime-recommend-title">
      <div className="anime-section-heading"><div><p className="eyebrow">发现 · 动漫</p><h1 id="anime-recommend-title">今日推荐</h1></div><Button className="anime-shuffle" startIcon={<RefreshIcon className={shuffling ? 'anime-shuffle-spinning' : undefined} onAnimationEnd={finishShuffle} />} disabled={shuffling || sections.japan.loading || sections.china.loading || new Set([...(sections.japan.data?.items ?? []), ...(sections.china.data?.items ?? [])].map(item => item.id)).size <= 8} aria-busy={shuffling} onClick={shuffle}>换一换</Button></div>
      {!recommendations.length && !dailyLoading && (sections.japan.error || sections.china.error) && <Button size="small" disabled={sections.japan.loading || sections.china.loading} onClick={retryContent}>重试加载</Button>}
      {renderCards(recommendations, dailyLoading, 8, '推荐暂时没有内容，请稍后重试。')}
    </section>
    {(['japan', 'china'] as const).map(key => <section key={key} className="anime-section" aria-labelledby={`anime-${key}-title`}>
      <div className="anime-section-heading"><h2 id={`anime-${key}-title`}>{key === 'japan' ? '日本动漫' : '中国动漫'}</h2><span>豆瓣精选 · 点击海报搜索观看</span></div>
      {sections[key].error && <><OperationMessage severity="warning">{(key === 'japan' ? '日本动漫：' : '中国动漫：') + sections[key].error}</OperationMessage><Button size="small" disabled={sections.japan.loading || sections.china.loading} onClick={retryContent}>重试加载</Button></>}
      {renderCards(sections[key].data?.items ?? [], sections[key].loading, key === 'china' ? 20 : 24, '这个分类暂时没有内容。')}
      {!sections[key].loading && !sections[key].error && !!sections[key].data?.items.length && isDesktop() && <DiscoveryContinuation key={sources[key].key} anime
        initial={sections[key].data!.items} loadPage={page => animeContent(key, page)} disabled={disabled} onPick={onPick} />}
    </section>)}
  </div>;
}
