# mqtv-netdisk

Tauri 无关的 Rust 网盘工具包，当前提供夸克能力。新增网盘实现在 `src/` 下新增 provider 模块，不将网站搜索插件放入网盘包。

## 使用边界

- 实现 `quark::CredentialStore`，在原生层提供账号 ID、Cookie 和转存映射；不要将 `Account` 写入界面日志。
- 文件和播放调用前持有 `quark::LOCK`，准备有效账号；库返回 `AUTH_INVALID` 时由宿主决定重新登录或刷新授权。
- 扫码轮询自行在安装凭证前持锁，调用方不要在整个扫码轮询外再次持锁。
- Cookie 更新必须保留宿主其他授权字段。共享锁保证授权、Cookie 和转存记录不会相互覆盖。
- 目录遍历只读，播放可能创建 MQTV 目录并转存文件；不删除用户文件。
- 宿主退出时调用 `quark::shutdown()` 关闭媒体监听。

`cargo test -p mqtv-netdisk` 可独立测试，不需要 Tauri、tvadmin 或系统凭证存储。真实网络测试默认忽略。
