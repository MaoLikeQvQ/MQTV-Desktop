// Opt-in account/network smoke tests; never run automatically.
use super::{
    authorization::{quark_authorize, quark_settings, quark_validate},
    client::client,
    credentials::load,
    files::{quark_episodes, quark_files},
    playback::quark_play,
    search::{quark_line_detail, quark_line_search},
};

#[cfg(test)]
mod live_tests {
    use super::*;
    /// 按需验证真实后台授权复用、账号状态、线路搜索和目录读取；会保存本地后台与授权设置。
    /// 设置 MQTV_TEST_PLAYBACK=1 时还会转存测试视频并读取本地代理资源。
    #[test]
    #[ignore = "requires local tvadmin and Quark; MQTV_TEST_PLAYBACK=1 saves one test video"]
    fn local_line_and_account_smoke() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let metadata = quark_settings(Some("http://127.0.0.1:3101/".into())).await.expect("save native settings");
            assert_eq!(metadata["backend"], "http://127.0.0.1:3101/");
            let first = quark_authorize().await.expect("acquire or reuse authorization");
            let second = quark_authorize().await.expect("reuse authorization");
            assert_eq!(first["accountId"], second["accountId"]);
            assert_eq!(second["reused"], true);
            let valid = quark_validate().await.expect("validate real account");
            assert_eq!(valid["valid"], true);
            let results = quark_line_search("https://www.wogg.net/".into(), "斗罗大陆".into()).await.expect("real line search");
            assert!(!results.is_empty());
            let shares = quark_line_detail(results[0].url.clone()).await.expect("real line detail");
            let files = quark_files(shares[0].clone(),None,None,None).await.expect("real share file listing");
            assert!(files["files"].is_array());
            if std::env::var("MQTV_TEST_PLAYBACK").as_deref() == Ok("1") {
                let mut listing = files.clone(); let mut parent = "0".to_string();
                for _ in 0..5 {
                    let list = listing["files"].as_array().expect("file list");
                    if let Some(video) = list.iter().find(|f| f["folder"] != true && (f["video"] == true || f["name"].as_str().is_some_and(|n| n.ends_with(".mp4") || n.ends_with(".mkv")))) {
                        let playback = quark_play(shares[0].clone(),parent.clone(),None,video["id"].as_str().unwrap().into(),None).await.expect("prepare actual playback");
                        let response = client().unwrap().get(playback["url"].as_str().unwrap()).header("Range","bytes=0-1023").send().await.expect("local media proxy");
                        assert!(response.status().is_success(),"video playback HTTP {}",response.status().as_u16());
                        let bytes = response.bytes().await.unwrap(); assert!(!bytes.is_empty());
                        println!("live playback: native proxy returned a nonempty playable resource");
                        return;
                    }
                    let folder=list.iter().find(|f|f["folder"]==true).expect("video or folder");
                    parent=folder["id"].as_str().unwrap().to_string();
                    listing=quark_files(shares[0].clone(),Some(parent.clone()),None,None).await.expect("nested files");
                }
                panic!("no video found within five directory levels");
            }
            println!("live smoke: cached account reused, account valid, {} results, {} shares, {} root files", results.len(),shares.len(),files["files"].as_array().unwrap().len());
        });
    }
}

#[cfg(test)]
mod playback_smoke {
    use super::*;
    /// 按需使用已转存的测试视频验证真实播放资源，检查 MP4 字节或 HLS 首个媒体片段。
    #[test]
    #[ignore = "uses previously saved MQTV test file and real Quark network"]
    fn cached_video_resource() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let s=load().unwrap(); let (key,_) = s.saved.first_key_value().expect("previously saved test file");
            let parts:Vec<_>=key.split(':').collect();
            let result=quark_play(format!("https://pan.quark.cn/s/{}",parts[1]),"0".into(),None,parts[2].into(),None).await.expect("play API");
            let response=client().unwrap().get(result["url"].as_str().unwrap()).header("Range","bytes=0-4095").send().await.unwrap();
            assert!(response.status().is_success(),"proxy status {}",response.status().as_u16());
            let bytes=response.bytes().await.unwrap();
            if !bytes.starts_with(b"#EXTM3U") { assert!(bytes.windows(4).any(|w|w==b"ftyp"||w==b"moof")); println!("live playback: MP4 bytes fetched through native proxy"); return; }
            let text=String::from_utf8(bytes.to_vec()).unwrap();
            let segment=text.lines().find(|line|!line.starts_with('#')&&!line.is_empty()).expect("segment");
            let response=client().unwrap().get(segment).header("Range","bytes=0-1023").send().await.unwrap();
            assert!(response.status().is_success(),"segment status {}",response.status().as_u16());
            assert!(!response.bytes().await.unwrap().is_empty());
            println!("live playback: HLS playlist and first media segment fetched through native proxy");
        });
    }
}

#[cfg(test)]
mod episode_smoke {
    use super::*;
    /// 按需遍历已保存测试资源对应的真实分享，验证选集字段完整且无需转存。
    #[test]
    #[ignore = "real Quark directory traversal; no transfers"]
    fn resolves_real_episodes() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let s = load().unwrap();
                let (key, _) = s.saved.first_key_value().expect("saved test source");
                let parts: Vec<_> = key.split(':').collect();
                let result = quark_episodes(format!("https://pan.quark.cn/s/{}", parts[1]), None)
                    .await
                    .expect("resolve episodes");
                let episodes = result["episodes"].as_array().unwrap();
                assert!(!episodes.is_empty());
                assert!(episodes.iter().all(|e| e["id"].is_string()
                    && e["parent"].is_string()
                    && e["page"].is_number()
                    && e["size"].is_number()
                    && !e["name"].as_str().unwrap_or_default().contains(" / ")));
                println!(
                    "live episodes: {} playable episodes resolved automatically",
                    episodes.len()
                );
            });
    }
}
