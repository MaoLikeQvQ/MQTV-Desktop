import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import { useRef, useState } from 'react';
import { Button, CircularProgress } from '@mui/material';
import type { Feed, Source } from '@/domain/media/media';
import { scriptLanguage, scriptSourceIdentity } from '@/domain/resources/script-source';
import { inspectScriptSource } from '@/api/scripts';

/** 展示脚本运行环境与手动更新入口；正常调用自动准备内容，无需授权。 */
export function ScriptSettings({ feed, busy, statuses, onChange }: {
  feed: Feed | null; busy: boolean; statuses: Record<string, { ready: boolean; reason: string }>;
  onChange: () => Promise<void>;
}) {
  const lock = useRef(false);
  const notify = useOperationMessage();
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const sources = feed?.sites.filter(source => scriptLanguage(source)) ?? [];
  /** 下载并检查脚本及依赖，成功后刷新状态并提示文件数量，检查本身不执行脚本。 */
  async function inspect(source: Source) {
    if (busy || lock.current) return;
    lock.current = true;
    setWorking(source.key); setError('');
    try {
      const inspection = await inspectScriptSource(source);
      await onChange();
      notify(`脚本检查完成，共 ${inspection.files} 个文件，无需授权。`, 'success');
    }
    catch (reason) { setError('脚本检查失败：' + String(reason)); }
    finally { lock.current = false; setWorking(''); }
  }
  if (!sources.length) return null;
  return <section aria-label="脚本运行环境">
    <h2>JS / Python 插件</h2>
    <p>脚本无需授权，首次调用自动检查并缓存。重新检查可更新脚本内容。</p>
    {error && <OperationMessage severity="warning">{error}</OperationMessage>}
    <ul className="resource-entry-list">{sources.map(source => {
      const status = statuses[scriptSourceIdentity(source)];
      return <li key={source.key}><div className="resource-entry-main"><span className="resource-entry-url">{source.name}</span><span>{scriptLanguage(source) === 'python' ? 'Python' : 'JS'} · {status?.ready ? '已就绪' : status?.reason || '待检查运行环境'}</span><Button size="small" disabled={busy || !!working} onClick={() => void inspect(source)}>{working === source.key ? <CircularProgress size={16} /> : status?.ready ? '重新检查' : '检查脚本'}</Button></div></li>;
    })}</ul>

  </section>;
}
