use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use md5::{Digest, Md5};
use reqwest::Url;
use rquickjs::{
    Context, Ctx, Error, Function, Module, Runtime,
    loader::{Loader, Resolver},
};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const HOST: &str = include_str!("../../../../runtime/javascript/host.js");
struct BundleLoader(BTreeMap<String, String>);
struct BundleResolver;

/// 借助引擎语法解析收集静态依赖，避免把字符串、注释和正则当成 import。
struct InspectionResolver(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
impl Resolver for InspectionResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
    ) -> rquickjs::Result<String> {
        self.0
            .lock()
            .map_err(|_| Error::new_resolving_message(base, name, "依赖收集失败"))?
            .push(name.to_owned());
        Url::parse(base)
            .and_then(|url| url.join(name))
            .map(|url| url.to_string())
            .map_err(|_| Error::new_resolving_message(base, name, "模块地址无效"))
    }
}
struct InspectionLoader;
impl Loader for InspectionLoader {
    /// 依赖仅以空模块占位；检查期间不下载或执行代码，也不安装宿主 API。
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js>> {
        Module::declare(ctx.clone(), name, "")
    }
}

/// 只编译当前文件并收集 import/re-export；动态 import 不执行、不自动下载。
pub(super) fn static_imports(name: &str, source: &str) -> Result<Vec<String>, String> {
    let imports = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let runtime = Runtime::new().map_err(|_| "无法创建脚本检查环境")?;
    runtime.set_memory_limit(96 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let deadline = Instant::now() + Duration::from_secs(5);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    runtime.set_loader(InspectionResolver(imports.clone()), InspectionLoader);
    let context = Context::full(&runtime).map_err(|_| "无法创建脚本检查上下文")?;
    context.with(|ctx| {
        Module::declare(ctx.clone(), name, source).map_err(|_| {
            let _ = ctx.catch();
            "JS 脚本语法或静态模块解析失败".to_string()
        })?;
        Ok::<_, String>(())
    })?;
    let mut result = imports.lock().map_err(|_| "脚本依赖收集失败")?.clone();
    result.sort();
    result.dedup();
    Ok(result)
}

impl Resolver for BundleResolver {
    /// 仅解析 HTTP 模块名；加载器只允许 bundle 中已审核的源码。
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
    ) -> rquickjs::Result<String> {
        Url::parse(base)
            .and_then(|base| base.join(name))
            .map(|url| url.to_string())
            .map_err(|_| Error::new_resolving_message(base, name, "模块地址无效"))
    }
}
impl Loader for BundleLoader {
    /// 从已信任的模块快照加载源码，不在执行期间动态下载代码。
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js>> {
        let source = self
            .0
            .get(name)
            .ok_or_else(|| Error::new_loading_message(name, "模块未包含在已信任快照中"))?;
        Module::declare(ctx.clone(), name, source.as_bytes())
    }
}

/// 将宿主结果封装为 JSON，JS 层统一抛出失败并记录不可忽略的错误。
fn envelope(result: Result<Value, String>) -> String {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string()
}
/// 解析无内嵌凭证的 HTTP 地址，不提供本地文件与系统协议。
fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "请求地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持无内嵌凭证的 HTTP 请求".into());
    }
    Ok(url)
}
/// 同步宿主桥接到可取消的异步 HTTP，保持规则侧同步契约。
#[cfg(test)]
fn request(url: &str, options: &str, deadline: Instant) -> Result<Value, String> {
    request_scoped(url, options, deadline, None)
}

fn request_scoped(
    url: &str,
    options: &str,
    deadline: Instant,
    signal: Option<crate::request_scope::Signal>,
) -> Result<Value, String> {
    tauri::async_runtime::block_on(crate::request_scope::cancellable(
        signal,
        request_async(url, options, deadline),
    ))
}

/// 执行异步 HTTP；取消时丢弃请求和响应流，不让阻塞规则继续等待服务器超时。
async fn request_async(url: &str, options: &str, deadline: Instant) -> Result<Value, String> {
    let url = http_url(url)?;
    let options: Value = serde_json::from_str(options).map_err(|_| "请求参数无效")?;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(15));
    if remaining.is_zero() {
        return Err("JS 执行超时".into());
    }
    let follow = options["redirect"].as_i64() != Some(0);
    let client = reqwest::Client::builder()
        .timeout(remaining)
        .redirect(if follow {
            reqwest::redirect::Policy::limited(5)
        } else {
            reqwest::redirect::Policy::none()
        })
        .build()
        .map_err(|_| "无法创建脚本网络客户端")?;
    let method = options["method"].as_str().unwrap_or("GET").to_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "HEAD" | "PUT" | "DELETE" | "PATCH"
    ) {
        return Err("不支持的请求方法".into());
    }
    let mut req = client.request(method.parse().map_err(|_| "请求方法无效")?, url);
    if let Some(headers) = options["headers"].as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                req = req.header(name, value);
            }
        }
    }
    if let Some(body) = options["body"].as_str() {
        req = req.body(body.to_owned());
    } else if let Some(data) = options["data"].as_object() {
        req = req.form(data);
    }
    let mut response = req.send().await.map_err(|error| {
        let _ = error;
        "脚本网络请求失败或超时".to_string()
    })?;
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), json!(v))))
        .collect();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "脚本响应读取失败")? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("脚本响应超过 8 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let content = if options["buffer"].as_i64() == Some(2) {
        STANDARD.encode(&bytes)
    } else {
        let encoding = options["encoding"].as_str().unwrap_or("utf-8");
        let codec =
            encoding_rs::Encoding::for_label(encoding.as_bytes()).ok_or("不支持的响应编码")?;
        codec.decode(&bytes).0.into_owned()
    };
    Ok(json!({"code":status,"headers":headers,"content":content}))
}
/// 在 UTF-8、Base64 与十六进制之间转换数据，非法编码显式失败。
fn codec(input: &str, from: &str, to: &str) -> Result<Value, String> {
    let bytes = match from {
        "utf8" => input.as_bytes().to_vec(),
        "base64" => STANDARD
            .decode(input)
            .or_else(|_| STANDARD_NO_PAD.decode(input))
            .map_err(|_| "Base64 数据无效")?,
        "hex" => {
            if input.len() % 2 != 0 {
                return Err("十六进制数据无效".into());
            }
            (0..input.len())
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(input.get(i..i + 2).ok_or("十六进制数据无效")?, 16)
                        .map_err(|_| "十六进制数据无效")
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        _ => return Err("不支持的编码".into()),
    };
    Ok(json!(match to {
        "utf8" => String::from_utf8(bytes).map_err(|_| "数据不是 UTF-8")?,
        "base64" => STANDARD.encode(bytes),
        "hex" => bytes.iter().map(|b| format!("{b:02x}")).collect(),
        _ => return Err("不支持的编码".into()),
    }))
}
/// 将 QuickJS 异常转换为可见错误；不输出脚本上下文或凭证。
fn js_error(ctx: &Ctx<'_>, error: Error) -> String {
    // 第三方异常可能包含响应、Cookie 或令牌，禁止直接展示异常正文。
    if error.is_exception() {
        let _ = ctx.catch();
        if let Ok(errors) = ctx.eval::<String, _>("JSON.stringify(__hostErrors)") {
            if let Ok(values) = serde_json::from_str::<Vec<String>>(&errors) {
                if let Some(message) = values.first() {
                    return format!("JS 宿主：{message}");
                }
            }
        }
        return "JS 插件执行失败，请检查规则版本、语法或站点响应".into();
    }
    "JS 插件运行或模块加载失败".into()
}
/// 在独立且有时限/内存上限的 QuickJS 上下文中执行已信任插件；状态通过显式 storage 返回。
#[cfg(test)]
pub fn execute(
    bundle: &super::ScriptBundle,
    action: &str,
    args: &Value,
    storage: &mut Map<String, Value>,
) -> Result<Value, String> {
    execute_scoped(bundle, action, args, storage, None)
}

/// 按本次窗口调用信号执行规则；计算循环及宿主 HTTP 均响应取消，取消不回写状态。
pub(super) fn execute_scoped(
    bundle: &super::ScriptBundle,
    action: &str,
    args: &Value,
    storage: &mut Map<String, Value>,
    signal: Option<crate::request_scope::Signal>,
) -> Result<Value, String> {
    if signal.as_ref().is_some_and(|signal| signal.is_cancelled()) {
        return Err("脚本调用已取消".into());
    }
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(96 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let generation = super::GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(30);
    let interrupt_signal = signal.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupt_signal
            .as_ref()
            .is_some_and(|signal| signal.is_cancelled())
            || Instant::now() >= deadline
            || super::GENERATION.load(std::sync::atomic::Ordering::Relaxed) != generation
    })));
    runtime.set_loader(BundleResolver, BundleLoader(bundle.modules.clone()));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    let result_signal = signal.clone();
    context.with(|ctx| -> Result<Value,String> {
        let run = || -> rquickjs::Result<(String,String)> {
            let globals=ctx.globals();
            globals.set("__request",Function::new(ctx.clone(),move |url:String,options:String| {
                if signal.as_ref().is_some_and(|signal| signal.is_cancelled()) || super::GENERATION.load(std::sync::atomic::Ordering::Relaxed) != generation { return envelope(Err("脚本调用已取消".into())); }
                let result = request_scoped(&url,&options,deadline,signal.clone());
                if signal.as_ref().is_some_and(|signal| signal.is_cancelled()) || super::GENERATION.load(std::sync::atomic::Ordering::Relaxed) != generation { return envelope(Err("脚本调用已取消".into())); }
                envelope(result)
            })?)?;
            globals.set("__join",Function::new(ctx.clone(),|base:String,path:String| envelope(http_url(&base).and_then(|u|u.join(&path).map(|u|json!(u.to_string())).map_err(|_|"URL 合并失败".into()))))?)?;
            globals.set("__codec",Function::new(ctx.clone(),|text:String,from:String,to:String| envelope(codec(&text,&from,&to)))?)?;
            globals.set("__md5",Function::new(ctx.clone(),|text:String| format!("{:x}",Md5::digest(text.as_bytes())))?)?;
            ctx.eval::<(),_>(format!("globalThis.__storage={};",serde_json::to_string(storage).unwrap()))?;
            ctx.eval::<(),_>(HOST)?;
            if let Some((url,_))=bundle.modules.iter().find(|(url,_)|url.contains("cheerio")) {
                let parser=format!("import * as parser from {}; globalThis.__installParser(parser);",json!(url));
                Module::evaluate(ctx.clone(),"https://mqtv.invalid/parser.js",parser)?.finish::<()>()?;
            }
            let code=format!(r#"import * as imported from {entry};
                const plugin=imported.default || imported;
                const ext={ext}; const args={args}; const action={action};
                if(typeof plugin.init==='function') await plugin.init(ext);
                let result;
                if(action==='search') result=await plugin.search(args.keyword || '',false);
                else if(action==='detail') result=await plugin.detail(args.id);
                else if(action==='play') result=await plugin.play(args.flag || '',args.id,args.flags || []);
                else if(action==='home') result=await plugin.home(true);
                else if(action==='homeVod') result=await plugin.homeVod();
                else if(action==='category') result=await plugin.category(args.id,String(args.page || 1),true,args.extend || {{}});
                else throw new Error('不支持的插件操作');
                if(__hostErrors.length) throw new Error(__hostErrors[0]);
                globalThis.__result=JSON.stringify(typeof result==='string' ? JSON.parse(result) : result);
            "#,entry=json!(bundle.entry),ext=bundle.ext,args=args,action=json!(action));
            Module::evaluate(ctx.clone(),"https://mqtv.invalid/invoke.js",code)?.finish::<()>()?;
            Ok((globals.get("__result")?,ctx.eval("JSON.stringify(__storage)")?))
        };
        let (output,next_storage)=run().map_err(|e|js_error(&ctx,e))?;
        if output.len()>MAX_BYTES || next_storage.len()>1024*1024 { return Err("插件输出超过限制".into()); }
        if result_signal.as_ref().is_some_and(|signal| signal.is_cancelled()) { return Err("脚本调用已取消".into()); }
        *storage=serde_json::from_str(&next_storage).map_err(|_|"插件存储格式无效")?;
        serde_json::from_str(&output).map_err(|_|"插件输出不是有效 JSON".into())
    })
}

#[cfg(test)]
#[path = "../../tests/scripts/javascript.rs"]
mod tests;
