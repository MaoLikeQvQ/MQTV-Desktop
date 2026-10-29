use super::*;

#[tokio::test]
#[ignore = "显式提供已审查 drpy 模块目录；仅通过本地 HTTP 检查，不执行模块"]
async fn reviewed_drpy_dependencies_pass_full_inspection() {
    use std::io::{Read, Write};
    let directory = PathBuf::from(std::env::var("MQTV_DRPY_FIXTURE_DIR").unwrap());
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    server.set_nonblocking(true).unwrap();
    let address = server.local_addr().unwrap();
    let origin = reqwest::Url::parse(&format!("http://{address}/")).unwrap();
    let files: BTreeMap<_, _> = ["drpy2.min.js", "cheerio.min.js", "模板.js", "gbk.js"]
        .into_iter()
        .map(|file| (origin.join(file).unwrap().path().to_owned(), std::fs::read_to_string(directory.join(file)).unwrap()))
        .collect();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop.clone();
    let task = std::thread::spawn(move || {
        while !stopped.load(std::sync::atomic::Ordering::Relaxed) {
            let (mut socket, _) = match server.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("{error}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let path = request.split_whitespace().nth(1).unwrap();
            let body = files.get(path).expect("only reviewed fixture modules may be requested");
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    let result = inspect(&json!({"type":3,"api":origin.join("drpy2.min.js").unwrap().as_str(),"ext":"var rule={title:'fixture'};"})).await;
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    task.join().unwrap();
    let bundle = result.unwrap();
    assert_eq!(bundle.modules.len(), 4);
    assert_eq!(bundle.digest, bundle_digest(&bundle));
}

#[tokio::test]
async fn inspection_rejects_real_node_module_dependencies() {
    use std::io::{Read, Write};
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let task = std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).unwrap();
        let body = "import fs from 'node:fs'; export default fs;";
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let error = inspect(&json!({"type":3,"api":format!("http://{address}/main.js")}))
        .await.err().unwrap();
    assert_eq!(error, "尚不支持的脚本模块：node:fs");
    task.join().unwrap();
}

#[test]
fn script_configuration_classification_and_identity() {
    let js = json!({"type":3,"api":"https://example.com/drpy.js?version=2","ext":"rule"});
    assert_eq!(language(&js).unwrap(), "javascript");
    assert_eq!(
        language(&json!({"type":3,"api":"https://example.com/a.py"})).unwrap(),
        "python"
    );
    assert!(language(&json!({"type":3,"api":"csp_Wogg"})).is_err());
    assert!(script_url("file:///tmp/plugin.py").is_err());
    assert!(script_url("https://user:pass@example.com/plugin.js").is_err());
    let mut changed = js.clone();
    changed["ext"] = json!("changed");
    assert_ne!(identity(&js), identity(&changed));
    changed = js.clone();
    changed["name"] = json!("renamed");
    assert_eq!(identity(&js), identity(&changed));
}

#[test]
fn parser_flags_cannot_bypass_with_string_or_boolean() {
    assert!(needs_web_parser(&json!({"parse":"1"})));
    assert!(needs_web_parser(&json!({"parse":true})));
    assert!(needs_web_parser(&json!({"jx":"true"})));
    assert!(needs_web_parser(
        &json!({"playUrl":"https://parser.invalid/?url="})
    ));
    assert!(!needs_web_parser(&json!({"parse":"0","jx":false})));
}

#[test]
fn bundle_digest_binds_rule_and_transitive_modules() {
    let mut bundle = ScriptBundle {
        entry: "https://fixture.invalid/main.js".into(),
        modules: BTreeMap::from([(
            "https://fixture.invalid/main.js".into(),
            "export default {}".into(),
        )]),
        ext: json!("rule"),
        digest: String::new(),
    };
    let original = bundle_digest(&bundle);
    bundle
        .modules
        .insert("https://fixture.invalid/dep.js".into(), "changed".into());
    assert_ne!(original, bundle_digest(&bundle));
    bundle.ext = json!("changed");
    assert_ne!(original, bundle_digest(&bundle));
}

#[tokio::test]
async fn inspection_snapshots_transitive_imports_and_rule_without_execution() {
    use std::io::{Read, Write};
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let task = std::thread::spawn(move || {
        for _ in 0..3 {
            let (mut socket, _) = server.accept().unwrap();
            let mut bytes = [0; 4096];
            let n = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]);
            let body = if request.starts_with("GET /main.js ") {
                "import './dep.js';export default {search(){throw new Error('must not execute')}}"
            } else if request.starts_with("GET /dep.js ") {
                r#"export const version=1;
                function parseImport(){this.skipSymbol("import")||this.fail("parseImport: expected import")}
                const text = "from 'node:fs'";
                // import 'node:path';
                /* export * from 'node:crypto'; */
                const pattern = /import "node:os"/;
                const template = `import "node:util"`;
                throw new Error('inspection must not execute modules');"#
            } else {
                "var rule={title:'fixture'};"
            };
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let value=inspect(&json!({"type":3,"api":format!("http://{address}/main.js"),"ext":format!("http://{address}/rule.js")})).await.unwrap();
    assert_eq!(value.modules.len(), 2);
    assert!(value.ext.as_str().unwrap().contains("fixture"));
    assert_eq!(value.digest, bundle_digest(&value));
    task.join().unwrap();
}
