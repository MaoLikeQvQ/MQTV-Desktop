use reqwest::Url;

/// 读取编译时注入的后台地址，仅接受不含路径、参数和凭证的 HTTP(S) 域名。
pub(crate) fn backend_url() -> Result<Url, String> {
    let url = Url::parse(env!("MQTV_API_BASE_URL")).map_err(|_| "VITE_API_BASE_URL 地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("VITE_API_BASE_URL 必须为不含路径、参数和凭证的 HTTP(S) 域名".into());
    }
    Ok(url)
}

/// 基于已校验的后台地址拼接接口路径，返回完整请求地址。
pub(crate) fn backend_endpoint(path: &str) -> Result<Url, String> {
    backend_url()?
        .join(path)
        .map_err(|_| "后台接口地址无效".into())
}

#[cfg(test)]
#[path = "tests/config.rs"]
mod tests;
