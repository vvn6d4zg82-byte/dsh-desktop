import { useEffect, useRef, useState } from 'react';

/**
 * 「从任务栏弹出 / 缩回」动画（Steam 式）。
 *
 * 主进程在最小化/还原/全屏切换时通过 win-anim 事件告知阶段，这里把它翻译成
 * .p-app 上的一个动画类名，由 CSS 负责具体的缩放 + 位移 + 淡入淡出。
 *
 * 设计取舍：
 * - 缩回（minimizing）时窗口马上要被最小化，动画只给很短时间（~140ms），
 *   太长会看到窗口已经下去了动画还在放。
 * - 弹出（restoring/focused）时窗口已经在屏幕上，动画时长可以稍长一点。
 * - 动画结束后必须摘掉类名，否则类名残留会让下次切换不再触发动画（同名 class 不会重启动画）。
 */
export type WinAnimPhase = 'minimizing' | 'minimized' | 'restoring' | 'focused' | 'fullscreen-on' | 'fullscreen-off';

export function useWindowAnim() {
  const [animClass, setAnimClass] = useState('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onAnim = (phase: string) => {
      const p = phase as WinAnimPhase;
      let cls = '';
      let ms = 0;
      if (p === 'minimizing') {
        cls = 'p-anim-shrink';
        ms = 140;
      } else if (p === 'restoring' || p === 'focused') {
        cls = 'p-anim-pop';
        ms = 260;
      } else if (p === 'fullscreen-on' || p === 'fullscreen-off') {
        cls = 'p-anim-pop';
        ms = 220;
      } else {
        return; // minimized：窗口已不可见，不需要动画
      }
      clear();
      // 先摘掉旧类名再上新的，保证同名动画能重新播放
      setAnimClass('');
      requestAnimationFrame(() => {
        setAnimClass(cls);
        timerRef.current = window.setTimeout(() => {
          setAnimClass('');
          timerRef.current = null;
        }, ms);
      });
    };

    // 老版本 preload 可能没有 onWinAnim（升级过渡期）——不能让它抛错把整个 UI 带崩
    if (typeof window.dshDesktop?.onWinAnim !== 'function') return clear;
    window.dshDesktop.onWinAnim(onAnim);
    return clear;
  }, []);

  return animClass;
}
