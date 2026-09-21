/**
 * ViewHost —— 把 registry 里的 key 映射到真正的组件，并统一注入 props。
 *
 * 为什么单独一个文件：
 *   registry/views.ts 要保持纯数据（不 import .tsx），否则演示界面一多，
 *   主包会被所有视图代码撑大。这里集中做「key → 组件」的映射，
 *   新增视图只改本文件的一行 + 一个组件文件，App.tsx 依然不用动。
 *
 * 为什么不用动态 import(字符串)：
 *   props 类型会丢失（拿到的组件是 ComponentType<any>），而本项目的
 *   ServiceConsole/AdminPanel 都有必需 props。显式分支虽然多几行，
 *   但每个视图的 props 都由 TS 检查，改签名时编译期就会报错。
 */
import type { DshState } from '@/types';
import { ServiceConsole } from './ServiceConsole';
import { AdminPanel } from './AdminPanel';
import { MemoryAtlas } from './MemoryAtlas';
import type { ViewKey } from './registry/views';

export interface ViewHostProps {
  view: ViewKey;
  state: DshState | null;
  status: string;
  /** 终端日志过滤词（来自左侧导航的搜索框） */
  search: string;
  onOpenDsh: () => void;
  /** 重新读取运行状态 */
  onChanged: () => void;
}

export function ViewHost({ view, state, status, search, onOpenDsh, onChanged }: ViewHostProps) {
  if (view === 'console') {
    return <ServiceConsole status={status} state={state} onOpenDsh={onOpenDsh} search={search} />;
  }
  if (view === 'admin') {
    return <AdminPanel state={state} status={status} onChanged={onChanged} />;
  }
  // 记忆地形：点云视图，自身不依赖运行状态
  return <MemoryAtlas />;
}
