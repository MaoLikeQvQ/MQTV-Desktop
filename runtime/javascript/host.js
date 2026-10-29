// 本文件只提供受限宿主能力；站点规则和第三方引擎由已信任的 bundle 提供。
/** 解包原生调用结果，记录错误以避免规则内部 catch 将失败伪装为空列表。 */
function nativeResult(text) {
  const result = JSON.parse(text);
  if (!result.ok) { globalThis.__hostErrors.push(result.error); throw new Error(result.error); }
  return result.value;
}
globalThis.__hostErrors = [];
/** 丢弃第三方规则日志，防止响应正文、Cookie 或搜索内容进入应用日志。 */
function discardLog() {}
globalThis.console = { log: discardLog, info: discardLog, warn: discardLog, error: discardLog, debug: discardLog };
globalThis.print = console.log;
globalThis.log = console.log;
globalThis.req = (url, options = {}) => nativeResult(__request(String(url), JSON.stringify(options)));
globalThis.joinUrl = (base, path) => nativeResult(__join(String(base), String(path)));
globalThis.urlencode = encodeURIComponent;
globalThis.local = {
  /** 读取当前来源和命名空间下的规则状态，缺省返回空字符串。 */
  get(namespace, key) { return __storage[JSON.stringify([namespace, key])] ?? ''; },
  /** 在当前调用的隔离状态中写入字符串，成功后由原生层持久化。 */
  set(namespace, key, value) { __storage[JSON.stringify([namespace, key])] = String(value); },
  /** 删除当前来源命名空间中的指定规则状态。 */
  delete(namespace, key) { delete __storage[JSON.stringify([namespace, key])]; }
};
/** 将编码数据转换为可由 CryptoJS 常见接口消费的轻量字节对象。 */
function word(text, encoding = 'utf8') {
  return { text: String(text), encoding,
    /** 按指定编码输出字节对象，缺省保留当前编码文本。 */
    toString(codec) { return codec ? codec.stringify(this) : this.text; } };
}
const codecs = {};
for (const [name, encoding] of [['Utf8','utf8'], ['Base64','base64'], ['Hex','hex']]) {
  codecs[name] = {
    /** 按声明编码包装输入，实际转换时验证数据。 */
    parse(text) { return word(text, encoding); },
    /** 调用原生编码转换，非法输入显式失败。 */
    stringify(value) { return nativeResult(__codec(value.text, value.encoding, encoding)); }
  };
}
const crypto = { enc: codecs,
  /** 计算字符串的 MD5 并返回兼容常用 CryptoJS 输出的对象。 */
  MD5(text) { return word(__md5(String(text)), 'hex'); } };
globalThis.CryptoJS = new Proxy(crypto, {
  /** 拒绝未实现的加密算法，并记录不可被规则吞掉的兼容错误。 */
  get(target, key) {
    if (key in target) return target[key];
    const message = '当前 JS 宿主未支持 CryptoJS.' + String(key);
    __hostErrors.push(message); throw new Error(message);
  }
});
globalThis.md5 = text => __md5(String(text));
globalThis.base64Encode = text => nativeResult(__codec(String(text), 'utf8', 'base64'));
globalThis.base64Decode = text => nativeResult(__codec(String(text), 'base64', 'utf8'));
/** 初始化基于已信任 cheerio 模块的 TVBox DOM 选择器接口。 */
globalThis.__installParser = function (cheerio) {
  /** 按 && 链依次选取元素，支持 -- 子节点排除语法。 */
  function select(html, expression) {
    const $ = cheerio.load(String(html));
    let current = $.root();
    for (const raw of expression.split('&&').filter(Boolean)) {
      const [selector, ...exclude] = raw.split('--');
      if (selector !== 'body' || !current.is('body')) current = current.find(selector);
      if (exclude.length) { current = current.clone(); for (const item of exclude) current.find(item).remove(); }
    }
    return { $, current };
  }
  /** 提取首个匹配元素的文本、HTML 或属性。 */
  globalThis.pdfh = (html, expression) => {
    const parts = expression.split('&&'); const attribute = parts.pop();
    const { current } = select(html, parts.join('&&'));
    if (attribute === 'Text') return current.first().text().trim();
    if (attribute === 'Html') return current.first().html() || '';
    return current.first().attr(attribute) || '';
  };
  /** 将匹配列表转换为 HTML 片段，供规则继续解析。 */
  globalThis.pdfa = (html, expression) => {
    const { $, current } = select(html, expression);
    return current.toArray().map(element => $.html(element));
  };
  /** 提取属性并按传入页面地址补全链接。 */
  globalThis.pd = (html, expression, base = '') => {
    const value = pdfh(html, expression);
    return value && base ? joinUrl(base, value) : value;
  };
};
