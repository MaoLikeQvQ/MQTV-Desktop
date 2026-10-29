use super::*;
use serde_json::json;
/// 核验截图影片的原始分享与真实错误分类；不读取账号、不保存文件、不输出令牌。
#[test]
#[ignore = "真实访问公开线路与夸克，不使用账号"]
fn sao_share_status_network_smoke() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let shares = super::super::search::quark_line_detail(
                "https://www.wogg.live/voddetail/90712.html".into(),
            )
            .await
            .expect("影片详情");
            assert!(!shares.is_empty());
            let id = super::super::files::share_id(&shares[0]).unwrap();
            let response = client()
                .unwrap()
                .post("https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc")
                .header("User-Agent", UA)
                .header("Referer", "https://pan.quark.cn/")
                .json(&json!({"pwd_id":id,"passcode":""}))
                .send()
                .await
                .expect("分享访问令牌请求");
            let status = response.status().as_u16();
            let data: Value = response.json().await.unwrap();
            let code = data["code"].clone();
            match mqtv_netdisk::quark::decode_response(status, "share/sharepage/token", Some(data))
            {
                Ok(value) => {
                    assert!(value["data"]["stoken"].as_str().is_some());
                    println!("分享已恢复可访问");
                }
                Err(error) => {
                    assert!(
                        error.contains("分享中的文件已删除或不存在")
                            || error.contains("分享不存在或已失效"),
                        "{error}"
                    );
                    println!("已核验原始分享，HTTP {status} code={code}，界面原因：{error}");
                }
            }
        });
}
