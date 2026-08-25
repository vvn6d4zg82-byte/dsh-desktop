import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { STATUS_META } from '@/App';
import type { DshState } from '@/types';

const MAX_LINES = 2000;

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
  const [cmd, setCmd] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);

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

  const meta = STATUS_META[status] ?? STATUS_META.offline;
  const empty = lines.length === 0 || (lines.length === 1 && lines[0] === '');

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant={meta.variant}>{meta.text}</Badge>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {state?.launchDisplay ?? ''}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          <Button size="sm" onClick={() => window.dshDesktop.startServer()}>
            启动服务
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.dshDesktop.stopServer()}>
            停止
          </Button>
          {state?.workbenchOpen ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.dshDesktop.closeDsh()}
            >
              关闭工作台
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onOpenDsh}>
              打开工作台
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto rounded-lg border bg-black/50 p-3 font-mono text-xs leading-relaxed text-sky-200 selection:bg-sky-500/30"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        {empty ? (
          <span className="text-muted-foreground">等待服务输出…（启动 dsh 后这里会显示完整终端日志）</span>
        ) : (
          lines.join('\n')
        )}
      </div>
      <div className="mt-2 flex shrink-0 items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">$</span>
        <input
          className="h-8 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && cmd.trim()) {
              window.dshDesktop.serverInput(cmd);
              setLines((prev) => prev.concat(['$ ' + cmd]).slice(-MAX_LINES));
              setCmd('');
            }
          }}
          placeholder={state?.serverOnline ? '向 dsh 进程发送命令（Enter）' : '服务未运行，命令不生效'}
          disabled={!state?.serverOnline}
        />
      </div>
    </div>
  );
}
