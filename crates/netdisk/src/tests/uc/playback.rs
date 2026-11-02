use super::*;

#[test]
fn uc_transfer_states_and_download_payload_follow_uc_protocol() {
    assert_eq!(
        saved_task_fid(&json!({"data":{"status":2,"save_as":{"save_as_top_fids":["nested-fid"]}}}))
            .unwrap(),
        Some("nested-fid")
    );
    assert_eq!(
        saved_task_fid(&json!({"data":{"status":2,"save_as_top_fids":["root-fid"]}})).unwrap(),
        Some("root-fid")
    );
    assert_eq!(saved_task_fid(&json!({"data":{"status":1}})).unwrap(), None);
    assert!(
        saved_task_fid(&json!({"data":{"status":3}}))
            .unwrap_err()
            .contains("保存任务失败")
    );
    assert_eq!(
        saved_task_fid(&json!({"data":{"status":2,"save_as_top_fids":[""]}})).unwrap(),
        None
    );
    assert_eq!(
        download_target(&json!({"data":[{"download_url":"https://fixture.uc.cn/video"}]})).unwrap(),
        "https://fixture.uc.cn/video"
    );
    assert!(
        download_target(
            &json!({"data":{"video_list":[{"video_info":{"url":"https://quark-only.invalid"}}]}})
        )
        .is_err()
    );
    assert!(download_target(&json!({"data":[{"download_url":""}]})).is_err());
    assert!(!has_download_cookie("__puus="));
    assert!(!has_download_cookie("x__puus=wrong"));
    assert!(has_download_cookie("other=value; __puus=session"));
}
