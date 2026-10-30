static JOB: std::sync::OnceLock<mqtv_parser::ParseJob> = std::sync::OnceLock::new();

/// 解析并交接已校验响应；缓存结果准备失败时仅刷新一次，不重试首次网络失败。
pub(crate) async fn play(url: String) -> Result<String, String> {
    let job = JOB.get_or_init(Default::default);
    let request = mqtv_parser::ParseRequest::new(url);
    let result = job.start(request.clone(), Default::default(), None).await?;
    let cached = result.cache_hit;
    let prepared = crate::features::scripts::media::start_parsed(result).await;
    // 只刷新明确失效的缓存地址；连接失败、超时及切集过期不触发重试。
    let stale = prepared.as_ref().err().is_some_and(|error| {
        [401, 403, 404, 410]
            .iter()
            .any(|status| error.starts_with(&format!("视频服务 HTTP {status}，")))
            || error.starts_with("播放地址返回网页")
    });
    if stale && cached {
        job.invalidate(&request);
        let result = job.start(request, Default::default(), None).await?;
        crate::features::scripts::media::start_parsed(result).await
    } else {
        prepared
    }
}
