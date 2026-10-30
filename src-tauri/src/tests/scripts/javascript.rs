use super::*;
use crate::features::scripts::ScriptBundle;

#[test]
fn static_dependencies_follow_javascript_syntax_without_execution() {
    let source = r#"
        import value from /* comment */ './value.js';
        import './side-effect.js';
        export { other } from './reexport.js';
        export * from './all.js';
        import './escaped\u002ejs';
        const text = "import 'node:fs'";
        const template = `from 'node:path'`;
        const pattern = /import 'node:crypto'/;
        // import 'node:os';
        /* export * from 'node:util'; */
        function parseImport(){this.skipSymbol("import")||this.fail("parseImport: expected import")}
        import('./dynamic.js');
        throw new Error('must not execute');
    "#;
    assert_eq!(
        static_imports("https://fixture.invalid/main.js", source).unwrap(),
        vec![
            "./all.js",
            "./escaped.js",
            "./reexport.js",
            "./side-effect.js",
            "./value.js"
        ]
    );
    assert_eq!(
        static_imports(
            "https://fixture.invalid/main.js",
            "import fs from 'node:fs';"
        )
        .unwrap(),
        vec!["node:fs"]
    );
    assert!(static_imports("https://fixture.invalid/main.js", "export default {").is_err());
}

/// 构造受控 ES 模块，避免测试依赖远端站点或凭证。
fn bundle(source: &str) -> ScriptBundle {
    let entry = "https://fixture.invalid/plugin.js".to_string();
    ScriptBundle {
        entry: entry.clone(),
        modules: BTreeMap::from([(entry, source.into())]),
        ext: json!({}),
        digest: "fixture".into(),
    }
}
#[test]
fn search_detail_play_preserve_opaque_ids_and_storage() {
    let b = bundle(
        r#"export default {
      init(){local.set('rule','count',Number(local.get('rule','count') || 0)+1)},
      search(keyword){return JSON.stringify({list:[{vod_id:'opaque:id',vod_name:keyword}]})},
      detail(id){return {list:[{vod_id:id,vod_play_from:'线路',vod_play_url:'第一集$opaque:episode'}]}},
      play(flag,id){return {parse:0,url:'https://media.invalid/'+id,header:{Referer:'https://fixture.invalid/'}}}
    }"#,
    );
    let mut state = Map::new();
    assert_eq!(
        execute(&b, "search", &json!({"keyword":"测试"}), &mut state).unwrap()["list"][0]["vod_id"],
        "opaque:id"
    );
    assert_eq!(
        execute(&b, "detail", &json!({"id":"opaque:id"}), &mut state).unwrap()["list"][0]["vod_play_url"],
        "第一集$opaque:episode"
    );
    assert_eq!(
        execute(
            &b,
            "play",
            &json!({"id":"opaque:episode","flag":"线路"}),
            &mut state
        )
        .unwrap()["parse"],
        0
    );
    assert_eq!(state["[\"rule\",\"count\"]"], "3");
}
#[test]
fn missing_module_and_unsupported_crypto_fail_visibly() {
    let mut state = Map::new();
    let b = bundle("import value from './missing.js'; export default value;");
    assert!(execute(&b, "search", &json!({}), &mut state).is_err());
    let b = bundle(
        "export default {search(){try { CryptoJS.AES.encrypt('x'); } catch(e) {} return {list:[]}}}",
    );
    assert!(
        execute(&b, "search", &json!({}), &mut state)
            .unwrap_err()
            .contains("AES")
    );
}
#[test]
fn module_imports_and_common_codecs_work() {
    let mut b = bundle(
        "import value from './value.js'; export default {search(){return {value, hash:md5('abc'), text:base64Decode(base64Encode('中文'))}}}",
    );
    b.modules.insert(
        "https://fixture.invalid/value.js".into(),
        "export default 42".into(),
    );
    let result = execute(&b, "search", &json!({}), &mut Map::new()).unwrap();
    assert_eq!(result["value"], 42);
    assert_eq!(result["text"], "中文");
    assert_eq!(result["hash"], "900150983cd24fb0d6963f7d28e17f72");
}
#[test]
fn storage_is_not_committed_when_call_fails() {
    let b = bundle(
        "export default {search(){local.set('x','a','bad'); throw new Error('controlled')}}",
    );
    let mut state = Map::new();
    assert!(execute(&b, "search", &json!({}), &mut state).is_err());
    assert!(state.is_empty());
}
#[test]
fn network_errors_cannot_be_swallowed_by_plugin() {
    let b = bundle(
        "export default {search(){try{req('file:///etc/passwd')}catch(e){} return {list:[]}}}",
    );
    assert!(
        execute(&b, "search", &json!({}), &mut Map::new())
            .unwrap_err()
            .contains("HTTP")
    );
}

#[test]
#[ignore = "显式提供已审查 drpy 模块目录后运行；不下载或执行远程代码"]
fn reviewed_drpy_engine_runs_controlled_rule_without_network() {
    let dir = std::path::PathBuf::from(
        std::env::var("MQTV_DRPY_FIXTURE_DIR").expect("请提供已审查模块目录"),
    );
    let mut b = bundle("");
    b.entry = "https://fixture.invalid/drpy2.min.js".into();
    b.modules.clear();
    for file in ["drpy2.min.js", "cheerio.min.js", "模板.js", "gbk.js"] {
        let url = Url::parse("https://fixture.invalid/")
            .unwrap()
            .join(file)
            .unwrap()
            .to_string();
        let code = std::fs::read_to_string(dir.join(file)).unwrap();
        let dependencies = static_imports(&url, &code).unwrap();
        if file == "drpy2.min.js" {
            assert_eq!(dependencies.len(), 3);
        } else {
            assert!(dependencies.is_empty(), "{file}: {dependencies:?}");
        }
        b.modules.insert(url, code);
    }
    b.ext = json!(
        r#"var rule={title:'fixture',host:'https://fixture.invalid',searchUrl:'/search/**',一级:'a;a&&Text;a&&href;;a&&href',搜索:'js:VODS=[{vod_id:"opaque:1",vod_name:KEY}]',二级:'js:VOD={vod_id:"opaque:1",vod_name:"fixture",vod_play_from:"direct",vod_play_url:"第一集$aHR0cHM6Ly9tZWRpYS5pbnZhbGlkL2ZpeHR1cmUubXA0"}',play_parse:true,lazy:'js:input={parse:0,url:"https://media.invalid/fixture.mp4"}'};"#
    );
    let mut storage = Map::new();
    let results = execute(&b, "search", &json!({"keyword":"测试"}), &mut storage).unwrap();
    assert_eq!(results["list"][0]["vod_name"], "测试");
    let detail = execute(&b, "detail", &json!({"id":"opaque:1"}), &mut storage).unwrap();
    assert_eq!(
        detail["list"][0]["vod_play_url"],
        "第一集$aHR0cHM6Ly9tZWRpYS5pbnZhbGlkL2ZpeHR1cmUubXA0"
    );
    let player = execute(
        &b,
        "play",
        &json!({"id":"aHR0cHM6Ly9tZWRpYS5pbnZhbGlkL2ZpeHR1cmUubXA0","flag":"direct"}),
        &mut storage,
    )
    .unwrap();
    assert_eq!(player["url"], "https://media.invalid/fixture.mp4");
}

#[test]
fn synchronous_request_preserves_status_headers_and_response() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let count = socket.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..count]).starts_with("POST /fixture"));
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nX-Test: fixture\r\nConnection: close\r\n\r\n{\"a\":1}").unwrap();
    });
    let value = request(
        &format!("http://{address}/fixture"),
        r#"{"method":"POST","body":"x=1"}"#,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(value["code"], 200);
    assert_eq!(value["headers"]["x-test"], "fixture");
    assert_eq!(value["content"], "{\"a\":1}");
    server.join().unwrap();
}

#[test]
#[ignore = "执行真实 30 秒中断上限验证"]
fn infinite_script_is_interrupted() {
    let start = Instant::now();
    let b = bundle("export default {search(){while(true){}}}");
    assert!(execute(&b, "search", &json!({}), &mut Map::new()).is_err());
    assert!(start.elapsed() < Duration::from_secs(35));
}

#[test]
#[ignore = "显式提供已审查规则与模块目录；访问真实站点，不操作账号"]
fn reviewed_real_rule_search_smoke() {
    let dir =
        std::path::PathBuf::from(std::env::var("MQTV_DRPY_FIXTURE_DIR").expect("已审查模块目录"));
    let mut b = bundle("");
    b.entry = "https://fixture.invalid/drpy2.min.js".into();
    b.modules.clear();
    for file in ["drpy2.min.js", "cheerio.min.js", "模板.js", "gbk.js"] {
        let url = Url::parse("https://fixture.invalid/")
            .unwrap()
            .join(file)
            .unwrap()
            .to_string();
        b.modules
            .insert(url, std::fs::read_to_string(dir.join(file)).unwrap());
    }
    b.ext = json!(std::fs::read_to_string(dir.join("NyaFun.js")).unwrap());
    let result = execute(&b, "search", &json!({"keyword":"海贼王"}), &mut Map::new());
    match result {
        Ok(v) => {
            println!(
                "real_rule_list_count={}",
                v["list"].as_array().map(Vec::len).unwrap_or(0)
            );
            assert!(v["list"].is_array());
        }
        Err(e) => panic!("real_rule_failure={e}"),
    }
}

#[test]
fn failed_invocation_does_not_break_the_next_runtime() {
    let mut storage = Map::new();
    let broken = bundle("export default {search(){throw new Error('fixture failure')}}");
    assert!(execute(&broken, "search", &json!({}), &mut storage).is_err());
    let working =
        bundle("export default {search(){return {list:[{vod_id:'ok',vod_name:'恢复'}]}}}");
    let response = execute(&working, "search", &json!({}), &mut storage).unwrap();
    assert_eq!(response["list"][0]["vod_id"], "ok");
}

#[test]
fn scoped_cancellation_interrupts_compute_without_cancelling_other_scripts() {
    let signal = crate::request_scope::Signal::new();
    let worker_signal = signal.clone();
    let started = Instant::now();
    let worker = std::thread::spawn(move || {
        let mut state = Map::from_iter([("preserved".into(), json!(true))]);
        let result = execute_scoped(
            &bundle("export default {search(){local.set('rule','changed',1); while(true){} }}"),
            "search",
            &json!({}),
            &mut state,
            Some(worker_signal),
        );
        (result, state)
    });
    std::thread::sleep(Duration::from_millis(40));
    signal.cancel();
    let (result, state) = worker.join().unwrap();
    assert!(result.is_err());
    assert_eq!(state, Map::from_iter([("preserved".into(), json!(true))]));
    assert!(started.elapsed() < Duration::from_secs(3));
    // 另一个窗口未绑定这个信号，正常规则仍可执行。
    assert!(
        execute(
            &bundle("export default {search(){return {list:[]}}}"),
            "search",
            &json!({}),
            &mut Map::new()
        )
        .is_ok()
    );
}

#[test]
fn scoped_cancellation_drops_inflight_http_before_response_arrives() {
    use std::io::Read;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted, received) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).unwrap() > 0);
        accepted.send(()).unwrap();
        // 不返回响应，客户端应在窗口取消后断开连接。
        let mut byte = [0; 1];
        socket.read(&mut byte).unwrap()
    });
    let signal = crate::request_scope::Signal::new();
    let worker_signal = signal.clone();
    let worker = std::thread::spawn(move || {
        request_scoped(
            &format!("http://{address}/slow"),
            "{}",
            Instant::now() + Duration::from_secs(15),
            Some(worker_signal),
        )
    });
    received.recv_timeout(Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    signal.cancel();
    assert!(worker.join().unwrap().unwrap_err().contains("取消"));
    assert_eq!(server.join().unwrap(), 0);
    assert!(start.elapsed() < Duration::from_secs(3));
}
