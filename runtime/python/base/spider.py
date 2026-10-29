"""TVBox Python Spider 的受支持宿主接口，不构成系统权限沙箱。"""

import base64
import json
import re
import urllib.parse

class HostError(Exception):
    """宿主生成且可向用户展示的错误。"""


MAX_RESPONSE = 8 * 1024 * 1024


class Spider:
    """提供请求、来源独立缓存与由原生媒体服务承接的代理描述。"""

    def __init__(self):
        self._storage = {}
        self._session = None

    def _http(self, method, url, **kwargs):
        """执行有超时和读取上限的 HTTP 请求，返回 requests.Response。"""
        import requests
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            raise HostError("请求仅支持不含凭证的 HTTP(S) 地址")
        if self._session is None:
            self._session = requests.Session()
            self._session.trust_env = False
            self._session.max_redirects = 5
        kwargs.setdefault("timeout", 15)
        kwargs["stream"] = True
        response = self._session.request(method, url, **kwargs)
        response.raise_for_status()
        chunks = []
        size = 0
        try:
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > MAX_RESPONSE:
                    raise HostError("插件请求响应超过 8 MiB")
                chunks.append(chunk)
        finally:
            response.close()
        response._content = b"".join(chunks)
        response._content_consumed = True
        return response

    def fetch(self, url, params=None, cookies=None, headers=None, timeout=15, verify=True, **kwargs):
        """按 Python Spider 约定发送 GET，保留响应文本、JSON 与状态。"""
        return self._http("GET", url, params=params, cookies=cookies, headers=headers,
                          timeout=timeout, verify=verify, **kwargs)

    def post(self, url, data=None, json=None, cookies=None, headers=None, timeout=15, verify=True, **kwargs):
        """按 Python Spider 约定发送 POST，使用相同超时和大小边界。"""
        return self._http("POST", url, data=data, json=json, cookies=cookies,
                          headers=headers, timeout=timeout, verify=verify, **kwargs)

    def getCache(self, key):
        """读取仅属于当前来源及脚本摘要的缓存值。"""
        return self._storage.get(str(key))

    def setCache(self, key, value):
        """保存可 JSON 序列化的来源缓存，交由原生层持久化。"""
        json.dumps(value, ensure_ascii=False, allow_nan=False)
        self._storage[str(key)] = value

    def delCache(self, key):
        """删除当前来源缓存中的指定键。"""
        self._storage.pop(str(key), None)

    def getProxyUrl(self, local=True):
        """返回宿主专用代理标记，原生层转换成随机回环地址。"""
        return "mqtv-python-proxy://local?"

    def _proxy(self, url, headers=None, content_type="application/octet-stream"):
        """返回媒体请求描述，媒体字节由原生层读取，避免 JSON 承载视频。"""
        if isinstance(url, dict):
            headers = url.get("headers", url.get("header", headers))
            url = url.get("url", "")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            raise HostError("代理仅支持不含凭证的 HTTP(S) 地址")
        if isinstance(headers, str):
            headers = json.loads(headers) if headers else {}
        return [200, content_type, {"mqtvMedia": {"url": url, "headers": headers or {}}}, {}]

    def proxyM3u8(self, url, headers=None, *args, **kwargs):
        """请求宿主转发并改写 HLS 清单、分片与密钥地址。"""
        return self._proxy(url, headers, "application/vnd.apple.mpegurl")

    def proxyMedia(self, url, headers=None, *args, **kwargs):
        """请求宿主按 Range 流式转发媒体。"""
        return self._proxy(url, headers)

    def proxyTs(self, url, headers=None, *args, **kwargs):
        """请求宿主转发 MPEG-TS 分片。"""
        return self._proxy(url, headers, "video/mp2t")

    def log(self, message):
        """输出调试信息到 worker 的 stderr 日志通道。"""
        print(message)

    def jsonParse(self, text):
        """解析 JSON 字符串；错误继续向调用方抛出。"""
        return json.loads(text)

    def regStr(self, text, pattern, group=1):
        """返回首个正则匹配组，没有匹配时返回空串。"""
        match = re.search(pattern, text)
        return match.group(group) if match else ""

    def base64Encode(self, value):
        """将 UTF-8 文本或字节编码为 Base64 ASCII。"""
        return base64.b64encode(value.encode() if isinstance(value, str) else value).decode()

    def base64Decode(self, value):
        """解码 Base64 到 UTF-8 文本。"""
        return base64.b64decode(value).decode()

    def loadModule(self, name):
        """拒绝未包含在已校验 bundle 中的动态模块加载。"""
        raise HostError("插件动态模块尚未包含在已授权脚本中")
