type Viewport = {
  readTop: () => number;
  scrollTo: (top: number) => void;
};

/**
 * 记住本次运行中搜索结果的滚动位置，离开前保存、重新挂载后恢复。
 * 只在搜索页面可见时采集位置，切换影片来源或其他页面不会覆盖记忆；新搜索显式重置。
 */
export function createSearchScrollMemory(viewport: Viewport) {
  let top = 0;
  let visible = false;
  return {
    /** 搜索结果完成挂载后恢复位置，不发起搜索请求。 */
    enter(): void {
      visible = true;
      viewport.scrollTo(top);
    },
    /** 在页面切换或打开详情重置窗口之前保存，只采集可见的搜索结果位置。 */
    leave(): void {
      if (!visible) return;
      const current = viewport.readTop();
      top = Number.isFinite(current) ? Math.max(0, current) : 0;
      visible = false;
    },
    /** 提交有效的新搜索时清除旧位置，可见页面同时回到顶部。 */
    reset(): void {
      top = 0;
      if (visible) viewport.scrollTo(0);
    },
  };
}
