# 原生线路适配

内置实现不下载或运行资源中的 JAR。当前适配精确入口 `csp_Anime1`、`csp_AppGet`，以及既有 WoGG 站点到夸克流程；不声称兼容 Guard/Amns 动态载荷或所有同名 JAR 版本。

## 使用

同步资源后，已启用且允许搜索的 Anime1、有效配置的 AppGet 会进入现有搜索流程。AppGet 扩展配置需要 HTTPS `url`（或字符串 `site`）、UTF-8 字节长度为 16/24/32 的 `dataKey` 和 16 字节的 `dataIv`。这两个字段是站点协议参数，不是用户账号。

设置 → 授权管理 → 线路外部授权：选择来源，提供外部 JSON 账号信息。支持字符串字段 `token`、`cookie`、`deviceId`、`version`、`userAgent`；不需要的字段省略。公开站点不必提供账号。授权只保存在原生进程内存，退出后失效；可以在同一入口清除。来源配置改变后不复用旧授权。

外部程序也可通过原生命令 `adapter_authorize` 注入 `{ source, authorization }`，`authorization: null` 撤销。前端封装位于 `frontend/api/adapters.ts`。来源身份包含 key、api、type、ext；使用前端封装会仅保留公开协议配置，避免订阅中的账号字段进入调用或新增历史。

夸克账号继续由现有扫码或授权码管理提供，Wogg 站点适配不自行获取、硬编码或替换账号。分享链接的 `pwd` 会传给文件读取和播放流程。

## 协议范围

- Anime1：独立获取索引搜索；遍历分类分页读取 `data-apireq`；提交固定播放 API；响应 Cookie 在原生代理中使用，不返回前端。分页有循环及数量限制。媒体域限定为 Anime1/Anicdn，未知域明确报错。
- AppGet：JSON 请求体及 form Content-Type 的搜索/详情协议；AES-CBC PKCS7 解密；播放表单及时间戳签名；播放前重新获取详情和临时 token。解析配置统一提交站点 vodParse 接口，仅接收 JSON 媒体结果；支持直连媒体，网页嗅探明确报错，未实现原插件额外的外部解析回退。选集 ID 存储影片、分组、位置、名称，不包含账号和临时播放 token。
- Wogg：使用已分析插件的路径式搜索 URL，编码片名；镜像请求失败时切换下一站，成功的空结果不切换。详情支持 `a[href]` 与 `data-clipboard-text`，去重并只保留夸克 HTTPS 分享。

## 验证边界

前端测试验证分发和配置筛选；Rust 测试验证索引/分页、Cookie 媒体域、外部授权隔离、选集结构、AES 及回环 HTTP 请求/签名/加密响应。回环服务使用随机端口和测试凭证，不访问用户账号。上述验证不代表生产站点搜索成功或桌面播放器真实起播。没有执行真实转存、安装替换或发布。
