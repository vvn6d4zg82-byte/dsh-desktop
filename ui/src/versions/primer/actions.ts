/**
 * 统一动作层 —— 控制台里「对服务/工作台/窗口能做的事」的唯一词汇表。
 *
 * 为什么需要它：
 *   重排前同一个动作被实现了三遍（Toolbar 一套、SettingsMenu 一套、AdminPanel 一套），
 *   文案、可用条件、图标都不一样，改一处就漏两处。这里把每个动作收成一条声明，
 *   各处的界面（工具条 / 右下角小组件 / 设置面板 / 管理后台）都从这张表渲染，
 *   于是「有哪些动作、什么条件下可用、点了做什么」只有一处定义。
 *
 * 与主进程托盘菜单的关系：
 *   托盘菜单是原生菜单，由 main.js 的 buildTrayMenu() 构造，React 无法直接控制它。
 *   同一个动作在 main.js 里就是同名的一项（label 与 id 一一对应）。
 *   改动动作语义时，**两边必须同步改**：本文件 + main.js 的 buildTrayMenu()。
 */
import type { DshState } from '@/types';

export type ActionId =
  | 'openConsole'
  | 'openWorkbench'
  | 'closeWorkbench'
  | 'startServer'
  | 'stopServer'
  | 'retry'
  | 'refresh'
  | 'clearLogs'
  | 'changeRoot'
  | 'checkUpdate'
  | 'installUpdate';

export type ActionTone = 'default' | 'primary' | 'danger';

export interface ActionContext {
  state: DshState | null;
  status: string;
  /** 更新是否已下载完成（决定「立即重启更新」是否可用） */
  updateReady?: boolean;
}

export interface ActionDef {
  id: ActionId;
  /** 界面文案（托盘里的同名项也用它，两边保持一致） */
  label: string;
  /** 悬停提示：说明动作的影响面，别只说「点击执行」 */
  title: string;
  tone: ActionTone;
  /** 可用条件：集中在这里，避免各处各写一套 disabled 逻辑 */
  enabled: (ctx: ActionContext) => boolean;
  /** 真正执行；返回 Promise 的动作在按钮上会走 busy 态 */
  run: (ctx: ActionContext) => void | Promise<void>;
}

const isOnline = (ctx: ActionContext) => ctx.status === 'online';

/**
 * 顺序即「常用度」：越靠前越常按。工具条只取前若干个，小组件全量展示。
 */
export const ACTIONS: ActionDef[] = [
  {
    id: 'startServer',
    label: '启动服务',
    title: '启动 DSH 服务（已在运行时不重复启动）',
    tone: 'primary',
    enabled: (ctx) => !isOnline(ctx) && ctx.status !== 'starting' && ctx.status !== 'waiting',
    run: () => window.dshDesktop.startServer(),
  },
  {
    id: 'stopServer',
    label: '停止服务',
    title: '停止 DSH 服务；服务未运行时此处不可用',
    tone: 'danger',
    enabled: isOnline,
    run: () => window.dshDesktop.stopServer(),
  },
  {
    id: 'openWorkbench',
    label: '打开工作台',
    title: '在独立窗口打开 DSH 网页界面',
    tone: 'primary',
    enabled: (ctx) => !ctx.state?.workbenchOpen && isOnline(ctx),
    run: (ctx) => { void ctx; window.dshDesktop.openDsh(); },
  },
  {
    id: 'closeWorkbench',
    label: '关闭工作台',
    title: '关闭 DSH 工作台窗口（不影响后台服务）',
    tone: 'default',
    enabled: (ctx) => Boolean(ctx.state?.workbenchOpen),
    run: () => window.dshDesktop.closeDsh(),
  },
  {
    id: 'retry',
    label: '重试连接',
    title: '重新探测服务端口与 token（服务在跑但界面显示离线时用）',
    tone: 'default',
    enabled: () => true,
    run: () => window.dshDesktop.retry(),
  },
  {
    id: 'refresh',
    label: '刷新状态',
    title: '立即重新读取一次运行状态（平时每 4 秒自动刷新）',
    tone: 'default',
    enabled: () => true,
    run: (ctx) => { void ctx; },
  },
  {
    id: 'changeRoot',
    label: '更换根目录',
    title: '更换左侧文件浏览的根目录（只影响浏览，不影响 DSH 数据）',
    tone: 'default',
    enabled: () => true,
    run: () => { void window.dshDesktop.fsSetRoot(); },
  },
  {
    id: 'clearLogs',
    label: '清空日志',
    title: '清空服务终端里的日志显示（不删磁盘上的日志文件）',
    tone: 'default',
    enabled: () => true,
    run: () => { window.dispatchEvent(new CustomEvent('dsh-clear-logs')); },
  },
  {
    id: 'checkUpdate',
    label: '检查更新',
    title: '立即检查是否有新版本；发现后会在后台静默下载',
    tone: 'default',
    enabled: (ctx) => !ctx.updateReady,
    run: () => { void window.dshDesktop.updateCheck(); },
  },  {
    id: 'installUpdate',
    label: '立即重启更新',
    title: '重启并安装已下载的新版本（未下载完成时不可用）',
    tone: 'primary',
    enabled: (ctx) => Boolean(ctx.updateReady),
    run: () => { void window.dshDesktop.updateInstallNow(); },
  },
  {
    id: 'openConsole',
    label: '进入控制台',
    title: '把控制台窗口叫回前台（从托盘/后台回来时的入口）',
    tone: 'default',
    enabled: () => true,
    // 该动作由主进程托盘菜单执行（渲染进程无对应 IPC），这里只保留定义以便文案统一
    run: () => {},
  },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function getAction(id: ActionId): ActionDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`未定义的动作：${id}`);
  return def;
}

/** 取一组动作，按 ACTIONS 的声明顺序返回，保证各处顺序一致 */
export function pickActions(ids: ActionId[]): ActionDef[] {
  return ACTIONS.filter((a) => ids.includes(a.id));
}
