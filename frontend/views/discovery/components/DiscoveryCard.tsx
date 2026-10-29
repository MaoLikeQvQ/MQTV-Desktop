import { useEffect, useState } from 'react';
import { Skeleton } from '@mui/material';
import MovieIcon from '@mui/icons-material/MovieOutlined';
import PlayIcon from '@mui/icons-material/PlayArrowRounded';
import type { DiscoveryItem as Item } from '@/domain/discovery/discovery-cache';
import { loadCachedImage } from '@/services/images';

/** 渲染与真实发现卡片尺寸一致的加载占位。 */
export function DiscoverySkeletonCard() {
  return <div className="discovery-card" aria-hidden="true">
    <span className="discovery-image"><Skeleton variant="rounded" animation={false} className="discovery-skeleton" /></span>
    <span className="discovery-title"><Skeleton variant="text" animation={false} width="70%" className="discovery-title-skeleton">影片名称</Skeleton></span>
  </div>;
}
/** 展示影片封面与评分，复用图片缓存，并在点击时以标题发起搜索。 */
export function DiscoveryCard({ item, disabled, onPick, directCover = false }: { item: Item; disabled: boolean; onPick: (title: string) => void; directCover?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [cover, setCover] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setFailed(false); setCover(''); setLoaded(false);
    if (!item.cover) return;
    loadCachedImage(item.cover, directCover).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setCover(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.cover, directCover]);
  return <button className="discovery-card" aria-label={`搜索 ${item.title}`} disabled={disabled} onClick={() => onPick(item.title)}>
    <span className="discovery-image" aria-busy={!!item.cover && !failed && !loaded}>
      {item.cover && !failed && !loaded && <Skeleton variant="rounded" animation={false} className="discovery-skeleton" />}
      {cover && !failed && <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ opacity: loaded ? 1 : 0 }} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
      {(!item.cover || failed) && <span className="poster-placeholder"><MovieIcon /><span>{item.title}</span></span>}
      {item.rating && <span className="discovery-rating">{item.rating}</span>}<span className="poster-play" aria-hidden="true"><PlayIcon /></span></span>
    <span className="discovery-title" title={item.title}>{item.title}</span>
  </button>;
}
