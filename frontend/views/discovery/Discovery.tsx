import { applicationStorage } from '@/services/storage';
import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { DiscoveryContinuation } from '@/views/discovery/components/DiscoveryContinuation';
import { useEffect, useState, useRef } from 'react';
import { discoveryContent } from '@/services/discovery';
import { createDiscoveryCache } from '@/domain/discovery/discovery-cache';
import { isDesktop } from '@/platform/desktop';
import { channels, type Channel } from '@/router';
import { Button } from '@mui/material';
import { DiscoveryCard, DiscoverySkeletonCard } from '@/views/discovery/components/DiscoveryCard';
import { AnimePage } from '@/views/discovery/AnimePage';

const contentCache = createDiscoveryCache(applicationStorage);
const hotLists = [
  { id: 'douban_movie_weekly', label: '一周口碑榜' },
  { id: 'douban_tv_chinese', label: '国产剧' },
  { id: 'douban_tv_global', label: '海外剧' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
];
const movieTags = ['热门', '最新', '经典', '豆瓣高分', '华语', '欧美', '韩国', '日本'];
const tvTags = ['热门', '国产剧', '美剧', '英剧', '韩剧', '日剧'];
const discoveryPageSize = 30;

// Remount each channel so its selected filter and loading state never leak into another channel.
type DiscoveryProps = { channel: Channel; disabled: boolean; onPick: (title: string) => void; onLoadingChange: (loading: boolean) => void };
/** 按频道选择动漫专页或普通发现内容，隔离不同频道的筛选状态。 */
export function Discovery(props: DiscoveryProps) {
  return props.channel === 'anime' ? <AnimePage disabled={props.disabled} onPick={props.onPick} onLoadingChange={props.onLoadingChange} /> : <ChannelContent key={props.channel} {...props} />;
}
/** 展示普通频道筛选与卡片，复用发现页缓存并上报顶部加载进度。 */
function ChannelContent({ channel, disabled, onPick, onLoadingChange }: DiscoveryProps) {
  const filters = channel === 'recommended' ? hotLists :
    (channel === 'movie' ? movieTags : channel === 'tv' ? tvTags : channel === 'anime' ? ['日本动画'] : ['综艺']).map(label => ({ id: label, label }));
  const [filter, setFilter] = useState(filters[0].id);
  const source = discoveryContent(channel, filter);
  const contentUrl = source.key;
  const [content, setContent] = useState(() => ({ url: contentUrl, cache: contentCache.read(contentUrl) }));
  const items = content.url === contentUrl ? content.cache?.items ?? [] : contentCache.read(contentUrl)?.items ?? [];
  const [loading, setLoading] = useState(() => !contentCache.read(contentUrl));
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const loadingRef = useRef(false);
  const label = channels.find(item => item.id === channel)!.label;
  useEffect(() => {
    if (!isDesktop()) { setLoading(false); return; }
    let active = true;
    const cached = contentCache.read(contentUrl);
    setContent({ url: contentUrl, cache: cached });
    setLoading(contentCache.needsRefresh(contentUrl)); setError('');
    onLoadingChange(contentCache.needsRefresh(contentUrl));
    loadingRef.current = true;
    let received = false;
    contentCache.load(contentUrl, () => source.load(partial => {
      received = received || partial.items.length > 0;
      if (active && partial.items.length) setContent({ url: contentUrl, cache: { ...partial, updatedAt: 0 } });
    })).then(cache => {
      if (active) setContent({ url: contentUrl, cache });
    }).catch(() => {
      if (active) setError(received ? '部分内容加载失败，已显示成功获取的内容，可以重试。' : cached ? '更新失败，正在显示上次缓存的内容。' : '内容暂时没能加载，可以重试，或在上方搜索片名。');
    }).finally(() => { if (active) { loadingRef.current = false; setLoading(false); onLoadingChange(false); } });
    return () => { active = false; loadingRef.current = false; onLoadingChange(false); };
  }, [contentUrl, retry, onLoadingChange]);
  /** 已有请求进行时忽略重复重试，失败后才允许重新加载。 */
  function retryContent() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    contentCache.retryFailed(); setRetry(value => value + 1);
  }
  return <section className="discovery" aria-label={`${label}内容`} aria-busy={loading}>
    <div className="discovery-heading"><div><p className="eyebrow">发现 · {label}</p><h1>{channel === 'recommended' ? '好故事，现在开始。' : label}</h1></div><span>选一部，开启下一段故事</span></div>
    <div className="discovery-filters" aria-label={`${label}分类`}>{filters.map(item => <Button disabled={loading} key={item.id} size="small" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</Button>)}</div>
    {error && <><OperationMessage severity="warning">{error}</OperationMessage><Button size="small" disabled={loading} onClick={retryContent}>重试加载</Button></>}
    {loading && !items.length ?
      <div role="status" aria-label="正在加载内容">
        <div className="discovery-featured">{Array.from({ length: 4 }, (_, index) => <DiscoverySkeletonCard key={index} />)}</div>
        <div className="section-heading"><h2>更多好片</h2><span>点击海报，搜索观看</span></div>
        <div className="discovery-grid">{Array.from({ length: channel === 'recommended' ? 12 : discoveryPageSize - 4 }, (_, index) => <DiscoverySkeletonCard key={index} />)}</div>
      </div> : !items.length ? error ? null :
      <div className="empty-state"><h2>{isDesktop() ? '这个分类暂时没有内容' : '在桌面应用中发现更多好片'}</h2><p>{isDesktop() ? '试试其他分类，或直接搜索片名。' : '打开 MQTV 桌面版，查看推荐和分类内容。'}</p></div> : <>
        <div className="discovery-featured">{items.slice(0, 4).map(item => <DiscoveryCard directCover key={item.id} item={item} disabled={disabled} onPick={onPick} />)}</div>
        {items.length > 4 && <><div className="section-heading"><h2>更多好片</h2><span>点击海报，搜索观看</span></div><div className="discovery-grid">{items.slice(4).map(item => <DiscoveryCard directCover key={item.id} item={item} disabled={disabled} onPick={onPick} />)}</div></>}
      </>}
    {!loading && !error && items.length > 0 && filter !== 'douban_movie_weekly' && isDesktop() && <DiscoveryContinuation key={contentUrl} initial={items}
      loadPage={(page, progress) => discoveryContent(channel, filter, page).load(progress)} disabled={disabled} onPick={onPick} />}
  </section>;
}
