"""受控 Python Spider worker 协议测试，不运行远程插件。"""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[4]
WORKER = ROOT / 'runtime/python/worker.py'
SOURCE = '''from base.spider import Spider
class Spider(Spider):
 def init(self, ext): self.ext = ext
 def searchContent(self, key, quick, pg='1'):
  print('plugin log')
  self.setCache('query', key)
  return {'list':[{'vod_id':'opaque:id','vod_name':key}], 'page':pg}
 def detailContent(self, ids): return {'list':[{'vod_id':ids[0], 'vod_play_from':'test','vod_play_url':'第一集$opaque:episode'}]}
 def playerContent(self, flag, id, flags): return {'parse':0,'url':'https://media.example/video.mp4','header':{'Referer':'https://site.example/'}}
 def localProxy(self, params): return self.proxyM3u8(params['url'], {'Referer':'https://site.example/'})
'''


class WorkerTests(unittest.TestCase):
    def request(self, action, args, source=SOURCE, storage=None):
        request = {'bundle': {'entry':'https://example.test/plugin.py','modules':{'https://example.test/plugin.py':source},'ext':{'sample':1},'digest':'test'}, 'action':action,'args':args,'storage':storage or {}}
        result = subprocess.run([sys.executable, '-I', str(WORKER)], input=json.dumps(request), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stderr

    def test_search_keeps_opaque_id_and_storage_logs_on_stderr(self):
        response, logs = self.request('search', {'keyword':'动画','page':2})
        self.assertEqual(response['result']['list'][0]['vod_id'], 'opaque:id')
        self.assertEqual(response['result']['page'], '2')
        self.assertEqual(response['storage'], {'query':'动画'})
        self.assertIn('plugin log', logs)

    def test_detail_and_play(self):
        response, _ = self.request('detail', {'id':'opaque:id'})
        self.assertIn('opaque:episode', response['result']['list'][0]['vod_play_url'])
        response, _ = self.request('play', {'flag':'test','id':'opaque:episode','flags':['test']})
        self.assertEqual(response['result']['parse'], 0)
        self.assertIn('Referer', response['result']['header'])

    def test_proxy_description(self):
        response, _ = self.request('proxy', {'params':{'url':'https://media.example/a.m3u8'}})
        self.assertEqual(response['result'][2]['mqtvMedia']['url'], 'https://media.example/a.m3u8')

    def test_exception_does_not_leak_sensitive_message(self):
        response, _ = self.request('search', {}, "raise RuntimeError('secret-token')")
        self.assertNotIn('secret-token', json.dumps(response))
        self.assertIn('error', response)

    def test_missing_dependency_visible(self):
        response, _ = self.request('search', {}, 'import mqtv_missing_dependency')
        self.assertIn('mqtv_missing_dependency', response['error'])

    def test_html_rejected(self):
        response, _ = self.request('search', {}, '<!doctype html><html>error</html>')
        self.assertIn('不是 Python', response['error'])

    def test_log_overflow(self):
        response, _ = self.request('search', {}, "print('x'*70000)")
        self.assertIn('日志', response['error'])

    def test_plugin_value_error_cannot_spoof_host_message(self):
        response, _ = self.request('search', {}, "raise ValueError('插件 secret-token')")
        self.assertNotIn('secret-token', json.dumps(response))

    def test_bundled_sample_dependencies_import(self):
        source = SOURCE.replace("print('plugin log')", "import requests, bs4, Crypto.Cipher.AES, Crypto.Cipher.ARC4, lxml.etree")
        response, _ = self.request('search', {'keyword':'dependencies'}, source)
        self.assertEqual(response['result']['list'][0]['vod_name'], 'dependencies')

    def test_short_search_signature(self):
        source = SOURCE.replace("def searchContent(self, key, quick, pg='1'):", 'def searchContent(self, key, quick):').replace("'page':pg", "'page':1")
        response, _ = self.request('search', {'keyword':'sample'}, source)
        self.assertEqual(response['result']['page'], 1)


if __name__ == '__main__':
    unittest.main()
