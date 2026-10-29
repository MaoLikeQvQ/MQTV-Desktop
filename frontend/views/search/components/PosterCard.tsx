import MovieIcon from '@mui/icons-material/MovieOutlined';
import { CachedImage } from '@/views/shared/components/CachedImage';
import type { Vod } from '@/domain/search/search';

/** 展示搜索结果海报、影片信息，点击后打开详情。 */
export function PosterCard({ item, onOpen }: { item: Vod; count: number; onOpen: () => void }) {
  return <button className="result-card" onClick={onOpen} aria-label={`查看 ${item.vod_name}`}>
    <span className="result-poster">{item.vod_pic ? <CachedImage src={item.vod_pic} alt="" loading="lazy" fallback={<span className="result-no-poster"><MovieIcon /><span>暂无海报</span></span>} /> : <span className="result-no-poster"><MovieIcon /><span>暂无海报</span></span>}</span>
    <span className="result-body">
      <span className="result-title" title={item.vod_name}>{item.vod_name}</span>
      <span className="result-tags">{item.type_name && <span>{item.type_name}</span>}{item.vod_year && <span className="result-year">{item.vod_year}</span>}</span>
      {item.vod_remarks && <span className="result-remarks">{item.vod_remarks}</span>}
      <span className="result-action">立即播放 <span aria-hidden="true">↗</span></span>
    </span>
  </button>;
}

