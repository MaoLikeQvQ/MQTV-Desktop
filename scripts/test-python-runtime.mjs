import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 使用当前应用自带 Python 运行协议测试，不依赖系统解释器。 */
function main() {
  const executable = fileURLToPath(new URL(process.platform === 'win32' ? '../src-tauri/runtime/python/python.exe' : '../src-tauri/runtime/python/bin/python3', import.meta.url));
  if (!existsSync(executable)) throw new Error('请先运行 npm run runtime:prepare');
  const test = fileURLToPath(new URL('../src-tauri/src/tests/scripts/python_worker_test.py', import.meta.url));
  const result = spawnSync(executable, ['-I', '-B', test], { stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main();
