import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import { makeSearchQuality, submitSearchQuality, type SearchQualityEvent } from '@/services/search-quality';
import { EpisodeButton } from '@/views/player/components/EpisodeButton';
import { Synopsis } from '@/views/player/components/Synopsis';
import { initialWatchSource, orderWatchSources, synopsisText, withPlaybackPoster } from '@/domain/media/watch';
import { playableLines } from '@/domain/media/netdisk';
import { AdapterAuthorizationSettings } from '@/views/settings/AdapterAuthorizationSettings';
import { nativeAdapter } from '@/domain/resources/native-source';
import { canSearchCustomSource as isSearchable, type ValidatedResource } from '@/domain/resources/custom-feed';
import { RecentPlayback } from '@/views/history/RecentPlayback';
import { findHistoryEpisode, samePlaybackTarget, historyIdentity, readHistory, saveHistory, upsertHistory, historyVod, type PlaybackRecord, type PlaybackTarget, type PlaybackProgress } from '@/domain/history/history';
import CloudIcon from '@mui/icons-material/CloudOutlined';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import pawLogo from '@/assets/images/paw-mint.svg';
import { useEffect, useRef, useState } from 'react';
import { isDesktop, readSearchParallelism } from '@/platform/desktop';
import { readResourceFeed, readCustomResourceFeeds, persistCustomResourceState } from '@/services/resources';
import { searchSourceMedia, readSourceDetail, resolveSourcePlayback } from '@/services/scripts';
import { readScriptStatus } from '@/api/scripts';
import { scriptLanguage, scriptSourceIdentity, canSearchScriptSource } from '@/domain/resources/script-source';
import { ScriptSettings } from '@/views/settings/ScriptSettings';
import { readQuarkSettings } from '@/api/quark';
import { channels, useNavigation, type Channel, type Page } from '@/router';
import { Alert, Button, CircularProgress, Tooltip, Tabs, Tab } from '@mui/material';
import SearchIcon from '@mui/icons-material/SearchRounded';
import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import PlayIcon from '@mui/icons-material/PlayArrowRounded';
import ArrowBackIcon from '@mui/icons-material/ArrowBackRounded';
import ChevronRightIcon from '@mui/icons-material/ChevronRightRounded';
import VideoIcon from '@mui/icons-material/OndemandVideoRounded';
import { ResourceSettings } from '@/views/settings/ResourceSettings';
import { BasicSettings } from '@/views/settings/BasicSettings';
import { readCustomResources, saveCustomResources, type CustomResource } from '@/domain/resources/custom-resources';
import { QuarkSettings } from '@/views/settings/AuthorizationSettings';
import { QuarkFiles } from '@/views/player/components/QuarkFiles';
import { searchQuarkSource } from '@/services/quark-lines';
import { quarkLine } from '@/domain/resources/quark-lines';
import { Discovery } from '@/views/discovery/Discovery';
import { Player, type PlayerNavigation } from '@/views/player/Player';
import { TopProgress } from '@/views/shared/components/TopProgress';
import { PosterCard } from '@/views/search/components/PosterCard';
import { sourceShortName, parseEpisodes, parseFeed, type Feed, type Line, type Source, type Episode } from '@/domain/media/media';

import { deviceSearchConcurrency, canScoreSource, groupResults, observe, priority, readScores, saveScores, scoreIdentity, scoreValue, searchRelevance, searchSources, type Scores, type TitleGroup, type Vod } from '@/domain/search/search';

import { DEFAULT_RESOURCE_URL as DEFAULT_URL, resolveResourceUrl, readResourceCache, resourceCacheFresh } from '@/domain/resources/resource-cache';
const desktop = isDesktop();
/** 组合频道、搜索、详情、播放器、历史与设置页面，并协调跨页面状态。 */
function App() {
  const { page, settingsTab, setSettingsTab, navigate: navigatePage } = useNavigation();
  const historyRef = useRef<PlaybackRecord[]>([]);
  const historyReadable = useRef(true);
  const [historyError, setHistoryError] = useState('');
  const [history, setHistory] = useState<PlaybackRecord[]>([]);
  const [resumeRecord, setResumeRecord] = useState<PlaybackRecord | undefined>();
  const [cloudTarget, setCloudTarget] = useState<PlaybackTarget | undefined>();
  useEffect(() => {
    try { historyRef.current = readHistory(localStorage); setHistory(historyRef.current); }
    catch { historyReadable.current = false; setHistoryError('无法读取本机播放记录，原有数据已保留。'); }
  }, []);
  /** 保存新的播放历史，成功后同步内存和视图；失败时保留原记录并展示提示。 */
  function persistHistory(next: PlaybackRecord[]) {
    try {
      saveHistory(localStorage, next); historyRef.current = next; setHistory(next); setHistoryError('');
    } catch { setHistoryError('播放记录保存失败，请检查本机存储空间。'); }
  }
  const [customResources,setCustomResources]=useState(()=>readCustomResources(localStorage));
  const [url, setUrl] = useState(() => localStorage.getItem('mqtv-resource-mode') === 'default' ? DEFAULT_URL : resolveResourceUrl(localStorage.getItem('mqtv-feed-url')));
  const [resourceMode, setResourceMode] = useState<'default' | 'custom'>(() => localStorage.getItem('mqtv-resource-mode') === 'custom' ? 'custom' : url === DEFAULT_URL ? 'default' : 'custom');
  const [updatedAt, setUpdatedAt] = useState(() => readResourceCache(localStorage, url)?.updatedAt);
  const syncLock = useRef(false);
  const [feed, setFeed] = useState<Feed | null>(() => {
    try { return resourceMode === 'default' ? readResourceCache(localStorage, url)?.feed ?? null : parseFeed(JSON.parse(localStorage.getItem('mqtv-feed') || 'null')); } catch { return null; }
  });
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [results, setResults] = useState<Vod[]>([]);
  const [scores, setScores] = useState<Scores>(() => readScores(localStorage));
  const [scoreIds, setScoreIds] = useState<Record<string, string>>({});
  const [selectedGroup, setSelectedGroup] = useState<TitleGroup | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchLock = useRef(false);
  const [pageLoading, setPageLoading] = useState(false);
  const notify = useOperationMessage();
  /** 将操作结果立即交给全局消息浮层，重复操作也会产生独立提示。 */
  function setMessage(message: { text: string; error: boolean } | null) {
    if (message) notify(message.text, message.error ? 'warning' : 'success');
  }
  const [failures, setFailures] = useState(0);
  const [selected, setSelected] = useState<Vod | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [lineIndex, setLineIndex] = useState(0);
  const [playing, setPlaying] = useState<{ url: string; name: string; size?: number } | null>(null);
  const [cloudNavigation, setCloudNavigation] = useState<PlayerNavigation>({});
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [synopsis, setSynopsis] = useState('');
  // Invalidate a detail response when the user leaves or chooses another result.
  const detailRequest = useRef(0);
  const [scriptStatuses, setScriptStatuses] = useState<Record<string, { ready: boolean; reason: string }>>({});
  const scriptStatusRequest = useRef(0);
  const playRequest = useRef(0);
  const [playLoading, setPlayLoading] = useState(false);
  const [scriptShare, setScriptShare] = useState<string | null>(null);
  const [playingEpisode, setPlayingEpisode] = useState<Episode | null>(null);
  const busy = syncing || searching;
  /** 只有原生运行时和固定摘要授权均就绪的脚本来源可以参与搜索。 */
  function canSearch(source: Source): boolean {
    if (source.enabled === false) return false;
    return scriptLanguage(source) ? canSearchScriptSource(source, scriptStatuses) : isSearchable(source);
  }
  /** 按当前完整来源配置刷新运行时状态，忽略旧订阅的迟到响应。 */
  async function refreshScripts(): Promise<void> {
    const request = ++scriptStatusRequest.current;
    const sources = feed?.sites.filter(source => scriptLanguage(source)) ?? [];
    if (!desktop || !sources.length) { setScriptStatuses({}); return; }
    try {
      const status = await readScriptStatus(sources);
      if (request !== scriptStatusRequest.current) return;
      setScriptStatuses(Object.fromEntries(sources.map(source => {
        const item = status.sources.find(value => value.key === source.key);
        return [scriptSourceIdentity(source), { ready: item?.ready === true, reason: item?.reason || '脚本尚未就绪' }];
      })));
    } catch (reason) {
      if (request === scriptStatusRequest.current) setScriptStatuses(Object.fromEntries(sources.map(source => [scriptSourceIdentity(source), { ready: false, reason: '无法读取运行环境：' + String(reason) }])));
    }
  }
  useEffect(() => { void refreshScripts(); return () => { ++scriptStatusRequest.current; }; }, [feed]);
  const supported = feed?.sites.filter(canSearch).length ?? 0;
  const currentLine = lines[lineIndex];
  const playingLine = lines.find(line => line.episodes.some(item => item === playingEpisode));
  const playingIndex = playingLine?.episodes.findIndex(item => item === playingEpisode) ?? -1;
  const playbackTarget: PlaybackTarget | undefined = selected && (quarkLine(selected.source).sites.length || scriptShare) ? cloudTarget : playingLine && playing ? {
    line: playingLine.name, episode: playing.name, episodeIndex: playingIndex, episodeCount: playingLine.episodes.length, ...(selected && (scriptLanguage(selected.source) || nativeAdapter(selected.source)) ? { script: { id: playingEpisode!.url, flag: playingLine.name } } : { url: playingEpisode!.url }),
  } : undefined;
  const matchesResume = resumeRecord && playbackTarget && samePlaybackTarget(playbackTarget, resumeRecord.target);
  const initialProgress = matchesResume ? resumeRecord : undefined;
  const resourceIdentity = resourceMode === 'default' ? url : 'custom';
  /** 将播放器进度与当前影片及选集关联后更新历史，读取损坏时暂停写入以保留原数据。 */
  function recordProgress(progress: PlaybackProgress) {
    if (!selected || !playbackTarget || !historyReadable.current) return;
    const vod = historyVod(selected);
    persistHistory(upsertHistory(historyRef.current, {
      ...progress, id: historyIdentity(resumeRecord?.resource ?? resourceIdentity, vod),
      resource: resumeRecord?.resource ?? resourceIdentity, vod,
      group: { key: selectedGroup?.key ?? selected.vod_name, items: (selectedGroup?.items ?? [selected]).map(item => historyVod(historyIdentity('', item) === historyIdentity('', selected) ? selected : item)) },
      target: playbackTarget, updatedAt: Date.now(),
    }));
  }
  const navigation: PlayerNavigation = (selected && (quarkLine(selected.source).sites.length || scriptShare)) ? cloudNavigation : {
    previous: playingLine && playingIndex > 0 ? { name: playingLine.episodes[playingIndex - 1].name, play: () => void playEpisode(playingLine.episodes[playingIndex - 1], playingLine) } : undefined,
    next: playingLine && playingIndex >= 0 && playingIndex < playingLine.episodes.length - 1 ? { name: playingLine.episodes[playingIndex + 1].name, play: () => void playEpisode(playingLine.episodes[playingIndex + 1], playingLine) } : undefined,
  };
  const mediaNavigation: PlayerNavigation = { ...navigation, busy: navigation.busy || playLoading || detailLoading, error: navigation.error || detailError };
  /** 解析原始选集身份再切换媒体，防止迟到的播放结果覆盖新影片或新选集。 */
  async function playEpisode(episode: Episode, line: Line, source = selected?.source, flags = lines.map(value => value.name)): Promise<void> {
    if (!source) return;
    const request = ++playRequest.current;
    const detail = detailRequest.current;
    setPlayLoading(true); setDetailError('');
    try {
      const mediaUrl = await resolveSourcePlayback(source, line.name, episode.url, flags);
      if (request !== playRequest.current || detail !== detailRequest.current) return;
      setPlayingEpisode(episode);
      const resolved = new URL(mediaUrl);
      if (resolved.protocol === 'https:' && resolved.hostname === 'pan.quark.cn' && resolved.pathname.startsWith('/s/')) {
        setPlaying(null); setScriptShare(mediaUrl); setCloudTarget(undefined);
      } else { setScriptShare(null); setCloudTarget(undefined); setPlaying({ name: episode.name, url: mediaUrl }); }
    } catch (reason) {
      if (request === playRequest.current && detail === detailRequest.current) setDetailError('播放解析失败：' + String(reason));
    } finally { if (request === playRequest.current) setPlayLoading(false); }
  }
  const remainingResults = groupResults(results);
  /** 为可评分来源生成界面标签，区分已有评分和暂无样本。 */
  const scoreLabel = (source: Source) => {
    if (!canScoreSource(resourceMode, url, source)) return '';
    const score = scores[scoreIds[source.key]], value = scoreValue(score);
    return value === null ? '暂无评分' : value.toFixed(1) + ' 分 · ' + score.samples + ' 次';
  };

  /**
   * 同步默认或自定义资源，处理缓存、授权后台及界面状态，防止并发重复同步。
   * @param address 默认资源请求地址。
   * @param notify 是否展示连接成功提示。
   * @param mode 要切换或同步的资源模式。
   * @param forceRefresh 是否跳过默认资源缓存，主动获取最新资源。
   * @returns 是否同步成功；请求和保存完成后弹出结果消息。
   */
  async function sync(address = url, notify = true, mode = resourceMode, forceRefresh = false) {
    if (!desktop || syncLock.current) return false;
    syncLock.current = true;
    setSyncing(true); setMessage(null);
    try {
      if (mode === 'custom') {
        const result=await readCustomResourceFeeds(readCustomResources(localStorage));
        saveCustomResources(localStorage,result.entries);setCustomResources(result.entries);
        localStorage.setItem('mqtv-feed',JSON.stringify(result.feed));
        localStorage.setItem('mqtv-resource-mode','custom');
        setResourceMode('custom');setFeed(result.feed);setResults([]);setSubmittedQuery('');
        return true;
      }
      const result = await readResourceFeed(localStorage, address, mode === 'default' && !forceRefresh);
      const next = result.feed;
      await readQuarkSettings(address);
      localStorage.setItem('mqtv-feed', JSON.stringify(next));
      localStorage.setItem('mqtv-feed-url', address);
      localStorage.setItem('mqtv-resource-mode', mode);
      if (address !== url) { setResults([]); setSubmittedQuery('');  }
      setFeed(next); setUrl(address); setResourceMode(mode); setUpdatedAt(result.updatedAt);
      if (notify) setMessage({ text: forceRefresh ? `默认资源已更新，共 ${next.count} 个来源。` : '资源已切换。', error: false });
      return true;
    } catch (error) { setMessage({ text: '连接播放服务失败：' + String(error), error: true }); return false; }
    finally { syncLock.current = false; setSyncing(false); }
  }
  /** 请求并合并订阅后提交配置；新地址复用添加时已验证的数据，保存失败向调用方报告。 */
  async function updateCustomResources(entries:CustomResource[], validated?:ValidatedResource) {
    if (syncLock.current) throw new Error('资源正在同步，请稍后重试');
    syncLock.current=true;setSyncing(true);
    try {
      const result=await readCustomResourceFeeds(entries,validated);
      persistCustomResourceState(localStorage,result);
      setCustomResources(result.entries);setFeed(result.feed);setResourceMode('custom');
      setResults([]);setSubmittedQuery('');
    } finally {syncLock.current=false;setSyncing(false);}
  }
  useEffect(() => { if (desktop) void sync(url, false); }, []);
  useEffect(() => {
    if (!desktop || resourceMode !== 'default') return;
    /** 页面恢复可见或定时检查时刷新超过七天有效期的默认资源。 */
    const check = () => {
      if (!document.hidden && !resourceCacheFresh(readResourceCache(localStorage, DEFAULT_URL))) void sync(DEFAULT_URL, false, 'default');
    };
    const timer = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [resourceMode, url]);

  /** 调度多来源搜索并增量展示结果，同时更新允许评分来源的耗时与相关度统计。 */
  async function search(term = query) {
    if (!term.trim() || busy || searchLock.current) return;
    if (!desktop || !feed || !supported) {
      setMessage({ text: !desktop ? '请在桌面应用中搜索影片。' : !feed ? '资源尚未加载，请到设置中的资源服务检查订阅。' : '当前订阅没有已适配且允许搜索的线路，请检查资源服务。', error: true });
      return;
    }
    searchLock.current = true;
    setSearching(true); setResults([]);  setFailures(0); setMessage(null); setSubmittedQuery(term.trim());
    try {
      const identities = await Promise.all(feed.sites.filter(canSearch).map(async source => ({ source, id: canScoreSource(resourceMode, url, source) ? await scoreIdentity(url, source) : null })));
      setScoreIds(Object.fromEntries(identities.flatMap(item => item.id ? [[item.source.key, item.id]] : [])));
      identities.sort((a, b) => (b.id ? priority(scores[b.id]) : priority()) - (a.id ? priority(scores[a.id]) : priority()));
      let parallelism: number;
      try { parallelism = await readSearchParallelism(); }
      catch {
        parallelism = navigator.hardwareConcurrency || 2;
        setMessage({ text: '无法读取系统并行能力，已按 WebView 报告的处理器能力安排搜索。', error: true });
      }
      const concurrency = deviceSearchConcurrency(parallelism);
      const nextScores = { ...scores };
      const qualityEvents: SearchQualityEvent[] = [];
      const ids = new Map(identities.map(item => [item.source, item.id]));
      await searchSources(identities.map(item => item.source), async source => {
        const start = performance.now();
        let matches: Vod[];
        try {
          const cloud = quarkLine(source);
          if (cloud.sites.length) {
            const data = await searchQuarkSource(source, term.trim());
            matches = data.map(v => ({ vod_id: v.url, vod_name: v.title, vod_pic: v.poster, vod_remarks: v.remarks || '夸克网盘', type_name: v.category, vod_year: v.year, source }));
          } else {
            matches = await searchSourceMedia(source, term);
          }
        } catch (error) {
          const id = ids.get(source);
          if (id) {
            const previous = nextScores[id]; delete nextScores[id];
            nextScores[id] = observe(previous, performance.now() - start, false, null);
            qualityEvents.push(makeSearchQuality(source.key, performance.now() - start, false, term, []));
          }
          throw error;
        }
        const id = ids.get(source);
        if (id) {
          const previous = nextScores[id]; delete nextScores[id];
          nextScores[id] = observe(previous, performance.now() - start, true, searchRelevance(term, matches.map(item => item.vod_name)));
          qualityEvents.push(makeSearchQuality(source.key, performance.now() - start, true, term, matches.map(item => item.vod_name)));
        }
        return matches;
      }, concurrency, (settled, completed) => {
        // Like TV, weights determine dispatch; cards append in arrival order.
        if (completed.status === 'fulfilled') setResults(previous => [...previous, ...completed.value]);
        setFailures(settled.filter(result => result?.status === 'rejected').length);
        setScores({ ...nextScores });
      });
      setScores(nextScores);
      void submitSearchQuality(qualityEvents).catch(() => console.warn('搜索评分暂未上报成功，本机评分已保留'));
      try { if (identities.some(item => item.id)) saveScores(localStorage, nextScores); }
      catch { setMessage({ text: '本次评分已更新，但本机存储写入失败，重启后可能丢失。', error: true }); }
    } catch (error) { setMessage({ text: '搜索失败：' + String(error), error: true }); }
    finally { searchLock.current = false; setSearching(false); }
  }

  /**
   * 优先复用搜索结果的简介和有效播放列表，缺少选集时请求详情；忽略过期响应并恢复历史选集。
   * @param vod 要打开的影片及来源。
   * @param group 当前同名影片分组。
   * @param resume 可选历史记录，用于匹配上次观看选集。
   */
  async function open(vod: Vod, group = selectedGroup, resume?: PlaybackRecord) {
    resume ??= historyRef.current.find(record => record.id === historyIdentity(resourceIdentity, vod));
    group ??= resume?.group ?? null;
    vod = withPlaybackPoster(vod, [...(group?.items ?? []), ...(resume ? [resume.vod] : [])]);
    const searchSynopsis = synopsisText(vod.vod_content);
    setSynopsis(searchSynopsis);
    ++playRequest.current; setPlayLoading(false); setPlayingEpisode(null); setScriptShare(null);
    setResumeRecord(resume); setCloudTarget(undefined); setCloudNavigation({});
    setSelectedGroup(group);
    const request = ++detailRequest.current;
    setSelected(vod); setLines([]); setLineIndex(0); setPlaying(null); setDetailError(''); setDetailLoading(true);
    window.scrollTo({ top: 0 });
    if (quarkLine(vod.source).sites.length) { setDetailLoading(false); return; }
    try {
      if (request !== detailRequest.current) return;
      const allowOpaqueIds = !!(scriptLanguage(vod.source) || nativeAdapter(vod.source));
      let parsed = playableLines(parseEpisodes(String(vod.vod_play_from || ''), String(vod.vod_play_url || ''), allowOpaqueIds));
      if (!parsed.length) {
        const data = await readSourceDetail(vod.source, String(vod.vod_id));
        if (request !== detailRequest.current) return;
        if (!Array.isArray(data.list) || !data.list[0]) throw new Error('详情响应格式无效');
        parsed = playableLines(parseEpisodes(String(data.list[0].vod_play_from || ''), String(data.list[0].vod_play_url || ''), allowOpaqueIds));
        setSynopsis(synopsisText(data.list[0].vod_content) || searchSynopsis);
        const poster = data.list[0].vod_pic;
        setSelected({ ...vod, vod_content: synopsisText(data.list[0].vod_content) || searchSynopsis,
          vod_pic: typeof poster === 'string' && poster.trim() ? poster : vod.vod_pic });
      }
      setLines(parsed);
      if (resume) {
        const match = findHistoryEpisode(parsed, resume.target);
        if (match) { setLineIndex(match.lineIndex); await playEpisode(match.episode, parsed[match.lineIndex], vod.source, parsed.map(line => line.name)); }
        else setDetailError('上次观看的线路或集数已不可用，请重新选择线路和集数。');
      }
      if (!resume && parsed[0]?.episodes[0]) await playEpisode(parsed[0].episodes[0], parsed[0], vod.source, parsed.map(line => line.name));
      if (!parsed.length) setDetailError('这个来源没有可直接播放的线路，请返回搜索其他来源。');
    } catch (error) {
      if (request === detailRequest.current) setDetailError('获取详情失败：' + String(error));
    } finally { if (request === detailRequest.current) setDetailLoading(false); }
  }

  /** 切换页面并使未完成的详情请求失效，按目标页面清理播放状态。 */
  function navigate(next: Page) {
    ++detailRequest.current; ++playRequest.current; setPlayLoading(false); setPlayingEpisode(null); setScriptShare(null);
    setSelected(null); setPlaying(null); setDetailLoading(false); navigatePage(next);
  }

  return <div className={`app-shell ${selected ? 'watch-shell' : ''}`}>
    <aside className="sidebar" aria-label="主导航">
      <div className="brand"><img src={pawLogo} alt="MQTV 猫爪标志" /><span className="brand-name">MQ<span>TV</span></span></div>
      <p className="nav-caption">我的放映室</p>
      <nav>{channels.map(item => <Tooltip title={item.label} placement="right" key={item.id}>
        <button className={`nav-item ${page === item.id ? 'active' : ''}`} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
          <item.icon /><span>{item.label}</span>
        </button>
      </Tooltip>)}
        <Tooltip title="最近播放" placement="right"><button className={`nav-item ${page === 'history' ? 'active' : ''}`} aria-label="最近播放" aria-current={page === 'history' ? 'page' : undefined} onClick={() => navigate('history')}><HistoryIcon /><span>最近播放</span></button></Tooltip>
      </nav>
      <div className="sidebar-bottom">
        <Tooltip title="设置" placement="right"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-label="设置" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><SettingsIcon /><span>设置</span></button></Tooltip>
        <p className="sidebar-note">MQTV · 桌面版 0.1.0</p>
      </div>
    </aside>
    <main className="workspace">
      <div className="workspace-header">
        {selected ? <header className="watch-topbar">
          <Button aria-label={page === 'history' ? '返回最近播放' : '返回搜索'} color="inherit" onClick={() => navigate(page === 'history' ? 'history' : 'search')}><ArrowBackIcon /></Button>
          <div className="watch-brand"><span className="watch-logo"><PlayIcon /></span><strong>MQTV</strong></div>
          <h1>{selected.vod_name}</h1>
        </header> : page === 'settings' ? <header className="settings-topbar"><Tabs value={settingsTab} onChange={(_, value) => setSettingsTab(value)} aria-label="设置分类"><Tab value="basic" label="基础设置" id="settings-basic" aria-controls="settings-content" /><Tab value="resources" label="资源服务" id="settings-resources" aria-controls="settings-content" /><Tab value="authorizations" label="授权管理" id="settings-authorizations" aria-controls="settings-content" /></Tabs></header> : page === 'history' ? null : <header className="topbar">
          <div className="top-search">
            <form className="search-form" onSubmit={event => { event.preventDefault(); navigate('search'); void search(); }}>
              <SearchIcon /><input aria-label="搜索影片" placeholder="搜索电影、剧集、动漫…" value={query} onChange={event => setQuery(event.target.value)} />
              <Button variant="contained" type="submit" disabled={busy || !query.trim()}>{searching ? '搜索中' : '搜索'}</Button>
            </form>
          </div>
        </header>}
        <TopProgress active={searching || syncing || detailLoading || playLoading || pageLoading} />
      </div>
      {selected ? <section className="page watch-page page-enter" key="watch" aria-label="影片播放">
        <div className="watch-layout">
          <div className="watch-primary">
            {playing ? <Player playbackKey={JSON.stringify([selected.source.key, selected.vod_id, playbackTarget])} initialProgress={initialProgress} onProgress={recordProgress} url={playing.url} title={selected.vod_name} episode={playing.name} navigation={mediaNavigation} /> : <div className="player-stage"><div className="player-empty">
              {mediaNavigation.busy ? <CircularProgress size={30} /> : <VideoIcon />}
              <span role={mediaNavigation.busy ? 'status' : undefined}>{mediaNavigation.busy ? '正在准备播放…' : mediaNavigation.error ? '暂时无法播放此来源，请切换来源或重试' : '暂无可播放视频'}</span>
            </div></div>}
            <div className="watch-information"><h2>{selected.vod_name}</h2><p className="watch-metadata">{[selected.type_name, selected.vod_year, selected.vod_remarks].filter(Boolean).join(' · ')}</p>{synopsis && <Synopsis key={synopsis} text={synopsis} />}</div>
            {historyError && <OperationMessage severity="warning">{historyError}</OperationMessage>}
            {detailError && <OperationMessage severity="warning">{detailError}</OperationMessage>}
          </div>
          <aside className="episode-panel cloud-panel" aria-label="线路与选集">
            <details key={historyIdentity('', selected)} className="watch-disclosure watch-sources"><summary><span>播放来源</span><span className="watch-current-source" title={selected.source.name}>{sourceShortName(selected.source.name)}</span></summary>
            <div className="line-switcher">{orderWatchSources(selectedGroup?.items ?? [selected]).map((item, index) => <Button disabled={detailLoading || playLoading} key={JSON.stringify([item.source.key, item.vod_id])} size="small" variant={historyIdentity('', item) === historyIdentity('', selected) ? 'contained' : 'outlined'} aria-pressed={historyIdentity('', item) === historyIdentity('', selected)} startIcon={quarkLine(item.source).sites.length > 0 ? <CloudIcon titleAccess="网盘资源" /> : undefined} title={[item.source.name, scoreLabel(item.source) ? '搜索评分：' + scoreLabel(item.source) : ''].filter(Boolean).join('\n')} onClick={() => void open(item)}>{sourceShortName(item.source.name)}{(selectedGroup?.items.filter(v => v.source.key === item.source.key).length ?? 0) > 1 ? ' · ' + (index + 1) : ''}</Button>)}</div></details>
          {(quarkLine(selected.source).sites.length > 0 || scriptShare) && <QuarkFiles key={JSON.stringify([selected.source.key, selected.vod_id, scriptShare])} detailUrl={scriptShare || String(selected.vod_id)} directShare={!!scriptShare} onSynopsis={setSynopsis} onNavigation={setCloudNavigation} resume={resumeRecord?.target} onPlay={(url, name, size, target) => { setCloudTarget(scriptShare && playingEpisode && playingLine ? { ...target, script: { id: playingEpisode.url, flag: playingLine.name } } : target); setPlaying({url, name, size}); }} />}
          {!quarkLine(selected.source).sites.length && <>
            <h2>线路与选集</h2>
            {!detailLoading && !lines.length && <p className="episode-hint">暂无可播放选集</p>}
            {!!lines.length && <>
              <div className="line-switcher playback-lines">{lines.map((line, index) => <Button disabled={detailLoading || playLoading} key={index} size="small" variant={index === lineIndex ? 'contained' : 'text'} color={index === lineIndex ? 'primary' : 'inherit'} aria-pressed={index === lineIndex} onClick={() => setLineIndex(index)}>{line.name}</Button>)}</div>
              <div className="episode-count"><span>全部选集</span><span>{currentLine?.episodes.length ?? 0} 集</span></div>
              <div className="episode-grid">{currentLine?.episodes.map((episode, index) => <EpisodeButton key={index} number={index+1} name={episode.name} active={playingEpisode === episode} disabled={playLoading} onClick={() => void playEpisode(episode, currentLine!)} />)}</div>
              <p className="episode-hint">播放不顺畅时，可以尝试其他线路。</p>
            </>}
          </>}
          </aside>
        </div>
      </section> : <section className={`page page-enter ${page === 'search' ? 'search-page' : page === 'settings' ? 'settings-page' : ''}`} key={page}>
        {page === 'settings' && <>
          <h1>{settingsTab === 'basic' ? '基础设置' : settingsTab === 'resources' ? '资源服务' : '授权管理'}</h1><p className="page-description">{settingsTab === 'basic' ? '查看当前版本并检查更新。' : settingsTab === 'resources' ? '配置影片资源服务地址。' : '管理保存在本机的网盘授权。'}</p>
        </>}
        {page === 'history' && <RecentPlayback records={history} onResume={record => void open(record.vod, null, record)} onRemove={id => persistHistory(historyRef.current.filter(item => item.id !== id))} />}
        <div className="search-feedback" aria-live="polite">
          {!desktop && <Alert severity="info">当前为浏览器预览。推荐、搜索与播放请使用 MQTV 桌面应用。</Alert>}
          {historyError && <OperationMessage severity="warning">{historyError}</OperationMessage>}
          {page === 'search' && !searching && !results.length && failures > 0 && <OperationMessage severity="warning">搜索暂时未能完成，请重试或检查资源配置。</OperationMessage>}
        </div>
        {page === 'search' && <>
          <div className="search-summary" aria-live="polite"><h2>全部</h2><span>共 {remainingResults.length} 部</span></div>
          {results.length ? <>
            <div className="result-grid">{remainingResults.map(group => <PosterCard key={group.key} item={group.items[0]} count={group.items.length} onOpen={() => { const first = initialWatchSource(group.items, historyRef.current, resourceIdentity); if (first) void open(first.vod, group, first.resume); }} />)}</div>
          </> : searching ? <div className="search-loading" role="status" aria-label="正在搜索影片"><div className="search-loading-mark"><CircularProgress size={68} thickness={1.5} aria-hidden="true" /><img src={pawLogo} alt="" /></div></div> : <div className="empty-state">
            <div className="empty-art" aria-hidden="true">{submittedQuery ? <SearchIcon /> : <img src={pawLogo} alt="" />}</div>
            <h2>{submittedQuery ? failures ? '暂未获得搜索结果' : '没有找到相关影片' : feed && !supported ? '当前配置没有可搜索的来源' : '想看的故事，就从片名开始'}</h2>
            <p>{submittedQuery ? '试试更短的片名，或检查资源后重新搜索。' : feed && !supported ? '暂时无法搜索，请稍后重试或检查设置。' : '输入影片名称，搜索已接入的来源。找到之后，选一集就能进入播放页面。'}</p>
            {(!feed || !supported) && <Button color="inherit" endIcon={<ChevronRightIcon />} onClick={() => navigate('settings')}>打开设置</Button>}
          </div>}
        </>}
        {channels.some(item => item.id === page) && <Discovery onLoadingChange={setPageLoading} channel={page as Channel} disabled={busy} onPick={title => { setQuery(title); navigate('search'); void search(title); }} />}
        {page === 'settings' && settingsTab === 'basic' && <BasicSettings />}
        {page === 'settings' && settingsTab === 'resources' && <ResourceSettings mode={resourceMode} busy={busy || !desktop} count={feed?.count} updatedAt={updatedAt} entries={customResources} onMode={mode=>sync(DEFAULT_URL,false,mode)} onRefresh={()=>sync(DEFAULT_URL,true,'default',true)} onChange={updateCustomResources} />}
        {page === 'settings' && settingsTab === 'resources' && <ScriptSettings feed={feed} busy={busy || !desktop} statuses={scriptStatuses} onChange={refreshScripts} />}
        {page === 'settings' && settingsTab === 'authorizations' && <><QuarkSettings /><AdapterAuthorizationSettings feed={feed} disabled={busy || !desktop} /></>}
      </section>}
      <footer className="page-footer"><span>MQTV · 每一个好故事，都值得被发现。</span><span>桌面版 0.1.0</span></footer>
    </main>
  </div>;
}
export default App;
