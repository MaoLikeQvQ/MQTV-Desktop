import { normalizeSearchKeyword } from '@/domain/search/search-keyword';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mui/material';
import SearchIcon from '@mui/icons-material/SearchRounded';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import { readSearchSuggestions } from '@/services/search-suggestions';
import { isDesktop } from '@/platform/desktop';

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: (term: string) => void;
  history: string[];
  onHistoryChange: (history: string[]) => void;
  busy: boolean;
  searching: boolean;
};

/** 在原搜索框下展开历史和输入联想；点击词条立即搜索，离开面板或按 Escape 收起。 */
export function SearchBox({ query, onQueryChange, onSearch, history, onHistoryChange, busy, searching }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (!open) return;
    /** 点击搜索区域外部时关闭面板，不影响页面原有点击行为。 */
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => {
    setSuggestions([]); setError(''); setLoading(false);
    const keyword = normalizeSearchKeyword(query);
    if (!open || !isDesktop() || !keyword || composing) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void readSearchSuggestions(keyword).then(items => {
        if (active) setSuggestions(items);
      }).catch(() => {
        if (active) setError('关键词联想暂不可用');
      }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [open, query, composing, retry]);
  /** 复用原有搜索入口，提交时收起下拉并同步输入框。 */
  function submit(term: string) {
    const keyword = normalizeSearchKeyword(term);
    if (busy || !keyword) return;
    onQueryChange(keyword); setOpen(false); onSearch(keyword);
  }
  /** 显式重试当前输入的联想请求。 */
  function retrySuggestions() {
    setRetry(value => value + 1);
  }
  return <div className="top-search" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
    <form className="search-form" onSubmit={event => { event.preventDefault(); submit(query); }}>
      <SearchIcon /><input aria-label="搜索影片" placeholder="搜索电影、剧集、动漫…" value={query} autoComplete="off"
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        aria-expanded={open} aria-controls={open ? 'search-suggestions' : undefined}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { onQueryChange(event.target.value); setOpen(true); }} />
      <Button variant="contained" type="submit" disabled={busy || !normalizeSearchKeyword(query)}>{searching ? '搜索中' : '搜索'}</Button>
    </form>
    {open && <div id="search-suggestions" className="search-suggestions">
      <section aria-labelledby="search-history-heading">
        <div className="search-suggestion-heading"><h2 id="search-history-heading"><HistoryIcon />历史搜索</h2>
          {history.length > 0 && <Button size="small" onClick={() => onHistoryChange([])}>清空</Button>}</div>
        <div className="search-keywords">{history.map(term => <span className="search-history-word" key={term}>
          <Button size="small" disabled={busy} onClick={() => submit(term)}>{term}</Button>
          <button type="button" className="search-word-remove" aria-label={'删除搜索记录：' + term} onClick={() => onHistoryChange(history.filter(item => item !== term))}>×</button>
        </span>)}</div>
        {!history.length && <p className="search-suggestion-note">暂无搜索记录</p>}
      </section>
      <section aria-labelledby="search-association-heading">
        <div className="search-suggestion-heading"><h2 id="search-association-heading"><SearchIcon />搜索联想</h2></div>
        <div className="search-keywords">{suggestions.map(term => <Button size="small" key={term} disabled={busy} onClick={() => submit(term)}>{term}</Button>)}</div>
        {loading && !suggestions.length && <p className="search-suggestion-note" role="status">正在联想…</p>}
        {!isDesktop() && <p className="search-suggestion-note">请在桌面应用中使用搜索联想</p>}
        {error && <p className="search-suggestion-note" role="status">{error}<Button size="small" disabled={loading} onClick={retrySuggestions}>重试</Button></p>}
        {isDesktop() && !loading && !error && !suggestions.length && <p className="search-suggestion-note">{query.trim() ? '暂无相关联想' : '输入片名，显示相关联想'}</p>}
      </section>
    </div>}
  </div>;
}
