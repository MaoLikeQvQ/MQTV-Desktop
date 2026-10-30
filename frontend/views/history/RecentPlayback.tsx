import CloseIcon from '@mui/icons-material/CloseRounded';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import { CachedImage } from '@/views/shared/components/CachedImage';
import { type PlaybackRecord } from '@/domain/history/history';

/** 以紧凑海报、画面底部进度条和片名展示最近播放，点击续播，独立按钮删除记录。 */
export function RecentPlayback({ records, onResume, onRemove }: {
  records: PlaybackRecord[]; onResume: (record: PlaybackRecord) => void; onRemove: (id: string) => void;
}) {
  return <>
    <h1>最近播放</h1><p className="page-description">保存在本机的观看记录，继续上次的线路、集数和播放进度。</p>
    <div className="search-summary"><h2>观看记录</h2><span>共 {records.length} 部</span></div>
    {records.length ? <div className="history-grid">{records.map(record => <article className="history-card" key={record.id}>
      <button className="history-resume" onClick={() => onResume(record)} aria-label={'继续播放 ' + record.vod.vod_name + ' ' + record.target.episode} title={record.vod.vod_name + ' · ' + record.target.episode}>
        <span className="history-poster">
          {record.vod.vod_pic ? <CachedImage src={record.vod.vod_pic} alt="" loading="lazy" fallback={<span className="result-no-poster"><HistoryIcon />暂无海报</span>} /> : <span className="result-no-poster"><HistoryIcon />暂无海报</span>}
          <progress className="history-progress" max={record.duration || 1} value={Math.min(record.position, record.duration || 0)} aria-label="已观看进度" />
        </span>
        <span className="history-title">{record.vod.vod_name}</span>
      </button>
      <button className="history-remove" onClick={() => onRemove(record.id)} aria-label={'删除 ' + record.vod.vod_name + ' 的播放记录'} title="删除记录"><CloseIcon /></button>
    </article>)}</div> : <div className="empty-state"><div className="empty-art"><HistoryIcon /></div><h2>还没有播放记录</h2><p>开始观看后，影片、线路、集数和播放进度会自动保存在这里。</p></div>}
  </>;
}
