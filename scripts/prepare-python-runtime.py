#!/usr/bin/env python3
"""下载固定版本 CPython 与已锁定 wheel，校验摘要后准备随包运行时。"""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path(__file__).with_name('runtime-manifest.json')


def current_target():
    """将构建主机映射到受支持的分发架构。"""
    system = platform.system()
    machine = platform.machine().lower()
    architecture = 'arm64' if machine in ('arm64', 'aarch64') else 'x64' if machine in ('x86_64', 'amd64') else machine
    return {'Darwin':'darwin', 'Windows':'windows'}.get(system, system.lower()) + '-' + architecture


def download(url, expected, cache):
    """下载并校验 SHA-256，不接受摘要不符的缓存或网络内容。"""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / expected
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        return target
    temporary = target.with_suffix('.partial')
    request = urllib.request.Request(url, headers={'User-Agent':'MQTV-runtime-builder/1'})
    digest = hashlib.sha256()
    for attempt in range(3):
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open('wb') as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    if digest.hexdigest() != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError('运行时下载 SHA-256 不匹配')
    temporary.replace(target)
    return target


def inside(path, root):
    """校验归档目标是否仍位于临时目录中。"""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def extract_runtime(archive, directory):
    """解压 CPython，拒绝越界路径、设备文件和越界符号链接。"""
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            destination = directory / member.name
            if not inside(destination, directory) or member.isdev() or member.isfifo():
                raise RuntimeError('运行时归档包含非法路径')
            if member.issym() and not inside(destination.parent / member.linkname, directory):
                raise RuntimeError('运行时归档包含越界符号链接')
            if member.islnk() and not inside(directory / member.linkname, directory):
                raise RuntimeError('运行时归档包含越界硬链接')
        package.extractall(directory, filter='data')


def install_wheel(wheel, site):
    """将已校验 wheel 的纯 Python、二进制库及许可证安装到随包 site-packages。"""
    with zipfile.ZipFile(wheel) as package:
        for name in package.namelist():
            if name.endswith('/'):
                continue
            parts = Path(name).parts
            if parts[0].endswith('.data'):
                if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
                    continue
                parts = parts[2:]
            destination = site.joinpath(*parts)
            if not inside(destination, site):
                raise RuntimeError('wheel 包含非法路径')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(package.read(name))


def main():
    """按目标架构准备独立 CPython；全过程不修改系统解释器或安装全局依赖。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', default=current_target(), choices=['darwin-arm64','darwin-x64','windows-x64'])
    parser.add_argument('--output', type=Path, default=ROOT / 'src-tauri/runtime/python')
    parser.add_argument('--cache', type=Path, default=Path(tempfile.gettempdir()) / 'mqtv-python-downloads')
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    runtime = manifest['runtimes'][args.target]
    archive = download(runtime['url'], runtime['sha256'], args.cache)
    output = args.output.resolve()
    # 只替换本工具创建的运行时目录；拒绝覆盖未知目录。
    if output.exists() and any(output.iterdir()) and not (output / 'mqtv-runtime.json').exists():
        raise RuntimeError('输出目录已有未知文件，请选择空目录')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='mqtv-python-', dir=output.parent) as temporary:
        staging = Path(temporary)
        extract_runtime(archive, staging)
        python = staging / 'python'
        site = python / ('Lib/site-packages' if args.target.startswith('windows') else 'lib/python3.12/site-packages')
        site.mkdir(parents=True, exist_ok=True)
        for name, dependency in manifest['dependencies'].items():
            wheel = dependency['wheels'][args.target]
            print('校验并安装', name, dependency['version'], flush=True)
            install_wheel(download(wheel['url'], wheel['sha256'], args.cache), site)
        marker = {'target':args.target,'pythonVersion':manifest['pythonVersion'], 'runtimeSha256':runtime['sha256'],
                  'dependencies':{name: {'version':item['version'], 'sha256':item['wheels'][args.target]['sha256']} for name,item in manifest['dependencies'].items()}}
        (python / 'mqtv-runtime.json').write_text(json.dumps(marker, ensure_ascii=False, indent=2))
        backup = output.with_name(output.name + '.previous')
        if backup.exists():
            raise RuntimeError('发现之前准备过程的备份目录，请先检查')
        if output.exists():
            output.rename(backup)
        try:
            python.rename(output)
        except BaseException:
            if backup.exists():
                backup.rename(output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    print('已准备', args.target, output)


if __name__ == '__main__':
    main()
