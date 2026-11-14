/**
 * src/charts/useElementWidth.ts —— 量一个元素的宽度（ResizeObserver）。
 *
 * SVG 图表必须知道容器像素宽度：`viewBox` + `preserveAspectRatio` 也能缩放，
 * 但那样 stroke-width 会跟着一起缩放——同一条线在 400px 和 1200px 的容器里
 * 粗细不同。所以这里量真实宽度，用 `width` 属性画 1:1 的图。
 *
 * 首帧（observer 还没回调）返回 0，由调用方渲染骨架或空占位，别拿 0 当宽度
 * 画出一个负坐标的图。
 */

import { useEffect, useState, type RefObject } from 'react';

export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  fallback = 0,
): number {
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // 首帧先同步量一次：observer 的第一帧是异步的，期间图表会是空的。
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number' && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
