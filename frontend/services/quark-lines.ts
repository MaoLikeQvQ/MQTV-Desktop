import type { Source } from '@/domain/media/media';
import { quarkLine } from '@/domain/resources/quark-lines';
import { searchQuarkLine, type QuarkSearchItem } from '@/api/quark';

/** 按配置顺序切换玩偶镜像；成功的空结果不触发下一站，全部失败时明确报告。 */
export async function searchQuarkSource(source: Source, keyword: string): Promise<QuarkSearchItem[]> {
  const sites = quarkLine(source).sites;
  if (!sites.length) throw new Error('线路缺少站点配置');
  const errors: string[] = [];
  for (const site of sites) {
    try { return await searchQuarkLine(site, keyword.trim()); }
    catch (reason) { errors.push(String(reason)); }
  }
  throw new Error('所有玩偶镜像均请求失败：' + errors.join('；'));
}
