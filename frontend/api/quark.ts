import { invokePlayback } from '@/platform/playback-request';
import { buildRequestUrl } from '@/utils/url';

export type QuarkAccount = { cached: boolean; accountId?: string; name?: string; local?: boolean };
export type QuarkLoginSession = { id: string; scanUrl: string };
export type QuarkEpisode = { id: string; name: string; path?: string; size?: number; parent: string; page: number };
export type QuarkFile = { id: string; name: string; folder: boolean; size?: number; video: boolean };
/** 读取分享的一页目录；分享访问令牌和文件转存令牌仅保留在原生层。 */
export const readQuarkFiles = (share: string, passcode: string, parent: string, page: number) => invokePlayback<{ files: QuarkFile[]; total?: number; pageSize: number }>('quark_files', { share, passcode, parent, page });
export type QuarkSearchItem = { title: string; url: string; poster?: string; remarks?: string; category?: string; year?: string };
/**
 * 读取原生授权状态；提供资源地址时将其 origin 同步为授权后台。
 * @param resourceUrl 可选资源接口地址，不传时只读取状态。
 */
export const readQuarkSettings = (resourceUrl?: string) => invokePlayback<QuarkAccount>('quark_settings', resourceUrl
  ? { backend: new URL(buildRequestUrl(resourceUrl)).origin + '/' } : undefined);
/** 请求创建夸克扫码会话，返回会话 ID 和用于生成二维码的链接。 */
export const createQuarkLogin = () => invokePlayback<QuarkLoginSession>('quark_qr_create');
/** 查询指定扫码会话状态，登录凭证由原生层处理且不返回前端。 */
export const pollQuarkLogin = (id: string | undefined) => invokePlayback<{ state: string }>('quark_qr_poll', { id });
/** 取消指定扫码会话，阻止关闭弹窗后的会话继续完成授权。 */
export const cancelQuarkLogin = (id: string) => invokePlayback('quark_qr_cancel', { id });
/** 提交内测授权码领取夸克授权，成功后由原生层保存凭证。 */
export const authorizeQuarkCode = (authorizationCode: string) => invokePlayback<QuarkAccount>('quark_authorize_code', { authorizationCode });
/** 向指定夸克线路站点搜索片名，返回解析后的搜索条目。 */
export const searchQuarkLine = (site: string, keyword: string) => invokePlayback<QuarkSearchItem[]>('quark_line_search', { site, keyword });
/** 请求线路详情并提取可用的夸克分享链接。 */
export const readQuarkDetail = (url: string) => invokePlayback<string[]>('quark_line_detail', { url });
/**
 * 请求解析夸克分享的目录和分页，返回可播放选集。
 * @param share 夸克分享地址。
 * @param passcode 分享提取码，没有时传空字符串。
 */
export const readQuarkEpisodes = (share: string, passcode: string) => invokePlayback<{ episodes: QuarkEpisode[] }>('quark_episodes', { share, passcode });
/**
 * 请求原生层准备指定夸克选集，返回供播放器使用的本地代理地址。
 * @param args 分享、目录、提取码、文件 ID 和文件所在页。
 */
export const playQuarkEpisode = (args: { share: string; parent: string; passcode: string; fid: string; page: number }) => invokePlayback<{ url: string }>('quark_play', args);

/** 读取玩偶详情中的纯文本简介与夸克分享列表，不包含其他网盘分享。 */
export const readQuarkInfo = (url: string) => invokePlayback<{ shares: string[]; synopsis: string }>('quark_line_info', { url });

/** 读取当前夸克媒体会话累计下载字节；非当前代理地址返回 null，不发起测速下载。 */
export const readQuarkDownloadedBytes = (url: string) => invokePlayback<number | null>('quark_downloaded_bytes', { url });
