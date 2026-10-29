"""一次一请求的 Python Spider worker；执行范围由原生层授权，进程不是安全沙箱。"""

import contextlib
import importlib.abc
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import sys
import types
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from base.spider import HostError

MAX_REQUEST = 16 * 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024
MAX_LOG = 64 * 1024


class BoundedLog(io.TextIOBase):
    """限制插件 print 的输出，避免日志污染协议或无限占用内存。"""

    def __init__(self, output):
        self.output = output
        self.remaining = MAX_LOG

    def write(self, value):
        """只输出剩余额度内的日志，超过后终止本次执行。"""
        encoded = str(value).encode("utf-8")
        if len(encoded) > self.remaining:
            raise HostError("插件日志超过 64 KiB")
        self.remaining -= len(encoded)
        self.output.write(str(value))
        return len(value)

    def flush(self):
        """同步底层错误输出。"""
        self.output.flush()


class BundleImports(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """仅从已授权 bundle 解析来源 Python 模块，不自动访问网络。"""

    def __init__(self, entry, modules):
        self.entry = entry
        self.modules = modules
        self.sources = {}

    def find_spec(self, fullname, path=None, target=None):
        """查找 bundle 中的同目录模块或包。"""
        if fullname == "base" or fullname.startswith("base."):
            return None
        relative = fullname.replace(".", "/")
        for suffix, package in ((relative + ".py", False), (relative + "/__init__.py", True)):
            url = urllib.parse.urljoin(self.entry, suffix)
            if url in self.modules:
                self.sources[fullname] = (url, package)
                return importlib.util.spec_from_loader(fullname, self, is_package=package)
        return None

    def create_module(self, spec):
        """由 Python 创建标准模块。"""
        return None

    def exec_module(self, module):
        """编译并执行 bundle 模块，不写入宿主文件。"""
        url, package = self.sources[module.__name__]
        module.__file__ = url
        if package:
            module.__path__ = [url.rsplit("/", 1)[0]]
        exec(compile(self.modules[url], url, "exec"), module.__dict__)


def call_supported(method, *args):
    """兼容 Spider 常见签名中省略分页等尾部可选参数的变体。"""
    signature = inspect.signature(method)
    if any(p.kind == p.VAR_POSITIONAL for p in signature.parameters.values()):
        return method(*args)
    positional = [p for p in signature.parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    return method(*args[:len(positional)])


def execute(request):
    """加载已授权插件并分发标准 Spider 操作，返回结果与来源缓存。"""
    from base.spider import Spider as BaseSpider
    bundle = request["bundle"]
    source = bundle["modules"][bundle["entry"]]
    if not isinstance(source, str) or source.lstrip().lower().startswith(("<!doctype", "<html")):
        raise HostError("插件内容不是 Python 脚本")
    imports = BundleImports(bundle["entry"], bundle["modules"])
    sys.meta_path.insert(0, imports)
    module = types.ModuleType("mqtv_plugin")
    module.__file__ = bundle["entry"]
    module.__package__ = ""
    sys.modules[module.__name__] = module
    exec(compile(source, bundle["entry"], "exec"), module.__dict__)
    plugin_type = getattr(module, "Spider", None)
    if not isinstance(plugin_type, type) or not issubclass(plugin_type, BaseSpider):
        raise HostError("插件必须提供继承 base.spider.Spider 的 Spider 类")
    spider = plugin_type()
    if not hasattr(spider, "_session"):
        spider._session = None
    storage = request.get("storage") or {}
    if not isinstance(storage, dict):
        raise HostError("插件缓存必须是对象")
    spider._storage = storage
    if callable(getattr(spider, "init", None)):
        spider.init(bundle.get("ext", ""))
    args = request.get("args") or {}
    action = request["action"]
    routes = {
        "search": ("searchContent", (args.get("keyword", ""), False, str(args.get("page", 1)))),
        "detail": ("detailContent", ([str(args.get("id", ""))],)),
        "play": ("playerContent", (args.get("flag", ""), str(args.get("id", "")), args.get("flags", []))),
        "home": ("homeContent", (True,)),
        "homeVod": ("homeVideoContent", ()),
        "category": ("categoryContent", (str(args.get("id", "")), str(args.get("page", 1)), True, args.get("extend", {}))),
        "proxy": ("localProxy", (args.get("params", {}),)),
    }
    if action not in routes:
        raise HostError("不支持的 Python 插件操作")
    name, parameters = routes[action]
    method = getattr(spider, name, None)
    if not callable(method):
        raise HostError("插件未实现 " + name)
    result = call_supported(method, *parameters)
    if isinstance(result, bytes):
        raise HostError("插件不能通过 JSON 返回原始媒体字节")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            raise HostError("插件响应不是 JSON") from None
    return {"result": result, "storage": spider._storage}


def main():
    """读取单个 JSON 请求，将所有插件日志隔离到 stderr 后输出一个 JSON 响应。"""
    protocol = sys.stdout
    # -I 模式不会把脚本目录加入模块搜索路径，明确加入随包宿主目录。
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    try:
        if len(raw) > MAX_REQUEST:
            raise HostError("插件请求超过 16 MiB")
        request = json.loads(raw)
        with contextlib.redirect_stdout(BoundedLog(sys.stderr)), contextlib.redirect_stderr(BoundedLog(sys.stderr)):
            response = execute(request)
        output = json.dumps(response, ensure_ascii=False, allow_nan=False)
        if len(output.encode("utf-8")) > MAX_OUTPUT:
            raise HostError("插件输出超过 8 MiB")
    except ModuleNotFoundError as error:
        output = json.dumps({"error": "Python 插件缺少依赖：" + str(error.name)}, ensure_ascii=False)
    except BaseException as error:
        # 第三方异常可能含请求头和凭证；不输出异常正文或堆栈。
        kind = type(error).__name__
        safe = str(error) if isinstance(error, HostError) else "执行失败（" + kind + "）"
        output = json.dumps({"error": safe}, ensure_ascii=False)
    protocol.write(output + "\n")
    protocol.flush()


if __name__ == "__main__":
    main()
