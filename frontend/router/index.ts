import { useState } from 'react';
import HomeIcon from '@mui/icons-material/HomeRounded';
import MovieIcon from '@mui/icons-material/MovieOutlined';
import TvIcon from '@mui/icons-material/TvRounded';
import AnimeIcon from '@mui/icons-material/AutoAwesomeRounded';
import VarietyIcon from '@mui/icons-material/MicNoneRounded';

export const channels = [
  { id: 'recommended', label: '推荐', icon: HomeIcon },
  { id: 'movie', label: '电影', icon: MovieIcon },
  { id: 'tv', label: '电视剧', icon: TvIcon },
  { id: 'anime', label: '动漫', icon: AnimeIcon },
  { id: 'variety', label: '综艺', icon: VarietyIcon },
] as const;
export type Channel = typeof channels[number]['id'];
export type Page = Channel | 'search' | 'settings' | 'history';
export type SettingsTab = 'basic' | 'resources' | 'authorizations';

// Preserve in-memory navigation so search state survives visiting another page.
/** 管理内存页面与设置标签状态，让搜索结果在切页后继续保留。 */
export function useNavigation() {
  const [page, setPage] = useState<Page>('recommended');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('basic');
  /** 切换到指定页面并将窗口滚动位置重置到顶部。 */
  function navigate(next: Page) {
    setPage(next);
    window.scrollTo({ top: 0 });
  }
  return { page, settingsTab, setSettingsTab, navigate };
}
