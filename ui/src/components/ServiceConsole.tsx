import { useEffect, useRef, useState } from 'react';
import { STATUS_META } from '@/App';
import type { DshState, FsEntry } from '@/types';

const MAX_LINES = 2000;

type DirCache = Record<string, FsEntry[]>;
type Expanded = Record<string, boolean>;

function fmtSize(n: number): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function ServiceConsole({
  status,
  state,
  onOpenDsh,
}: {
  status: string;
  state: DshState | null;
  onOpenDsh: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 文件栏：根 + 按需加载的目录缓存 + 展开状态
  const [root, setRoot] = useState('');
  const [dirCache, setDirCache] = useState<DirCache>({});
  const [expanded, setExpanded] = useState<Expanded>({ '': true });
  const [fsError, setFsError] = useState('');
  const [width, setWidth] = useState(280);

  // ---- 终端日志 feed（不变）----
  useEffect(() => {
    window.dshDesktop.onServerLog((chunk) => {
      const incoming = String(chunk ?? '').split(/\r?\n/);
      setLines((prev) => prev.concat(incoming).slice(-MAX_LINES));
    });
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // ---- 文件树 ----
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
      setWidth(Math.min(520, Math.max(160, startW + (ev.clientX - startX))));
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
            <div className="wc-tree-row folder" onClick={() => toggleDir(childRel)}>
              <span className="marker">{isOpen ? '▾' : '▸'}</span>
              <span className="truncate">{e.name}</span>
            </div>
            {renderDir(childRel)}
          </div>
        );
      }
      return (
        <div key={childRel} className="wc-tree-row">
          <span className="marker" />
          <span className="truncate">{e.name}</span>
          {e.size > 0 && <span className="size">{fmtSize(e.size)}</span>}
        </div>
      );
    });
  };

  const meta = STATUS_META[status] ?? STATUS_META.offline;

  return (
    <div className="wc-panel">
      {/* 标题栏 */}
      <div className="wc-titlebar shrink-0">
        <span>DSH 服务终端</span>
        <span className="ml-auto flex items-center gap-1.5 font-normal normal-case tracking-normal">
          <span>{meta.text}</span>
          <span className="wc-blink">▌</span>
        </span>
      </div>

      {/* 双栏：左文件树 | 右终端 */}
      <div className="flex min-h-0 flex-1">
        <div className="wc-files" style={{ width }}>
          <div className="wc-files-head">
            <span className="wc-files-root" title={root}>
              {root || '(未选择目录)'}
            </span>
            <button className="wc-files-btn" title="刷新" onClick={refresh}>
              ↺
            </button>
            <button className="wc-files-btn" title="更换根目录" onClick={chooseRoot}>
              选根
            </button>
          </div>
          <div className="wc-tree">
            {fsError ? (
              <div className="wc-tree-empty">
                无法读取 {root || '根目录'}：{fsError}——点 [选根] 换个目录
              </div>
            ) : (
              renderDir('')
            )}
          </div>
        </div>
        <div className="wc-divider" onPointerDown={onDividerPointerDown} />

        <div className="min-w-0 flex-1 p-1.5">
          <div
            ref={scrollerRef}
            className="wc-term wc-crt h-full overflow-auto p-3 text-xs leading-relaxed"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {lines.length === 0 ? (
              <div className="flex h-full flex-col justify-center gap-1.5 text-[#00cc00]">
                <p className="text-[#00ff41]">DSH 服务终端</p>
                <p className="text-[#008800]">左侧浏览 DSH 环境目录（$DSH_HOME），右侧显示服务运行日志。</p>
                <p className="text-[#008800]">点下方「启动服务」，就绪后「打开工作台」进入 DSH 界面。</p>
              </div>
            ) : (
              lines.join('\n')
            )}
          </div>
        </div>
      </div>

      {/* 窗口级工具条 */}
      <div className="wc-toolbar shrink-0 gap-2 p-1.5">
        <button className="wc-btn px-3 py-1" onClick={() => window.dshDesktop.startServer()}>
          启动服务
        </button>
        <button className="wc-btn px-3 py-1" onClick={() => window.dshDesktop.stopServer()}>
          停止
        </button>
        {state?.workbenchOpen ? (
          <button className="wc-btn px-3 py-1" onClick={() => window.dshDesktop.closeDsh()}>
            关闭工作台
          </button>
        ) : (
          <button className="wc-btn px-3 py-1" onClick={onOpenDsh}>
            打开工作台
          </button>
        )}
        <span className="ml-auto truncate pl-2 font-mono text-[10px] text-[#404040]">
          {state?.serverUrl ?? ''}
        </span>
      </div>

      {/* 状态条 */}
      <div className="wc-statusbar shrink-0 px-2 py-0.5">
        <span>Document: Done</span>
        <span>服务: {meta.text}</span>
        <span className="truncate">{state?.launchDisplay ?? ''}</span>
      </div>
    </div>
  );
}