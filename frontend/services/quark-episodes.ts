import { readQuarkFiles, type QuarkEpisode } from '@/api/quark';

/** 广度优先逐页扫描分享；发现视频立即交付，取消后不再请求下一页，已显示选集不因后续错误丢失。 */
export async function scanQuarkEpisodes(share: string, signal: AbortSignal, onEpisode: (episode: QuarkEpisode) => void): Promise<void> {
  const queue = [{ parent: '0', path: '' }];
  const seen = new Set<string>();
  const filesSeen = new Set<string>();
  const passcode = new URL(share).searchParams.get('pwd') || '';
  for (let index = 0; index < queue.length; index++) {
    const { parent, path } = queue[index];
    if (signal.aborted) return;
    if (seen.has(parent)) continue;
    seen.add(parent);
    if (seen.size > 1000) throw new Error('分享目录数量超过解析上限，请选择范围更小的资源');
    for (let page = 1; page <= 1000; page++) {
      if (signal.aborted) return;
      const listing = await readQuarkFiles(share, passcode, parent, page);
      if (signal.aborted) return;
      if (!Array.isArray(listing.files) || listing.pageSize !== 100) throw new Error('分享文件列表格式无效');
      for (const file of listing.files) {
        if (typeof file.id !== 'string' || typeof file.name !== 'string') throw new Error('分享文件信息无效');
        if (file.folder) queue.push({ parent: file.id, path: `${path}${file.name} / ` });
        else if (!filesSeen.has(file.id) && (file.video || /\.(mp4|mkv|mov|avi|ts|flv|webm|m4v)$/i.test(file.name))) {
          filesSeen.add(file.id);
          onEpisode({ id: file.id, name: file.name, path: path + file.name, size: file.size, parent, page });
        }
      }
      if (listing.files.length < 100 || (typeof listing.total === 'number' && page * 100 >= listing.total)) break;
      if (page === 1000) throw new Error('分享文件数量超过解析上限');
    }
  }
  if (!filesSeen.size) throw new Error('该夸克资源没有可播放选集');
}
