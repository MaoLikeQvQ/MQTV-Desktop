/** 分离与选集顺序一致的文件名前缀序号，避免徽标与正文重复；保留年份、清晰度和其他名称数字。 */
export function episodeLabel(name: string, number: number): { badge: string; label: string } {
  const title = name.replace(/\.(?:mp4|mkv|avi|mov|m4v|ts|m2ts|webm|flv|wmv)$/i, '').trim();
  const prefix = new RegExp(`^(?:第\\s*)?0*${number}(?:集|话|期)?(?:[\\s._-]+|$)`);
  return { badge: String(number).padStart(2, '0'), label: title.replace(prefix, '').trim() || '播放' };
}
