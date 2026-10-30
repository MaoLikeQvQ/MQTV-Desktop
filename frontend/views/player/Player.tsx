import { OperationMessage } from '@/views/shared/components/OperationMessage';
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { readMediaDownloadedBytes } from '@/api/playback';
import { createDownloadRate, downloadRateText } from '@/domain/media/download-rate';
import { isDesktop, readScreenFullscreen, setScreenFullscreen } from '@/platform/desktop';
import type { PlaybackProgress } from '@/domain/history/history';
import { CircularProgress } from '@mui/material';
import PlayIcon from '@mui/icons-material/PlayArrowRounded';
import PauseIcon from '@mui/icons-material/PauseRounded';
import VolumeIcon from '@mui/icons-material/VolumeUpRounded';
import MuteIcon from '@mui/icons-material/VolumeOffRounded';
import PreviousIcon from '@mui/icons-material/ArrowBackRounded';
import NextIcon from '@mui/icons-material/ArrowForwardRounded';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExitRounded';
import ReplayIcon from '@mui/icons-material/Replay10Rounded';
import ForwardIcon from '@mui/icons-material/Forward10Rounded';
import FullscreenIcon from '@mui/icons-material/FullscreenRounded';
import PipIcon from '@mui/icons-material/PictureInPictureAltRounded';

/** 将有效秒数格式化为播放器时间文本，无效输入显示 00:00。 */
function time(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const value = Math.floor(seconds);
  return `${value >= 3600 ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export type PlayerNavigation = {
  previous?: { name: string; play: () => void };
  next?: { name: string; play: () => void };
  busy?: boolean;
  error?: string;
};
/** 管理视频或 HLS 播放、进度恢复与媒体控制；通过回调协调侧栏和全屏选集。 */
export function Player({ url, title, episode, navigation = {}, initialProgress, onProgress, playbackKey, onFullscreenChange, onPlaybackStarted }: {
  onFullscreenChange?: (fullscreen: boolean) => void; onPlaybackStarted?: () => void;
  url: string; playbackKey?: string; title: string; episode: string; navigation?: PlayerNavigation;
  initialProgress?: PlaybackProgress; onProgress?: (progress: PlaybackProgress) => void;
}) {
  const startedCallback = useRef(onPlaybackStarted);
  startedCallback.current = onPlaybackStarted;
  const ref = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [screenFullscreen, setScreenFullscreenState] = useState(false);
  const fullscreenBusy = useRef(false);
  const ownsFullscreen = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloadRate, setDownloadRate] = useState<number | null>(null);
  const loadingRef = useRef(true);
  loadingRef.current = loading || !!navigation.busy;
  const [paused, setPaused] = useState(true);
  const [visible, setVisible] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  /** 显示控制栏并重设两秒自动隐藏计时，暂停、悬停或键盘聚焦时保持可见。 */
  function reveal() {
    setVisible(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (ref.current && !ref.current.paused && !stage.current?.querySelector(':focus-visible') && !stage.current?.querySelector('.media-controls:hover')) setVisible(false); }, 2000);
  }
  /** 切换播放与暂停，开始播放失败时显示可操作提示。 */
  async function toggle() {
    const video = ref.current; if (!video) return;
    if (video.paused) {
      try { await video.play(); setError(''); } catch { setError('无法开始播放，请重试或切换线路。'); }
    } else video.pause();
    reveal();
  }
  /** 桌面端切换系统屏幕全屏，浏览器使用标准全屏；失败时提示而不模拟窗口内全屏。 */
  async function fullscreen() {
    if (fullscreenBusy.current) return;
    fullscreenBusy.current = true;
    try {
      if (isDesktop()) {
        const next = !(await readScreenFullscreen());
        if (!mounted.current) return;
        await setScreenFullscreen(next);
        if (!mounted.current) { if (next) await setScreenFullscreen(false); return; }
        ownsFullscreen.current = next;
        setScreenFullscreenState(next);
      } else if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.current?.requestFullscreen) await (stage.current.closest('.watch-layout') ?? stage.current).requestFullscreen();
      else throw new Error('Fullscreen API unavailable');
    } catch { setError('无法切换屏幕全屏，请重试。'); }
    finally { fullscreenBusy.current = false; reveal(); }
  }
  useEffect(() => {
    let active = true;
    mounted.current = true;
    /** 同步浏览器或系统全屏状态，支持从系统菜单退出全屏。 */
    const update = () => {
      if (isDesktop()) {
        void readScreenFullscreen().then(value => {
          if (!active || fullscreenBusy.current) return;
          setScreenFullscreenState(value);
          if (!value) ownsFullscreen.current = false;
        }).catch(() => { if (active) setError('无法读取屏幕全屏状态。'); });
      } else setIsFullscreen(!!stage.current && !!document.fullscreenElement?.contains(stage.current));
      reveal();
    };
    /** 按 Escape 退出由播放器开启的系统全屏，焦点位于控件时也生效。 */
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ownsFullscreen.current) { event.preventDefault(); void fullscreen(); }
    };
    update();
    document.addEventListener('fullscreenchange', update);
    window.addEventListener('resize', update);
    document.addEventListener('keydown', escape);
    return () => {
      active = false;
      mounted.current = false;
      document.removeEventListener('fullscreenchange', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('keydown', escape);
      if (ownsFullscreen.current) {
        ownsFullscreen.current = false;
        void setScreenFullscreen(false).catch(reason => console.error('退出播放器系统全屏失败', reason));
      }
    };
  }, []);
  useEffect(() => {
    onFullscreenChange?.(isFullscreen || screenFullscreen);
  }, [isFullscreen, screenFullscreen, onFullscreenChange]);
  useEffect(() => () => onFullscreenChange?.(false), [onFullscreenChange]);
  /** 按秒偏移跳转播放位置，并限制在视频时长范围内。 */
  function seek(offset: number) {
    const video = ref.current;
    if (video && duration > 0) video.currentTime = Math.max(0, Math.min(duration, video.currentTime + offset));
    reveal();
  }
  /** 进入或退出画中画，不支持或调用失败时显示提示。 */
  async function pictureInPicture() {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await ref.current?.requestPictureInPicture(); }
    catch { setError('当前视频暂时无法进入画中画。'); }
  }
  useEffect(() => {
    const video = ref.current; if (!video) return;
    setError(''); setLoading(true); setPosition(0); setDuration(0); setBuffered(0); setPaused(true); setVisible(true);
    let disposed = false;
    let started = false;
    let autoplayPending = true;
    let lastSaved = 0;
    let restored = false;
    /**
     * 在实际开始播放后上报有效进度，常规上报间隔至少五秒。
     * @param force 是否绕过五秒间隔，在暂停、离开或切换时立即上报。
     */
    const save = (force = false) => {
      if (!started || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) return;
      if (!force && Date.now() - lastSaved < 5000) return;
      lastSaved = Date.now();
      onProgress?.({ position: video.currentTime, duration: video.duration, speed: video.playbackRate });
    };
    /** 视频元数据可用后仅恢复一次历史播放速度和位置，位置不超过结尾。 */
    const restore = () => {
      if (restored || !Number.isFinite(video.duration) || video.duration <= 0) return;
      restored = true;
      if (initialProgress) {
        video.playbackRate = initialProgress.speed;
        video.currentTime = Math.min(initialProgress.position, Math.max(0, video.duration - 0.1));
      }
    };
    /** 页面离开时强制上报当前播放进度。 */
    const onLeave = () => save(true);
    /** 关窗保护等待落盘前暂停播放并采集最后进度，避免 pagehide 时才排队。 */
    const onBeforeClose = () => { video.pause(); save(true); };
    /** 结束加载状态并提示用户切换线路或重新选择选集。 */
    const onError = () => { setLoading(false); setError('播放失败，可尝试切换线路或重新选择选集。'); };
    /** 视频可以播放时结束加载状态。 */
    const onReady = () => setLoading(false);
    /** 当前选集准备好后自动播放一次；后续缓冲或拖动不改变用户的暂停选择。 */
    const onCanPlay = () => {
      if (disposed) return;
      onReady();
      if (!autoplayPending) return;
      autoplayPending = false;
      restore();
      void video.play().catch((reason: unknown) => {
        if (disposed) return;
        if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
          setPaused(true);
          setLoading(false);
          // 浏览器预览可能要求用户手势，保留中央播放按钮供手动开始。
        } else if (!(reason instanceof DOMException && reason.name === 'AbortError')) onError();
      });
    };
    /** 标记视频已经开始播放，保存进度并同步播放和控制栏状态。 */
    const onPlaying = () => { started = true; save(true); setLoading(false); setPaused(false); reveal(); startedCallback.current?.(); };
    /** 暂停时立即保存进度，并保持控制栏可见。 */
    const onPause = () => { save(true); setPaused(true); setVisible(true); };
    /** 视频缓冲等待时展示加载状态。 */
    const onWaiting = () => setLoading(true);
    /** 同步播放位置、总时长和当前缓冲区末端，并按间隔上报进度。 */
    const onTime = () => {
      save();
      setPosition(video.currentTime); setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      let end = video.currentTime;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) end = video.buffered.end(i);
      setBuffered(end);
    };
    /** 同步播放器音量和静音状态。 */
    const onVolume = () => { setVolume(video.volume); setMuted(video.muted); };
    /** 同步播放倍速，并立即上报进度以保存当前速度。 */
    const onRate = () => { setRate(video.playbackRate); save(true); };
    const events: [string, EventListener][] = [['loadedmetadata',restore],['durationchange',restore],['error',onError],['canplay',onCanPlay],['playing',onPlaying],['pause',onPause],['ended',onPause],['waiting',onWaiting],['seeking',onWaiting],['seeked',onReady],['timeupdate',onTime],['durationchange',onTime],['progress',onTime],['volumechange',onVolume],['ratechange',onRate]];
    events.forEach(([name,listener]) => video.addEventListener(name,listener));
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('mqtv-before-close', onBeforeClose);
    let hls: Hls | undefined;
    let received = 0;
    const sample = createDownloadRate();
    let measuring = false;
    setDownloadRate(null);
    /** 优先读取原生代理上游流量，其他 HLS 请求按 XHR 实收字节测速；停止加载后清除采样基线。 */
    async function measureDownload() {
      if (!loadingRef.current) { sample(null, performance.now()); return; }
      if (measuring) return;
      measuring = true;
      let bytes: number | null = null;
      try { if (isDesktop()) bytes = await readMediaDownloadedBytes(url); } catch { /* 流量不可读时显示未知，不影响播放。 */ }
      finally { measuring = false; }
      if (disposed) return;
      setDownloadRate(sample(bytes ?? (hls ? received : null), performance.now()));
    }

    if (/\.m3u8(?:[?#]|$)/i.test(url) && !video.canPlayType('application/vnd.apple.mpegurl') && Hls.isSupported()) {
      hls = new Hls({ xhrSetup: xhr => {
        let loaded = 0;
        xhr.addEventListener('progress', event => { received += Math.max(0, event.loaded - loaded); loaded = event.loaded; });
      } }); hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) onError(); });
      hls.loadSource(url); hls.attachMedia(video);
    } else video.src = url;
    void measureDownload();
    const downloadTimer = setInterval(() => void measureDownload(), 1000);
    return () => { clearInterval(downloadTimer); save(true); window.removeEventListener('pagehide', onLeave); window.removeEventListener('mqtv-before-close', onBeforeClose); disposed = true; clearTimeout(timer.current); events.forEach(([name,listener]) => video.removeEventListener(name,listener)); hls?.destroy(); video.pause(); video.removeAttribute('src'); video.load(); };
  }, [url, playbackKey]);
  return <>
    <div ref={stage} className={`player-stage controlled-player ${screenFullscreen ? 'player-screen-fullscreen' : ''} ${visible || paused || loading || error || navigation.error ? 'controls-visible' : ''}`} tabIndex={0} aria-label="影片播放器，空格播放暂停，左右键跳转，F 全屏，方括号切集" onMouseMove={reveal} onPointerLeave={reveal} onPointerDown={reveal} onKeyDown={event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
      const video=ref.current; if (!video) return;
      if (event.code==='Space') {event.preventDefault();void toggle();}
      else if (event.key==='ArrowLeft'||event.key==='ArrowRight') {event.preventDefault();seek(event.key==='ArrowRight'?10:-10);}
      else if (event.key==='[' || event.key===']') {event.preventDefault();if(!navigation.busy)(event.key==='['?navigation.previous:navigation.next)?.play();}
      else if (event.key.toLowerCase()==='m') {video.muted=!video.muted;reveal();}
      else if (event.key.toLowerCase()==='f') {event.preventDefault();void fullscreen();}
    }}>
      <video ref={ref} playsInline aria-label="影片画面" onClick={() => void toggle()} onDoubleClick={() => void fullscreen()} />
      <div className="player-heading"><div><strong title={title}>{title}</strong><span className="player-episode" title={episode}>{episode}</span></div></div>
      {(error || navigation.error) && <OperationMessage severity="error">{error || navigation.error || ''}</OperationMessage>}
      {navigation.busy && <div className="player-status" role="status"><div><CircularProgress size={22} /><span>正在准备播放…</span><span className="player-download-rate">{downloadRateText(downloadRate)}</span></div></div>}
      {loading && !navigation.busy && !error && <div className="player-status" role="status"><div><CircularProgress size={22} /><span>正在加载视频…</span><span className="player-download-rate">{downloadRateText(downloadRate)}</span></div></div>}
      {paused && !loading && !navigation.busy && !error && <button className="player-center-play" aria-label="继续播放" onClick={() => void toggle()}><PlayIcon /><span>继续播放</span></button>}
      <div className="media-controls" aria-label="播放控制" onFocus={reveal}>
        <div className="media-seek"><span style={{width:`${duration ? buffered/duration*100 : 0}%`}}/><input aria-label="播放进度" type="range" min="0" max={duration||0} step="0.1" value={position} disabled={!duration} style={{background:`linear-gradient(to right, #f1f4f7 ${duration ? position/duration*100 : 0}%, transparent 0)`}} onChange={e=>{if(ref.current) ref.current.currentTime=Number(e.target.value);setPosition(Number(e.target.value));reveal();}}/></div>
        <div className="media-toolbar">
          <button className="media-play-toggle" aria-label={paused?'播放':'暂停'} title={paused?'播放（空格）':'暂停（空格）'} onClick={()=>void toggle()}>{paused?<PlayIcon/>:<PauseIcon/>}</button>
          <button aria-label="上一集" title={navigation.previous ? `上一集：${navigation.previous.name}（[）` : '已是第一集或当前线路无上一集'} disabled={!navigation.previous || navigation.busy} onClick={()=>navigation.previous?.play()}><PreviousIcon/></button>
          <button aria-label="下一集" title={navigation.next ? `下一集：${navigation.next.name}（]）` : '已是最后一集或当前线路无下一集'} disabled={!navigation.next || navigation.busy} onClick={()=>navigation.next?.play()}><NextIcon/></button>
          <span className="media-divider"/>
          <button className="media-skip" aria-label="后退 10 秒" disabled={!duration} onClick={()=>seek(-10)}><ReplayIcon/></button>
          <button className="media-skip" aria-label="快进 10 秒" disabled={!duration} onClick={()=>seek(10)}><ForwardIcon/></button>
          <button aria-label={muted?'取消静音':'静音'} title="静音（M）" onClick={()=>{if(ref.current)ref.current.muted=!muted;}}>{muted||volume===0?<MuteIcon/>:<VolumeIcon/>}</button>
          <input className="media-volume" aria-label="音量" type="range" min="0" max="1" step="0.01" value={muted?0:volume} onChange={e=>{if(ref.current){ref.current.volume=Number(e.target.value);ref.current.muted=false;}}}/>
          <span className="media-time">{time(position)} <span>/ {time(duration)}</span></span>
          <div className="media-spacer"/>
          <select aria-label="播放速度" value={rate} onChange={e=>{if(ref.current)ref.current.playbackRate=Number(e.target.value);}}>{[0.5,0.75,1,1.25,1.5,1.75,2].map(value=><option key={value} value={value}>{value}×</option>)}</select>
          {document.pictureInPictureEnabled && <button aria-label="画中画" title="画中画" onClick={()=>void pictureInPicture()}><PipIcon/></button>}
          <button aria-label={isFullscreen || screenFullscreen ? "退出全屏" : "全屏"} title="切换全屏（F）" onClick={()=>void fullscreen()}>{isFullscreen || screenFullscreen ? <FullscreenExitIcon/> : <FullscreenIcon/>}</button>
        </div>
      </div>
    </div>

  </>;
}
