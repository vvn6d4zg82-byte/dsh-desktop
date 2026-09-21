import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_META } from './App';
import { clearLogs, useServerLogs } from '@/lib/logStore';
import type { DshState, FsEntry, ServerTokenInfo } from '@/types';
import {
  Eraser,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderInput,
  Loader2,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
} from 'lucide-react';

type DirCache = Record<string, FsEntry[]>;
type Expanded = Record<string, boolean>;

function fmtSize(n: number): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function lineClass(raw: string): string {
  const s = raw.toLowerCase();
  // 启动里程碑（主进程用 `▶` 前缀播报）：单独着色，便于一眼看出进度
  if (raw.includes('▶')) return 'term-line-milestone';
  if (/(error|fatal|exception|failed:)/.test(s)) return 'term-line-error';
  if (/(warn|timeout|stall)/.test(s)) return 'term-line-warn';
  return '';
}

export function ServiceConsole({
  status,
  state,
  onOpenDsh,
  search,
}: {
  status: string;
  state: DshState | null;
  onOpenDsh: () => void;
  search?: string;
}) {
  const allLines = useServerLogs();
  const scrollerRef = useRef<HTMLDivElement>(null);

  const [root, setRoot] = useState('');
  const [dirCache, setDirCache] = useState<DirCache>({});
  const [expanded, setExpanded] = useState<Expanded>({ '': true });
  const [fsError, setFsError] = useState('');
  const [width, setWidth] = useState(260);

  // 全局搜索过滤（方案B特色：侧栏搜索框实时过滤终端日志）
  const lines = useMemo(() => {
    const q = (search ?? '').trim().toLowerCase();
    if (!q) return allLines;
    const idx = allLines.map((l, i) => ({ l, i })).filter((x) => x.l.toLowerCase().includes(q));
    return idx.map((x) => allLines[x.i]);
  }, [allLines, search]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // 齿轮面板里的「清空日志」通过事件驱动，避免把 clearLogs 再往上提一层
  useEffect(() => {
    const onClear = () => clearLogs();
    window.addEventListener('dsh-clear-logs', onClear);
    return () => window.removeEventListener('dsh-clear-logs', onClear);
  }, []);

  const loadDir = async (rel: string) => {
    const res = await window.dshDesktop.fsList(rel);
    if (res.ok) {
      setDirCache((prev) => ({ ...prev, [rel]: res.entries ?? [] }));
      setFsError('');
    } else {
      setFsError(res.error ?? '加载失败');
    }
  };

  useEffect(() => {
    window.dshDesktop.fsRoot().then((r) => {
      setRoot(r);
      loadDir('');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 远程访问地址：实时跟随 token（服务每天重启换 token，这里始终显示「当前有效」地址）
  const [tokenInfo, setTokenInfo] = useState<ServerTokenInfo | null>(() =>
    state && typeof state.workbenchUrl === 'string' && state.workbenchUrl.includes('token=')
      ? { tokenUrl: state.workbenchUrl, workbenchUrl: state.workbenchUrl, hasToken: true }
      : null
  );
  const [fqdn, setFqdn] = useState('');
  useEffect(() => {
    // 主进程推送 token 变化（启动时、每天重启后、每 3 秒在线轮询）→ 地址条实时刷新
    window.dshDesktop.onServerToken((info) => setTokenInfo(info));
    // tailnet 域名（手机免 key 地址的宿主）；未装/未连 Tailscale 时为空
    window.dshDesktop
      .remoteInfo()
      .then((r) => {
        if (r && r.fqdn) setFqdn(r.fqdn);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDir = (rel: string) => {
    const next = !expanded[rel];
    setExpanded((prev) => ({ ...prev, [rel]: next }));
    if (next && !dirCache[rel]) loadDir(rel);
  };

  const refresh = () => {
    setDirCache({});
    loadDir('');
  };

  const chooseRoot = async () => {
    const r = await window.dshDesktop.fsSetRoot();
    setRoot(r);
    setDirCache({});
    setExpanded({ '': true });
    loadDir('');
  };

  const onDividerPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      setWidth(Math.min(480, Math.max(160, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const renderDir = (rel: string) => {
    const entries = dirCache[rel];
    if (!entries || !expanded[rel]) return null;
    return entries.map((e) => {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === 'dir') {
        const isOpen = !!expanded[childRel];
        return (
          <div key={childRel}>
            <div className="p-tree-row folder" onClick={() => toggleDir(childRel)}>
              <span className="p-tree-icon">
                {isOpen ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
              </span>
              <span className="truncate">{e.name}</span>
            </div>
            {renderDir(childRel)}
          </div>
        );
      }
      return (
        <div key={childRel} className="p-tree-row">
          <span className="p-tree-icon">
            {/\.(json|yaml|yml|toml|txt|md|log|js|ts|mjs)$/i.test(e.name) ? (
              <FileText className="h-3.5 w-3.5" />
            ) : (
              <File className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="truncate">{e.name}</span>
          {e.size > 0 && <span className="size">{fmtSize(e.size)}</span>}
        </div>
      );
    });
  };

  const meta = STATUS_META[status] ?? STATUS_META.offline;
  // 启动 / 等待 / 正在打开工作台：都算「加载中」，进度条与启动动画持续到工作台打开
  const booting = status === 'starting' || status === 'waiting' || status === 'opening';

  // —— 地址条派生值：免 key 地址（换过一次 cookie 后直接开）与带 token 地址（仅换 cookie 用）
  const hasToken = Boolean(tokenInfo && tokenInfo.hasToken);
  const baseUrl = fqdn ? `https://${fqdn}/` : '';
  const tokenParam = tokenInfo && tokenInfo.tokenUrl ? (tokenInfo.tokenUrl.match(/[?&]token=([^\s&]+)/) || [])[1] || '' : '';
  const copyTokenUrl = async () => {
    const u = tokenParam && baseUrl ? `${baseUrl}?token=${tokenParam}` : tokenInfo ? tokenInfo.tokenUrl : '';
    if (!u) return;
    try {
      await navigator.clipboard.writeText(u);
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  };

  return (
    <div className="p-console">
      <div className="p-console-bar shrink-0">
        <span className="p-console-title">
          <TerminalSquare className="h-3.5 w-3.5" />
          DSH 服务终端
        </span>
        <span className={`p-badge ${status}`}>
          <span className="p-dot" /> {meta.text}
        </span>
        <span className="p-mono p-dim ml-auto truncate p-text-2xs">
          {search ? `过滤: "${search}" (${lines.length}/${allLines.length})` : `${allLines.length} 行`}
        </span>
      </div>

      {/* 启动中：不确定进度条（服务就绪后自动消失） */}
      {booting && <div className="p-progress" role="progressbar" aria-label="DSH 服务启动中" />}

      {/* 远程访问地址条：随时可见；token 变了自动刷（服务每天重启也不怕） */}
      {(fqdn || hasToken) && (
        <div className="p-remote-strip" role="status" aria-live="polite">
          <span className="p-remote-item" title="网关状态">
            <span className={`p-dot-remote ${status}`} aria-hidden="true" />
            {meta.text}
          </span>
          <span className="p-remote-sep" aria-hidden="true" />
          <span
            className="p-remote-item"
            title="手机免 key 地址：换过一次 cookie 后直接打开，地址栏无 token"
          >
            免 key（手机）
            {baseUrl ? (
              <button
                className="p-mono p-linkless"
                title={`${baseUrl} —— 点开即复制`}
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(baseUrl);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {baseUrl}
              </button>
            ) : (
              <span className="p-dim">未检测到 Tailscale</span>
            )}
          </span>
          <span className="p-remote-sep" aria-hidden="true" />
          <span className="p-remote-item" title="带 token 地址：仅用于换 cookie 的一次性访问">
            换 cookie
            {hasToken ? (
              <button className="p-minibtn" onClick={copyTokenUrl}>
                复制带 token 地址
              </button>
            ) : (
              <span className="p-dim">启动后出现</span>
            )}
          </span>
        </div>
      )}

      <div className="p-console-body">
        <div className="p-files" style={{ width }}>
          <div className="p-files-head">
            <span className="p-files-root" title={root}>
              {root || '(未选择目录)'}
            </span>
            <button className="p-minibtn" title="刷新目录" onClick={refresh}>
              <RefreshCw className="h-3 w-3" />
            </button>
            <button className="p-minibtn" title="更换根目录" onClick={chooseRoot}>
              <FolderInput className="h-3 w-3" />
            </button>
          </div>
          <div className="p-tree">
            {fsError ? (
              <div className="p-tree-empty">
                无法读取 {root || '根目录'}：{fsError}——点 [选根] 换个目录
              </div>
            ) : (
              renderDir('')
            )}
          </div>
        </div>
        <div className="p-divider" onPointerDown={onDividerPointerDown} />

        <div className="min-w-0 flex-1 p-1.5">
          <div
            ref={scrollerRef}
            className="p-term h-full overflow-auto rounded p-3"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {lines.length === 0 ? (
              <div className="p-term-empty flex h-full flex-col justify-center gap-1.5">
                {booting ? (
                  <>
                    <p className="p-text-xl font-semibold flex items-center gap-2">
                      <Loader2 className="p-boot-icon h-4 w-4" />
                      {status === 'opening'
                        ? '正在打开工作台…'
                        : status === 'starting'
                          ? '正在启动 DSH 服务…'
                          : '等待 DSH 服务就绪…'}
                    </p>
                    <p className="p-boot-step">
                      {status === 'opening'
                        ? '工作台窗口已创建，正在加载 DSH 网页界面…'
                        : '首次运行需联网 npx 安装，可能较慢，下方会实时显示进度。'}
                    </p>
                    <p className="p-boot-step">服务就绪后「打开工作台」会自动可用。</p>
                    <p className="p-boot-step opacity-60">加载动画会一直持续到工作台打开。</p>
                  </>
                ) : (
                  <>
                    <p className="p-text-xl font-semibold">DSH 服务终端</p>
                    <p>左侧浏览 DSH 环境目录（$DSH_HOME），右侧显示服务运行日志。</p>
                    <p>点下方「启动服务」，就绪后「打开工作台」进入 DSH 界面。</p>
                    <p className="opacity-60">切换「管理后台」再回来，日志依然保留。</p>
                  </>
                )}
              </div>
            ) : (
              lines.map((line, i) => (
                <span key={i} className={lineClass(line)}>
                  {line}
                  {'\n'}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="p-toolbar shrink-0">
        <button className="p-btn" title="启动服务" onClick={() => window.dshDesktop.startServer()}>
          <Play className="h-3.5 w-3.5" /> 启动
        </button>
        <button className="p-btn" title="停止服务" onClick={() => window.dshDesktop.stopServer()}>
          <Square className="h-3.5 w-3.5" /> 停止
        </button>
        {state?.workbenchOpen ? (
          <button className="p-btn" title="关闭工作台" onClick={() => window.dshDesktop.closeDsh()}>
            <ExternalLink className="h-3.5 w-3.5" /> 关闭工作台
          </button>
        ) : (
          <button className="p-btn p-btn-primary" onClick={onOpenDsh}>
            <ExternalLink className="h-3.5 w-3.5" /> 打开工作台
          </button>
        )}
        <button className="p-btn ml-auto" title="清空日志" onClick={clearLogs}>
          <Eraser className="h-3.5 w-3.5" /> 清空
        </button>
      </div>
    </div>
  );
}