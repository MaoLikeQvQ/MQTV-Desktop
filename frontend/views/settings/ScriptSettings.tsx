import { OperationMessage, useOperationMessage } from '@/views/shared/components/OperationMessage';
import { useRef, useState } from 'react';
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import type { Feed, Source } from '@/domain/media/media';
import { scriptLanguage, scriptSourceIdentity } from '@/domain/resources/script-source';
import { inspectScriptSource, trustScriptSource, type ScriptInspection } from '@/api/scripts';

/** 展示脚本来源就绪状态，检查内容后由用户明确授权固定摘要，失败保持未授权。 */
export function ScriptSettings({ feed, busy, statuses, onChange }: {
  feed: Feed | null; busy: boolean; statuses: Record<string, { ready: boolean; reason: string }>;
  onChange: () => Promise<void>;
}) {
  const lock = useRef(false);
  const notify = useOperationMessage();
  const [pending, setPending] = useState<{ source: Source; inspection: ScriptInspection } | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const sources = feed?.sites.filter(source => scriptLanguage(source)) ?? [];
  /** 下载并检查脚本及依赖，在成功后展示内容摘要，检查本身不执行脚本。 */
  async function inspect(source: Source) {
    if (busy || lock.current) return;
    lock.current = true;
    setWorking(source.key); setError('');
    try {
      const inspection = await inspectScriptSource(source);
      await onChange();
      setPending({ source, inspection });
    }
    catch (reason) { setError('脚本检查失败：' + String(reason)); }
    finally { lock.current = false; setWorking(''); }
  }
  /** 仅信任弹窗中已检查的脚本摘要，随后刷新原生就绪状态。 */
  async function trust() {
    if (!pending || busy || lock.current) return;
    lock.current = true;
    setWorking(pending.source.key); setError('');
    try { await trustScriptSource(pending.source, pending.inspection.digest); await onChange(); setPending(null); notify('脚本已授权并启用。', 'success'); }
    catch (reason) { setError('脚本授权失败：' + String(reason)); }
    finally { lock.current = false; setWorking(''); }
  }
  if (!sources.length) return null;
  return <section aria-label="脚本运行环境">
    <h2>JS / Python 插件</h2>
    <p>仅已检查并授权的脚本参与搜索。脚本内容变更后需要重新检查。</p>
    {error && <OperationMessage severity="warning">{error}</OperationMessage>}
    <ul className="resource-entry-list">{sources.map(source => {
      const status = statuses[scriptSourceIdentity(source)];
      return <li key={source.key}><div className="resource-entry-main"><span className="resource-entry-url">{source.name}</span><span>{scriptLanguage(source) === 'python' ? 'Python' : 'JS'} · {status?.ready ? '已就绪' : status?.reason || '待检查运行环境'}</span><Button size="small" disabled={busy || !!working} onClick={() => void inspect(source)}>{working === source.key ? <CircularProgress size={16} /> : status?.ready ? '重新检查' : '检查脚本'}</Button></div></li>;
    })}</ul>
    <Dialog open={!!pending} onClose={() => { if (!working) setPending(null); }} aria-labelledby="script-trust-title">
      <DialogTitle id="script-trust-title">授权运行 {pending?.source.name}</DialogTitle>
      <DialogContent>
        <p>已检查 {pending?.inspection.files} 个脚本文件。授权后，应用可在本机执行这些固定内容。</p>
        <p style={{ overflowWrap: 'anywhere' }}>内容摘要：{pending?.inspection.digest}</p>
        <Alert severity="warning">{pending?.inspection.language === 'python' ? 'Python 插件是本机程序，能够访问当前用户可用的文件、网络和系统能力。独立进程不等于安全沙箱，请仅授权你已审查并信任的脚本。' : '脚本可通过宿主接口访问网络并保存来源数据，请仅授权你已审查并信任的脚本。'}</Alert>
      </DialogContent>
      <DialogActions><Button disabled={!!working} onClick={() => setPending(null)}>取消</Button><Button disabled={!!working} onClick={() => void trust()}>信任并启用此内容</Button></DialogActions>
    </Dialog>
  </section>;
}
