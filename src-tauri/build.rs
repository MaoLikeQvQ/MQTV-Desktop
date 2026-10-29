use std::{collections::HashMap, env, path::PathBuf};

/// 按 Vite 的配置优先级读取服务地址并注入 Rust 编译环境，然后执行 Tauri 构建。
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    println!("cargo:rerun-if-env-changed=VITE_API_BASE_URL");
    println!("cargo:rerun-if-env-changed=MQTV_ENV_MODE");
    let mode = env::var("MQTV_ENV_MODE").unwrap_or_else(|_| {
        if env::var("PROFILE").as_deref() == Ok("release") {
            "production".into()
        } else {
            "development".into()
        }
    });
    let mut values = HashMap::new();
    // Match Vite's precedence without mutating the build process environment.
    for name in [
        ".env".into(),
        ".env.local".into(),
        format!(".env.{mode}"),
        format!(".env.{mode}.local"),
    ] {
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.exists() {
            continue;
        }
        let entries = dotenvy::from_path_iter(&path)
            .unwrap_or_else(|_| panic!("无法读取环境配置 {}", path.display()));
        for entry in entries {
            let (key, value) =
                entry.unwrap_or_else(|_| panic!("环境配置格式错误 {}", path.display()));
            values.insert(key, value);
        }
    }
    let backend = env::var("VITE_API_BASE_URL")
        .ok()
        .or_else(|| values.remove("VITE_API_BASE_URL"))
        .filter(|value| !value.trim().is_empty())
        .expect("请在根目录 .env 或 .env.local 配置 VITE_API_BASE_URL");
    assert!(
        !backend.contains(['\r', '\n']),
        "VITE_API_BASE_URL 必须为单行域名"
    );
    println!("cargo:rustc-env=MQTV_API_BASE_URL={}", backend.trim());
    // 发布包必须携带当前目标的校验运行时，禁止依赖开发机 PATH。
    let runtime = root.join("src-tauri/runtime/python");
    let marker = runtime.join("mqtv-runtime.json");
    println!("cargo:rerun-if-changed={}", marker.display());
    if env::var("PROFILE").as_deref() == Ok("release") {
        let target = env::var("TARGET").unwrap_or_default();
        let expected = match target.as_str() {
            "aarch64-apple-darwin" => "darwin-arm64",
            "x86_64-apple-darwin" => "darwin-x64",
            "x86_64-pc-windows-msvc" => "windows-x64",
            _ => panic!("尚未准备目标平台的 Python 分发：{target}"),
        };
        let marker = std::fs::read_to_string(&marker)
            .expect("请先运行 npm run runtime:prepare 准备内置 Python");
        let marker: serde_json::Value =
            serde_json::from_str(&marker).expect("内置 Python 标记格式无效");
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../scripts/runtime-manifest.json"))
                .expect("运行时锁定清单无效");
        assert_eq!(
            marker["target"].as_str(),
            Some(expected),
            "内置 Python 与构建目标不匹配"
        );
        assert_eq!(
            marker["pythonVersion"], manifest["pythonVersion"],
            "内置 Python 版本与锁定清单不匹配"
        );
        assert_eq!(
            marker["runtimeSha256"], manifest["runtimes"][expected]["sha256"],
            "运行时摘要标记不匹配"
        );
        for (name, dependency) in manifest["dependencies"].as_object().expect("缺少依赖锁定")
        {
            assert_eq!(
                marker["dependencies"][name]["sha256"], dependency["wheels"][expected]["sha256"],
                "内置 Python 依赖不匹配：{name}"
            );
        }
        let executable = runtime.join(if target.contains("windows") {
            "python.exe"
        } else {
            "bin/python3"
        });
        assert!(executable.is_file(), "内置 Python 可执行文件缺失");
    }
    tauri_build::build()
}
