/**
 * 视图注册表 —— 「以后要加很多演示界面」的落地机制。
 *
 * 之前的问题：App.tsx 里写死了 `type ViewId = 'console' | 'admin'`，加第三个视图
 * 要改 4 处（类型、navItems、内容区挂载、状态）。演示界面一多必然失控。
 *
 * 现在：视图是**数据**。加一个演示界面 = 往 VIEWS 里加一条 + 写一个组件文件，
 * App.tsx 一个字都不用改。注册表同时驱动：
 *   - 左侧导航（按 group 自动分组、自动排序）
 *   - 内容区渲染（由 ViewHost 按 key 挂载对应组件）
 *   - 代码分割（演示界面在 charts/ChartCard 内部按需拉取图表库）
 *
 * 本文件保持「纯数据」：不 import 任何 .tsx，因此不会把视图代码牵进主包，
 * 也不会形成 registry ↔ view 的循环依赖。
 */
import type { ComponentType } from 'react';
import { LayoutDashboard, Network, TerminalSquare } from 'lucide-react';

/** 导航分组：越靠前越上层。新演示界面默认进「演示」。 */
export type ViewGroup = '运行' | '演示' | '系统';

export type ViewKey = 'console' | 'atlas' | 'admin';

export interface ViewDef {
  key: ViewKey;
  label: string;
  /** 左侧导航图标 */
  icon: ComponentType<{ className?: string }>;
  group: ViewGroup;
  /** 一句话说明，作为鼠标悬停提示 */
  hint: string;
  /**
   * 常驻挂载（保活）。
   *
   * ⚠ 终端（console）此项**不可改为 false**，这是硬性契约：
   *   - logStore.ts 已把日志提升到模块级单例，所以「日志内容」不会丢；
   *   - 但 ServiceConsole 自己的滚动位置（scrollerRef 的 scrollTop）、文件树的
   *     展开状态与 dirCache 是组件内 state —— 一旦卸载就重置，
   *     症状就是「切回来日志还在，但跳回了顶部、文件树收起来了」。
   *   - 这正是 logStore.ts 注释里记录的那类回归，别让它以另一种形式回来。
   *
   * 演示界面按需挂载 —— 演示界面会越加越多，全部保活会白占内存。
   */
  keepAlive: boolean;
}

export const VIEWS: ViewDef[] = [
  {
    key: 'console',
    label: '服务终端',
    icon: TerminalSquare,
    group: '运行',
    hint: '实时日志 + 文件浏览 + 服务启停',
    keepAlive: true,
  },
  {
    key: 'atlas',
    label: '记忆地形',
    icon: Network,
    group: '演示',
    hint: '会话记忆点云：拖动平移、滚轮缩放、悬停看单条（移植自 bee/viz/memory-atlas）',
    keepAlive: false,
  },
  {
    key: 'admin',
    label: '管理后台',
    icon: LayoutDashboard,
    group: '系统',
    hint: '服务、外观、远程访问、更新等设置',
    keepAlive: true,
  },
];

/** 导航分组顺序（只列出有视图的组） */
export const GROUP_ORDER: ViewGroup[] = ['运行', '演示', '系统'];

export function viewsByGroup(): { group: ViewGroup; items: ViewDef[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    items: VIEWS.filter((v) => v.group === group),
  })).filter((g) => g.items.length > 0);
}

export function findView(key: string): ViewDef | undefined {
  return VIEWS.find((v) => v.key === key);
}

export function isViewKey(key: string): key is ViewKey {
  return VIEWS.some((v) => v.key === key);
}
