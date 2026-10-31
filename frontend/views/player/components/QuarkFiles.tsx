import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { isQuarkShare } from '@/domain/media/netdisk';
import type { PlaybackTarget } from '@/domain/history/history';
import { useEffect, useRef, useState } from 'react';
import { Button, Stack } from '@mui/material';
import { playQuarkEpisode, type QuarkEpisode as Episode } from '@/api/quark';
import { scanQuarkEpisodes } from '@/services/quark-episodes';
import { loadQuarkInfo, readQuarkInfoCache, readQuarkEpisodeCache, saveQuarkEpisodeCache, refreshQuarkEpisodes } from '@/services/quark-playback-cache';
import type { PlayerNavigation } from '@/views/player/Player';
import { EpisodeButton } from '@/views/player/components/EpisodeButton';

/** 管理夸克详情或脚本直接返回的分享线路、选集解析和播放准备，不要求填写提取码，并向播放器提供相邻集导航。 */
export function QuarkFiles({ detailUrl, directShare, onPlay, onNavigation, onSynopsis, resume, searchEntry = true }: { detailUrl: string; searchEntry?: boolean; directShare?: boolean; onSynopsis?: (value: string) => void; onNavigation: (navigation: PlayerNavigation) => void; resume?: PlaybackTarget; onPlay: (url: string, name: string, size: number | undefined, target: PlaybackTarget) => void }) {
  const [shares, setShares] = useState<string[]>([]);
  const sharesRef = useRef<string[]>([]);
  const invalidShares = useRef(new Set<string>());
  const [share, setShare] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const episodesRef = useRef<Episode[]>([]);
  episodesRef.current = episodes;
  const [busy, setBusy] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState('');
  const resumePending = useRef(!!resume?.quark);
  const autoplayPending = useRef(!resume?.quark);
  const generation = useRef(0);
  const playLock = useRef(false);
  const selectionLock = useRef(false);
  const scanController = useRef<AbortController | null>(null);
  /** 仅移除明确失效或无视频的分享；临时网络故障保留线路。自动切换时不沿用历史进度。 */
  async function discardInvalidShare(failed: string, reason: unknown): Promise<boolean> {
    if (!/分享.*(?:HTTP 404|已失效|不存在|已删除)|该夸克资源没有可播放选集/.test(String(reason))) return false;
    invalidShares.current.add(failed);
    const remaining = sharesRef.current.filter(value => !invalidShares.current.has(value));
    sharesRef.current = remaining;
    setShares(remaining);
    setEpisodes([]);
    resumePending.current = false;
    autoplayPending.current = true;
    setBusy(false);
    playLock.current = false;
    if (remaining.length) await parse(remaining[0]);
    else { setShare(''); setScanning(false); setError('此来源的分享线路均已失效，请切换影片来源。'); }
    return true;
  }
  /**
   * 解析所选分享的可播放文件，用请求序号隔离旧响应。
   * @param nextShare 要解析的分享地址。
   * @param continuing 是否继续历史恢复流程，手动切换时关闭自动恢复。
   */
  async function parse(nextShare: string, continuing = false) {
    if (!continuing) { resumePending.current = false; autoplayPending.current = true; }
    const request=++generation.current;
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    setShare(nextShare); setBusy(false); setScanning(true); setError(''); setEpisodes([]); setPlaying('');
    try {
      const cached = readQuarkEpisodeCache(nextShare, searchEntry);
      if (cached) {
        setEpisodes(cached); setScanning(false);
        // 后台扫描不参与 busy，不清空列表，也不改变当前播放身份。
        try {
          const updated = await refreshQuarkEpisodes(nextShare, controller.signal);
          if (updated && request === generation.current) setEpisodes(updated);
        } catch (reason) {
          if (request === generation.current && await discardInvalidShare(nextShare, reason)) return;
          console.warn('后台选集更新失败，继续使用本机缓存');
        }
        return;
      }
      const complete: Episode[] = [];
      await scanQuarkEpisodes(nextShare, controller.signal, episode => {
        complete.push(episode);
        if (request === generation.current) setEpisodes(previous => [...previous, episode]);
      });
      if (!controller.signal.aborted && request === generation.current) saveQuarkEpisodeCache(nextShare, complete);
    } catch(e) {if(request===generation.current && !await discardInvalidShare(nextShare, e)) setError(String(e));}
    finally {if(request===generation.current) setScanning(false);}
  }
  /** 先用持久缓存恢复续播，再后台更新线路与简介；更新不切换正在播放的分享。 */
  async function reloadDetail(continuing = false) {
    const request = ++generation.current;
    scanController.current?.abort();
    setScanning(false);
    setBusy(true); setError(''); setEpisodes([]); setPlaying('');
    if (!continuing) resumePending.current = false;
    try {
      const cachedInfo = !directShare ? readQuarkInfoCache(detailUrl, searchEntry) : null;
      const info = directShare ? { shares: [detailUrl], synopsis: '' } : await loadQuarkInfo(detailUrl, false, undefined, searchEntry);
      if (request !== generation.current) return;
      if (!directShare) onSynopsis?.(info.synopsis);
      const next = info.shares.filter(value => isQuarkShare(value) && !invalidShares.current.has(value));
      sharesRef.current = next;
      setShares(next);
      if (!next.length) throw new Error('此来源没有可用的分享线路，请切换影片来源。');
      const preferred = continuing ? resume?.quark?.share : share;
      if (continuing && preferred && !next.includes(preferred)) {
        resumePending.current = false;
        setShare(next[0]); setBusy(false); setError('上次观看的分享线路已不可用，请选择线路。'); return;
      }
      const parsing = parse(preferred && next.includes(preferred) ? preferred : next[0], continuing);
      if (cachedInfo) {
        const current = generation.current;
        const signal = scanController.current!.signal;
        void loadQuarkInfo(detailUrl, true, signal).then(updated => {
          if (signal.aborted || current !== generation.current || !updated.shares.length) return;
          if (JSON.stringify(updated.shares) !== JSON.stringify(info.shares)) {
            const available = updated.shares.filter(value => !invalidShares.current.has(value));
            sharesRef.current = available;
            setShares(available);
          }
          if (updated.synopsis !== info.synopsis) onSynopsis?.(updated.synopsis);
        }).catch(() => console.warn('后台线路更新失败，继续使用本机缓存'));
      }
      await parsing;
    } catch (reason) {
      if (request === generation.current) { setError(String(reason)); setBusy(false); }
    }
  }
  useEffect(() => {
    void reloadDetail(true);
    return () => { ++generation.current; scanController.current?.abort(); };
  }, [detailUrl, directShare]);
  /** 手动切换分享线路时锁定入口，直到目录请求完成，避免重复扫描。 */
  async function selectShare(nextShare: string) {
    if (busy || scanning || selectionLock.current || nextShare === share) return;
    selectionLock.current = true; setRequestBusy(true);
    try { await parse(nextShare); }
    finally { selectionLock.current = false; setRequestBusy(false); }
  }
  /** 准备指定夸克选集并通知上层播放，使用锁避免重复转存或准备请求。 */
  function playEpisode(episode: Episode) {
    if (playLock.current || busy) return;
    playLock.current = true;
    setBusy(true); setError(''); const request = generation.current;
    const episodeIndex = episodesRef.current.findIndex(item => item.id === episode.id);
    const episodeCount = episodesRef.current.length;
    void playQuarkEpisode({share, parent:episode.parent, passcode: new URL(share).searchParams.get('pwd') || '', fid:episode.id, page:episode.page}).then(result => {
      if (request === generation.current) { setPlaying(episode.id); onPlay(result.url, episode.name, episode.size, {
        line: `线路 ${shares.indexOf(share) + 1}`, episode: episode.name,
        episodeIndex, episodeCount,
        quark: { share, file: episode },
      }); window.scrollTo({top:0}); }
    }).catch(async e => { if (request === generation.current && !await discardInvalidShare(share, e)) setError(String(e)); }).finally(() => {
      playLock.current = false;
      if (request === generation.current) setBusy(false);
    });
  }
  useEffect(() => {
    if (busy) return;
    if (resumePending.current && resume?.quark) {
      autoplayPending.current = false;
      const episode = episodes.find(item => item.id === resume.quark?.file.id);
      if (episode) { resumePending.current = false; playEpisode(episode); }
      else if (!scanning) { resumePending.current = false; setError('上次观看的文件已不可用，请重新选择集数。'); }
    } else if (autoplayPending.current && episodes.length) {
      autoplayPending.current = false;
      playEpisode(episodes[0]);
    }
  }, [episodes, busy, scanning]);
  useEffect(() => {
    const index = episodes.findIndex(item => item.id === playing);
    onNavigation({
      busy: busy || (scanning && !episodes.length), error,
      previous: index > 0 ? {name: episodes[index - 1].name, play: () => playEpisode(episodes[index - 1])} : undefined,
      next: index >= 0 && index < episodes.length - 1 ? {name: episodes[index + 1].name, play: () => playEpisode(episodes[index + 1])} : undefined,
    });
  }, [episodes, playing, busy, scanning, error, share, onNavigation]);
  return <Stack className="cloud-episodes" spacing={1.25}><div className="cloud-panel-heading"><h2>播放线路</h2><span>{shares.length} 条线路</span></div>
    {shares.length>0 && <div className="cloud-line-grid">{shares.map((s,i)=><Button key={s} disabled={busy || scanning || requestBusy} aria-pressed={share===s} variant={share===s?'contained':'outlined'} onClick={()=>void selectShare(s)}>线路 {i+1}</Button>)}</div>}
    {error && <OperationMessage severity="error">{error}</OperationMessage>}
    {(!!episodes.length || scanning) && <><p className="cloud-episode-heading">选集 · {episodes.length}{scanning && <span className="episode-scan-status" role="status">正在加载更多…</span>}</p><div className="episode-grid">{episodes.map(episode=><EpisodeButton key={episode.id} name={episode.name} active={playing===episode.id} disabled={busy} onClick={()=>playEpisode(episode)}/>)}{scanning && <div className="episode-loading-tile" aria-hidden="true"><span /><span /></div>}</div></>}
  </Stack>;
}
