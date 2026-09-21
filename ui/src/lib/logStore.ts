import { useSyncExternalStore } from 'react';

/**
 * 终端日志全局 store
 *
 * 目的：修「双界面终端在切换后会被清空」。
 * 旧实现把日志存在 ServiceConsole 组件内部 state —— Tabs 切换（服务终端 ⇄ 管理后台）
 * 时 Radix 会卸载非激活的 TabsContent，State 随组件一起蒸发，切回来一片空白。
 * 这里把日志提升到模块级单例：无论组件怎么挂载/卸载，日志永远在。
 * 另外只在这里注册一次 onServerLog 监听，避免组件重挂后重复订阅导致日志翻倍。
 */

const MAX_LINES = 2000;

type Listener = () => void;

let lines: string[] = [];
const listeners = new Set<Listener>();
let bridgeInstalled = false;

function emit() {
  for (const fn of listeners) fn();
}

/** 在顶层（App 挂载时）调用一次：把 Electron 日志桥接到 store */
export function installLogBridge() {
  if (bridgeInstalled || typeof window === 'undefined' || !window.dshDesktop?.onServerLog) return;
  bridgeInstalled = true;
  window.dshDesktop.onServerLog((chunk) => {
    const incoming = String(chunk ?? '').split(/\r?\n/);
    if (incoming.length === 0) return;
    lines = lines.concat(incoming).slice(-MAX_LINES);
    emit();
  });
}

export function subscribeLogs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLogLines(): string[] {
  return lines;
}

/** React 侧订阅入口：组件卸载不影响 store 内容 */
export function useServerLogs(): string[] {
  return useSyncExternalStore(subscribeLogs, getLogLines, getLogLines);
}

/** 供「清屏」按钮使用 */
export function clearLogs() {
  if (lines.length === 0) return;
  lines = [];
  emit();
}