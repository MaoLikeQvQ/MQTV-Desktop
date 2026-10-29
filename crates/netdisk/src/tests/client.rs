use super::*;

#[test]
fn missing_share_file_is_not_an_authorization_error() {
    let result = decode_api_response(
        404,
        "share/sharepage/token?pr=ucpro&fr=pc",
        Some(json!({"status":404,"code":41004,"message":"文件不存在"})),
    );
    let error = result.unwrap_err();
    assert!(error.contains("分享中的文件已删除或不存在"), "{error}");
    assert!(error.contains("切换影片来源"), "{error}");
    assert_ne!(error, "AUTH_INVALID");
}

#[test]
fn expired_share_is_reported_without_leaking_response_secrets() {
    let error = decode_api_response(
        404,
        "share/sharepage/token",
        Some(json!({"status":404,"code":41006,"message":"sensitive-body-must-not-appear"})),
    )
    .unwrap_err();
    assert!(error.contains("分享不存在或已失效"), "{error}");
    assert!(!error.contains("sensitive-body"));
}

#[test]
fn authentication_and_transport_errors_remain_distinct() {
    assert_eq!(
        decode_api_response(401, "file/sort", None).unwrap_err(),
        "AUTH_INVALID"
    );
    assert_eq!(
        decode_api_response(200, "file/sort", Some(json!({"status":401}))).unwrap_err(),
        "AUTH_INVALID"
    );
    assert!(
        decode_api_response(503, "share/sharepage/token", None)
            .unwrap_err()
            .contains("HTTP 503")
    );
    assert!(
        decode_api_response(200, "file/sort", None)
            .unwrap_err()
            .contains("响应格式无效")
    );
    assert!(
        decode_api_response(
            200,
            "file/sort",
            Some(json!({"status":200,"code":0,"data":{}}))
        )
        .is_ok()
    );
}
