use scraper::{Html, Selector};
use serde_json::{Value, json};

/// 从链接及复制按钮提取 HTTPS 分享；严格限制主机和分享 ID，保留提取码并去重。
fn parse_shares(html: &str, mixed: bool) -> Vec<String> {
    let doc = Html::parse_document(html);
    let selector = Selector::parse("a[href], [data-clipboard-text]").unwrap();
    let host = if mixed {
        r"(?:drive\.uc\.cn|pan\.quark\.cn)"
    } else {
        r"drive\.uc\.cn"
    };
    let pattern = regex::Regex::new(&format!(
        r"https://{host}/s/[A-Za-z0-9]+(?:\?pwd=[A-Za-z0-9]+)?"
    ))
    .unwrap();
    let mut shares = Vec::new();
    for node in doc.select(&selector) {
        for value in [
            node.value().attr("href"),
            node.value().attr("data-clipboard-text"),
        ]
        .into_iter()
        .flatten()
        {
            for matched in pattern.find_iter(value) {
                if value[matched.end()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                {
                    continue;
                }
                let share = matched.as_str().to_string();
                if !shares.contains(&share) {
                    shares.push(share);
                }
            }
        }
    }
    shares
}

/// 读取 UC 分享列表；没有 UC 链接时明确报错，保留独立 UC 调用的错误语义。
pub async fn uc_line_detail(url: String) -> Result<Vec<String>, String> {
    let html = super::super::quark::search::line_detail_html(&url).await?;
    let shares = parse_shares(&html, false);
    if shares.is_empty() {
        return Err("该详情未提供可直接读取的 UC 分享链接，可能需要其他插件适配".into());
    }
    Ok(shares)
}

/// 单次读取简介及 UC 分享；无 UC 链接时返回空数组，便于调用方识别提供商。
pub async fn uc_line_info(url: String) -> Result<Value, String> {
    let html = super::super::quark::search::line_detail_html(&url).await?;
    Ok(
        json!({"shares":parse_shares(&html, false),"synopsis":super::super::quark::search::parse_synopsis(&html)}),
    )
}

/// 单次请求 WoGG 详情并合并两种分享，旧夸克命令的返回语义保持兼容。
pub async fn netdisk_line_info(url: String) -> Result<Value, String> {
    let html = super::super::quark::search::line_detail_html(&url).await?;
    let shares = parse_shares(&html, true);
    if shares.is_empty() {
        return Err("该详情未提供可直接读取的夸克或 UC 分享链接，可能需要其他插件适配".into());
    }
    Ok(json!({"shares":shares,"synopsis":super::super::quark::search::parse_synopsis(&html)}))
}

#[cfg(test)]
#[path = "../../tests/uc/search.rs"]
mod tests;
