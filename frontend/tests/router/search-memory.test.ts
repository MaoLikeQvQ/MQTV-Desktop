import { describe, expect, it, vi } from 'vitest';
import { createSearchScrollMemory } from '@/router/search-memory';

describe('search navigation memory', () => {
  it('restores a result position after detail and ignores detail/source-switch scrolling', () => {
    let top = 0;
    const scrollTo = vi.fn((value: number) => { top = value; });
    const memory = createSearchScrollMemory({ readTop: () => top, scrollTo });
    memory.enter();
    top = 1540;
    memory.leave(); // 打开影片之前采集搜索位置。
    top = 0; // 详情页回到顶部。
    memory.leave(); // 详情页切换来源，不能覆盖搜索位置。
    top = 360;
    memory.leave(); // 详情跳去历史或设置，同样不能覆盖。
    memory.enter();
    expect(top).toBe(1540);
    top = 2140;
    memory.leave();
    top = 0;
    memory.enter();
    expect(top).toBe(2140);
  });

  it('resets a new search both from the visible results and from another page', () => {
    let top = 0;
    const memory = createSearchScrollMemory({ readTop: () => top, scrollTo: value => { top = value; } });
    memory.enter();
    top = 900;
    memory.reset();
    expect(top).toBe(0);
    top = 500;
    memory.leave();
    top = 120;
    memory.reset(); // 从推荐页提交新片名，不能使用上一次结果的位置。
    expect(top).toBe(120);
    memory.enter();
    expect(top).toBe(0);
  });
});
