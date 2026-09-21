/**
 * 右下角小组件 —— 常驻在控制台右下角的操作入口。
 *
 * 它是什么：屏幕右下角常驻一枚按钮，点开是一个浮层，里面是与**任务栏托盘菜单
 * 完全同构**的一组操作（启动/停止服务、打开/关闭工作台、远程地址、退出等）。
 *
 * 为什么要有它（而不是只用托盘）：
 *   1. 托盘菜单是原生菜单，React 无法控制；而托盘在「关闭时最小化到后台」开启后
 *      是唯一入口，菜单一旦改版，用户找不着功能。界内小组件给了一条可见的退路。
 *   2. 折叠态可以直接显示状态（服务在线/离线 + 端口），不点开也能一眼看到。
 *
 * 与托盘的一致性：
 *   操作项来自 actions.ts（与 main.js 的 buildTrayMenu 一一对应）。
 *   改动作语义时两边同步改 —— 见 actions.ts 顶部注释。
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, ExternalLink, Power } from 'lucide-react';
import type { DshState, RemoteInfo, UpdateState } from '@/types';
import { ACTIONS, type ActionContext } from './actions';

const UPDATE_TEXT: Record<UpdateState['status'], string> = {
  idle: '未检查',
  checking: '检查中…',
  available: '发现新版本，下载中…',
  downloading: '下载中…',
  downloaded: '已下载，重启生效',
  none: '已是最新',
  error: '检查失败',
  dev: '开发模式不检查',
};

export function ControlWidget({
  state,
  status,
  onChanged,
  onQuit,
}: {
  state: DshState | null;
  status: string;
  onChanged: () => void;
  /** 真退出（走主进程 app.quit，与托盘「退出」同一行为） */
  onQuit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const [copied, setCopied] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭，与设置面板行为一致
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.dshDesktop.remoteInfo().then(setRemote).catch(() => {});
    window.dshDesktop.updateState().then(setUpd).catch(() => {});
  }, [open]);

  const online = status === 'online';
  const ctx: ActionContext = { state, status, updateReady: upd?.status === 'downloaded' };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 1200);
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  };

  return (
    <div className="p-widget" ref={boxRef}>
      {open && (
        <div className="p-widget-panel" role="menu" aria-label="快捷控制">
          <div className="p-widget-head">
            <span className="p-widget-title">快捷控制</span>
            <span className={`p-badge ${status}`}>
              <span className="p-dot" /> {online ? '在线' : '离线'}
            </span>
          </div>

          {/* 状态区：折叠态看不到的信息放这里 */}
          <div className="p-widget-rows">
            <div className="p-widget-row-static">
              <span className="p-widget-key">服务地址</span>
              <span className="p-mono p-dim p-text-2xs truncate" title={state?.serverUrl ?? ''}>
                {state?.serverUrl ?? '—'}
              </span>
            </div>
            <div className="p-widget-row-static">
              <span className="p-widget-key">更新</span>
              <span className="p-mono p-dim p-text-2xs">{upd ? UPDATE_TEXT[upd.status] : '读取中…'}</span>
            </div>
          </div>

          {/* 动作区：与托盘菜单同源（actions.ts） */}
          <div className="p-widget-group">服务</div>
          <div className="p-widget-actions">
            {ACTIONS.filter((a) => ['startServer', 'stopServer', 'openWorkbench', 'closeWorkbench', 'retry'].includes(a.id)).map((a) => {
              const enabled = a.enabled(ctx);
              return (
                <button
                  key={a.id}
                  className={`p-btn ${a.tone === 'primary' ? 'p-btn-primary' : ''}`.trim()}
                  disabled={!enabled}
                  title={a.title}
                  onClick={async () => {
                    await a.run(ctx);
                    onChanged();
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>

          <div className="p-widget-group">远程</div>
          <div className="p-widget-rows">
            {remote?.fqdn ? (
              <>
                <div className="p-widget-row-static">
                  <span className="p-widget-key">完整 Web UI</span>
                  <div className="p-widget-inline">
                    <span className="p-mono p-dim p-text-2xs truncate" title={remote.httpsUri}>
                      {remote.httpsUri}
                    </span>
                    <button className="p-minibtn" title="复制地址" onClick={() => copy('ui', remote.httpsUri)}>
                      <Copy className="h-3 w-3" />
                    </button>
                    <button
                      className="p-minibtn"
                      title="在系统默认浏览器打开"
                      onClick={() => window.dshDesktop.openExternal(remote.httpsUri)}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="p-widget-row-static">
                  <span className="p-widget-key">手机连接（暴露面小）</span>
                  <div className="p-widget-inline">
                    <span className="p-mono p-dim p-text-2xs truncate">{`ws://${remote.fqdn}:3080/remote`}</span>
                    <button
                      className="p-minibtn"
                      title="复制地址"
                      onClick={() => copy('ws', `ws://${remote.fqdn}:3080/remote`)}
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="p-widget-row-static">
                <span className="p-widget-note">未检测到 Tailscale —— 装/连上后这里会出现手机地址。</span>
              </div>
            )}
            {copied && <div className="p-widget-note p-copied">已复制 {copied === 'ui' ? 'Web UI' : 'WS'} 地址 ✓</div>}
          </div>

          <div className="p-widget-group">维护</div>
          <div className="p-widget-actions">
            {ACTIONS.filter((a) => ['refresh', 'changeRoot', 'clearLogs', 'checkUpdate', 'installUpdate'].includes(a.id)).map((a) => (
              <button
                key={a.id}
                className={`p-btn ${a.tone === 'primary' ? 'p-btn-primary' : ''}`.trim()}
                disabled={!a.enabled(ctx)}
                title={a.title}
                onClick={async () => {
                  await a.run(ctx);
                  onChanged();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="p-widget-foot">
            <button
              className="p-btn p-widget-quit"
              title="退出 DSH Desktop（后台服务一并停止）"
              onClick={onQuit}
            >
              <Power className="h-3.5 w-3.5" /> 退出
            </button>
          </div>
        </div>
      )}

      {/* 折叠态：常驻按钮，直接显示在线状态 */}
      <button
        className="p-widget-toggle"
        aria-expanded={open}
        aria-label={open ? '收起快捷控制' : '展开快捷控制'}
        title={open ? '收起快捷控制' : '快捷控制（与任务栏托盘菜单同一组操作）'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`p-dot-remote ${status}`} aria-hidden="true" />
        <span className="p-widget-toggle-text">{open ? '收起' : '快捷控制'}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
