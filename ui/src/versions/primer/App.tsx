import { useCallback, useEffect, useState } from 'react';
import { installLogBridge } from '@/lib/logStore';
import { ControlWidget } from './ControlWidget';
import { ViewHost } from './ViewHost';
import { useWindowAnim } from './useWindowAnim';
import { VIEWS, findView, viewsByGroup, type ViewKey } from './registry/views';
import type { DshState } from '@/types';
import {
  Bell,
  GitBranch,
  Maximize2,
  Minus,
  Minimize2,
  Monitor,
  MonitorOff,
  Radio,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';

export const STATUS_META: Record<string, { text: string }> = {
  online: { text: '服务在线' },
  offline: { text: '服务离线' },
  starting: { text: '正在启动…' },
  waiting: { text: '等待服务…' },
  stalled: { text: '启动超时' },
  failed: { text: '启动失败' },
  opening: { text: '正在打开工作台…' },
};

// 正式版 · Primer (GitHub)：顶栏 + 左侧分组导航 + 内容区
//
// 重排要点（相对上一版）：
//   1. 视图不再写死。`` 的 VIEWS 是唯一来源，加演示界面不用改本文件。
//      见 registry/views.ts 的文档注释。
//   2. 视图挂载交给 ViewHost：终端/管理后台仍常驻保活，演示界面按需加载。
//      ⚠ 终端的保活契约见 registry/views.ts 里 keepAlive 的注释，别改成 false。
//   3. 冗余动作入口收敛：工具条只留最常用的，其余交给右下角小组件与设置面板；
//      三者与托盘菜单共用 actions.ts 的同一份定义。
export default function PrimerApp({ initialView }: { initialView: ViewKey }) {
  const [state, setState] = useState<DshState | null>(null);
  const [status, setStatus] = useState('offline');
  const [dshOpenResult, setDshOpenResult] = useState('');
  const [view, setView] = useState<ViewKey>(initialView);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [search, setSearch] = useState('');
  const animClass = useWindowAnim();

  const refresh = useCallback(() => window.dshDesktop.getState().then(setState), []);

  useEffect(() => {
    installLogBridge();
    refresh();
    window.dshDesktop.onServerStatus((s) => setStatus(s));
    const timer = setInterval(refresh, 4000);
    const syncFs = () => window.dshDesktop.winIsFullscreen().then(setIsFullscreen);
    syncFs();
    window.addEventListener('resize', syncFs);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', syncFs);
    };
  }, [refresh]);

  const openDsh = async () => {
    const ok = await window.dshDesktop.openDsh();
    setDshOpenResult(ok ? '' : 'DSH 服务未就绪，无法打开工作台');
    refresh();
  };

  const meta = STATUS_META[status] ?? STATUS_META.offline;
  const frameless = state?.settings.frameless ?? true;
  const groups = viewsByGroup();
  // 当前视图是否需要搜索框（只有终端用它过滤日志）
  const currentView = findView(view);

  return (
    <div className={`p-app ${animClass}`.trim()}>
      {/* GitHub 顶栏 */}
      <header className="p-topbar">
        <span className="p-brand">
          <span className="p-brand-mark">
            <Radio className="h-3 w-3" />
          </span>
          dsh-desktop
        </span>
        <span className="p-brand-path">/ {currentView ? currentView.key : 'control-panel'}</span>
        <span className="p-top-sep" />
        <span className="p-top-url">{state?.serverUrl ?? '…'}</span>

        <div className="p-top-actions">
          <span className={`p-badge ${status}`}>
            <span className="p-dot" /> {meta.text}
          </span>

          {/* 顶栏只留最常用的：打开/关闭工作台。其余动作统一收进右下角小组件，
              保证「同一动作只有一个入口」，不再出现工具条/设置里各写一套的情况 */}
          {state?.workbenchOpen ? (
            <button className="p-btn" title="关闭工作台" onClick={() => { window.dshDesktop.closeDsh(); refresh(); }}>
              <MonitorOff className="h-3.5 w-3.5" /> 关闭工作台
            </button>
          ) : (
            <button className="p-btn p-btn-primary" title="打开 DSH 工作台" onClick={openDsh}>
              <Monitor className="h-3.5 w-3.5" /> 打开工作台
            </button>
          )}

          {dshOpenResult && <span className="p-mono p-err p-text-xs">{dshOpenResult}</span>}

          {/* 设置入口已收敛：不再有「小齿轮」弹层。
              所有开关/启动命令/远程/更新都摊在「管理后台」页（内容区），
              符合 Primer 的「设置属于内容区」布局；顶栏只留窗口控制。 */}

          {frameless && (
            <div className="p-winctrl">
              <button
                className="p-winbtn"
                title="最小化到任务栏"
                aria-label="最小化"
                onClick={() => window.dshDesktop.winMinimize()}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                className="p-winbtn"
                title={isFullscreen ? '退出全屏' : '全屏'}
                aria-label={isFullscreen ? '退出全屏' : '全屏'}
                onClick={() => {
                  window.dshDesktop.winFullscreen();
                  setTimeout(() => window.dshDesktop.winIsFullscreen().then(setIsFullscreen), 120);
                }}
              >
                {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                className="p-winbtn p-winbtn-close"
                title={state?.settings.closeToTray ? '关闭（收进任务栏后台）' : '关闭'}
                aria-label="关闭"
                onClick={() => window.dshDesktop.winClose()}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="p-body">
        {/* 左侧导航：按 group 自动分组渲染（registry/views.ts 驱动） */}
        <nav className="p-side">
          {groups.map((g) => (
            <div key={g.group} className="p-side-group">
              <div className="p-side-label">{g.group}</div>
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <button
                    key={it.key}
                    className="p-side-item"
                    data-active={view === it.key}
                    title={it.hint}
                    aria-current={view === it.key ? 'page' : undefined}
                    onClick={() => setView(it.key)}
                  >
                    <Icon className="h-4 w-4" />
                    {it.label}
                    {/* 终端行显示在线状态点，与顶栏徽章同源 */}
                    {it.key === 'console' && (
                      <span className={`p-dot-remote ${status}`} aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* 搜索框只在终端视图有意义（过滤日志），其他视图隐藏以免误以为能搜 */}
          {view === 'console' && (
            <div className="p-side-search">
              <div className="p-side-search-box">
                <Search className="h-3.5 w-3.5 text-[var(--p-dim)]" />
                <input
                  className="p-side-search-input"
                  placeholder="过滤日志…"
                  aria-label="过滤终端日志"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="p-side-foot">
            <span className="p-mono p-text-2xs p-dim">{VIEWS.length} 个视图 · 可扩展</span>
          </div>
        </nav>

        {/* 内容区：终端/管理后台常驻挂载（CSS 显隐保活），演示界面按需加载。
            见 ViewHost.tsx 与 registry/views.ts 的 keepAlive 契约。 */}
        <main className="p-content">
          {VIEWS.map((v) => {
            const active = view === v.key;
            if (!v.keepAlive && !active) return null;
            return (
              <div key={v.key} hidden={!active} className="p-content-view">
                <ViewHost
                  view={v.key}
                  state={state}
                  status={status}
                  search={search}
                  onOpenDsh={openDsh}
                  onChanged={refresh}
                />
              </div>
            );
          })}
        </main>

        {/* 右下角小组件：与任务栏托盘菜单同一组操作（actions.ts 同源） */}
        <ControlWidget
          state={state}
          status={status}
          onChanged={refresh}
          onQuit={() => window.dshDesktop.winQuit()}
        />
      </div>

      {/* 底部状态条 */}
      <footer className="p-statusbar">
        <GitBranch className="h-3 w-3" />
        <span>main</span>
        <span className="sep" />
        <span>{meta.text}</span>
        <span className="sep" />
        <span>{state?.workbenchOpen ? '工作台: 已打开' : '工作台: 已关闭'}</span>
        <span className="sep" />
        <span className="truncate">{state?.launchDisplay ?? ''}</span>
        <span className="ml-auto flex items-center gap-1">
          <Bell className="h-3 w-3" /> 正式版 · Primer
        </span>
        <span className="p-avatar" title="DSH">D</span>
      </footer>
    </div>
  );
}
