# Python Spider 宿主

worker.py 是随应用分发的宿主，不是解释器。CPython 分发位于 src-tauri/runtime/python，由构建工具准备；两者应打包到不同资源路径，避免文件混淆。

```sh
python3 scripts/prepare-python-runtime.py --target darwin-arm64
src-tauri/runtime/python/bin/python3 -I -B src-tauri/src/tests/scripts/python_worker_test.py -v
```

准备工具只下载 scripts/runtime-manifest.json 固定版本和 SHA-256 的 CPython 归档、wheel；不调用系统 pip，不执行下载的安装脚本。支持 darwin-arm64、darwin-x64、windows-x64，跨平台准备不代表对应平台已验证运行。若输出目录存在未知内容则拒绝覆盖。

原生层执行内置解释器 `-I -B worker.py`，通过 stdin 发送一个 JSON 并关闭 stdin：

```json
{"bundle":{"entry":"https://example.test/site.py","modules":{"https://example.test/site.py":"...已审查源码..."},"ext":"","digest":"..."},"action":"search","args":{"keyword":"动画","page":1},"storage":{}}
```

stdout 仅返回一行 `{ "result": ..., "storage": ... }` 或 `{ "error": "..." }`。支持 search/detail/play/home/homeVod/category/proxy；日志仅写 stderr。原生层仍需限制输入、stdout、stderr 大小，设置总执行超时、超时后 kill 并回收进程，清理环境变量，使用独立工作目录。worker 每调用创建实例，来源 Cookie/session 不跨请求保留；持久状态通过 storage 显式传递。

## 媒体代理契约

- getProxyUrl() 返回 `mqtv-python-proxy://local?`，脚本可追加 `do=...&url=...` 等参数。
- 原生层把该标记转换成带随机令牌的回环 URL，并保存来源与已授权脚本摘要上下文。
- 回环请求触发同 bundle 的 `action=proxy`，args 为 `{ "params": { ...解码后的查询参数... } }`，调用插件 localProxy(params)。
- proxyM3u8/proxyMedia/proxyTs 返回 `[200, mime, {"mqtvMedia":{"url":"https://...","headers":{...}}}, {}]`，由原生层流式请求上游并处理 HLS 相对路径和 Range。不得将媒体描述 JSON 当媒体内容播放。
- 自定义 localProxy 可以返回文本 body；原始 bytes 暂不支持 JSON 传输，应明确报告。

## 信任与证据边界

独立 Python 进程不提供系统权限沙箱；规则可导入 os/sys/requests。只执行原生层明确授权且摘要固定的源码；worker 不向插件提供钥匙串或夸克账号。Python 模块只从 bundle 加载或来自随包依赖，不自动从网络安装依赖。

已在 macOS arm64 用准备的内置 CPython 3.12.12 通过受控搜索、详情、不透明选集、播放请求头、媒体代理描述、日志隔离、异常脱敏、缺失依赖及 HTML 拒绝测试。未执行真实远程站点播放，未验证 Windows 或 macOS x64。

第三方分发来自 [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases/tag/20251014)。CPython 归档中的许可证与每个 wheel 的 .dist-info 许可证随分发保留；不随包分发下载的第三方站点规则。固定依赖和归档摘要记录在 scripts/runtime-manifest.json，构建结果 marker 记录在分发目录 mqtv-runtime.json。
