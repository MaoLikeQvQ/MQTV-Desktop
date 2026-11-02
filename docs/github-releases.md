# GitHub 本地打包发布

桌面更新使用公开仓库 `MaoLikeQvQ/MQTV-Desktop` 的 GitHub Releases。安装包可在本地构建，不要求 GitHub Actions。客户端只检查版本并在用户点击后打开安装包下载地址，不进行静默安装。

## 更新清单

客户端读取：

```text
https://github.com/MaoLikeQvQ/MQTV-Desktop/releases/latest/download/desktop-update.json
```

`releases/desktop-update.json` 是可直接编辑的清单，当前描述 1.0.1 / 构建 101 公开测试版。字段含义：

- `schemaVersion` 固定为 `1`；`packageName` 固定为 `com.maolike.mqtv.desktop`。
- `versionCode` 对应原生 `APP_BUILD`，每次发布必须递增；`versionName` 对应 Tauri 版本。
- `notes` 为展示给用户的纯文本版本说明。
- `packages` 每个平台和架构最多一个安装包：`platform` 为 `macos` / `windows`，`arch` 为 `arm64` / `x64` / `ia32`。
- `downloadUrl` 必须为本仓库 `/releases/download/<tag>/<附件名>` 的 HTTPS 直接下载链接。Mac 使用 `.dmg` / `.pkg`，Windows 使用 `.exe` / `.msi`。
- 可选 `minOsVersion` 为点分数字系统版本，例如 `14.0` 或 `10.0.19045`。填写实际支持的最低版本；未声明时不按系统版本进一步排除，不能据此声称所有系统均已验证。

不匹配架构、低于最低系统版本或构建号不高于本机时，客户端显示暂无适用更新。清单格式或安装包地址错误则明确报错，不回退其他更新服务器。固定地址依赖 GitHub 的 Latest Release；预发布条目不作为此渠道的更新入口。

## 本地打包并上传

1. 同步修改 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与根 `package.json` 的版本，并递增 `src-tauri/src/commands/app.rs` 的 `APP_BUILD`。按仓库约定更新 Cargo 锁定版本。
2. 准备对应平台的 Python 运行时，沿用上一版签名身份，运行验证并在目标系统构建。Mac 和 Windows 分别使用对应的本地构建环境；Mac 构建不能代替 Windows 打包和运行验证。

   ```sh
   npm run runtime:prepare
   npm run build
   npx vitest run
   npm run tauri build
   ```

3. 核对安装包签名、平台、架构和实际版本。正式包须遵守 `development.md` 的固定签名要求；当前已有测试 Release 的未签名/ad-hoc 包不代表满足正式发行要求。
4. 修改 `releases/desktop-update.json` 的版本、说明和附件链接。只填写本次实际构建并核验的包，未构建的架构不要填入。
5. 创建草稿 Release，将安装包与清单一并上传。以下参数需替换为本次真实标签和路径，发布说明使用 UTF-8 文本文件：

   ```sh
   gh release create <tag> /absolute/path/to/installer releases/desktop-update.json \
     --repo MaoLikeQvQ/MQTV-Desktop --draft \
     --title '<版本标题>' --notes-file /absolute/path/to/release-notes.md
   ```

6. 在 GitHub 检查草稿附件和说明，确保它们来自预期源码快照。正式发布前完成签名和目标系统验收，然后发布并设为 Latest：

   ```sh
   gh release edit <tag> --repo MaoLikeQvQ/MQTV-Desktop --draft=false --latest
   ```

7. 下载公开的 `latest/download/desktop-update.json` 确认内容，并从客户端检查匹配平台的新版本。不把“GitHub 上传成功”当作安装或播放验证。

后续给同一版本添加其他平台安装包时，先上传安装包，再替换完整清单，避免清单引用尚不存在的附件。不要删除已有附件或复用附件名替换不同构建，保持版本对应关系清晰。

## 现有客户端迁移

已安装的旧版本仍包含 tvadmin 更新逻辑，不会因服务器新增清单而自动切换。需要安装包含本次修改的客户端后，后续检查才会走 GitHub。发布新客户端时，旧 tvadmin 更新入口可继续用于分发这一过渡版本；本次没有修改 tvadmin 或替换任何已安装应用。
