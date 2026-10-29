use super::*;
use std::collections::BTreeMap;

#[test]
fn bundled_worker_protocol_and_cancellation_are_bounded() {
    let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if cfg!(windows) {
        "runtime/python/python.exe"
    } else {
        "runtime/python/bin/python3"
    });
    assert!(runtime.is_file(), "请先运行 npm run runtime:prepare");
    let entry = "https://fixture.invalid/plugin.py".to_string();
    let code = "from base.spider import Spider\nclass Spider(Spider):\n def searchContent(self,key,quick):\n  print('log')\n  self.setCache('count',1)\n  return {'list':[{'vod_id':'opaque:1','vod_name':key}]}\n";
    let mut bundle = ScriptBundle {
        entry: entry.clone(),
        modules: BTreeMap::from([(entry.clone(), code.into())]),
        ext: json!(""),
        digest: "controlled".into(),
    };
    let mut storage = Map::new();
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let result = execute(
        &runtime,
        Path::new(""),
        &bundle,
        "search",
        &json!({"keyword":"测试"}),
        &mut storage,
        generation,
    )
    .unwrap();
    assert_eq!(result["list"][0]["vod_id"], "opaque:1");
    assert_eq!(storage["count"], 1);
    bundle.modules.insert(entry, "while True: pass".into());
    let start = Instant::now();
    assert!(
        execute(
            &runtime,
            Path::new(""),
            &bundle,
            "search",
            &json!({}),
            &mut storage,
            generation.wrapping_add(1)
        )
        .unwrap_err()
        .contains("取消")
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}
