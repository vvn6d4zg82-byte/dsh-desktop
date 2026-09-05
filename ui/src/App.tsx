import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ServiceConsole } from '@/components/ServiceConsole';
import { AdminPanel } from '@/components/AdminPanel';
import type { DshState } from '@/types';

export const STATUS_META: Record<string, { text: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'default' }> = {
  online: { text: '服务在线', variant: 'success' },
  offline: { text: '服务离线', variant: 'secondary' },
  starting: { text: '正在启动…', variant: 'warning' },
  waiting: { text: '等待服务…', variant: 'secondary' },
  stalled: { text: '启动超时', variant: 'destructive' },
  failed: { text: '启动失败', variant: 'destructive' },
};

export default function App() {
  const [state, setState] = useState<DshState | null>(null);
  const [status, setStatus] = useState<string>('offline');
  const [dshOpenResult, setDshOpenResult] = useState<string>('');

  const refresh = () => window.dshDesktop.getState().then(setState);

  useEffect(() => {
    refresh();
    window.dshDesktop.onServerStatus((s) => setStatus(s));
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  const openDsh = async () => {
    const ok = await window.dshDesktop.openDsh();
    setDshOpenResult(ok ? '' : 'DSH 服务未就绪，无法打开工作台');
    refresh();
  };

  const meta = STATUS_META[status] ?? STATUS_META.offline;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="retro-titlebar flex h-11 shrink-0 items-center gap-3 px-4">
        <span className="font-mono text-sm font-bold tracking-[0.25em]">DSH DESKTOP</span>
        <Badge variant={meta.variant}>{meta.text}</Badge>
        <span className="hidden truncate font-mono text-xs text-white/70 sm:inline">
          {state?.serverUrl ?? '…'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dshOpenResult && <span className="text-xs text-[#ffc9c9]">{dshOpenResult}</span>}
          {state?.workbenchOpen ? (
            <button
              className="titlebar-btn rounded px-3 py-1.5 text-xs font-medium"
              onClick={() => {
                window.dshDesktop.closeDsh();
                refresh();
              }}
            >
              关闭工作台
            </button>
          ) : (
            <button
              className="titlebar-btn rounded px-3 py-1.5 text-xs font-semibold"
              onClick={openDsh}
            >
              打开 DSH 工作台
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 p-3">
        <Tabs defaultValue="console" className="flex h-full flex-col">
          <TabsList className="bevel-sink w-fit gap-0.5 border border-[#0a0f14] bg-[#d7dbe0] p-1">
            <TabsTrigger value="console" className="bevel-raise">
              服务终端
            </TabsTrigger>
            <TabsTrigger value="admin" className="bevel-raise">
              管理后台
            </TabsTrigger>
          </TabsList>
          <TabsContent value="console" className="min-h-0 flex-1">
            <ServiceConsole status={status} state={state} onOpenDsh={openDsh} />
          </TabsContent>
          <TabsContent value="admin" className="min-h-0 flex-1 overflow-auto">
            <AdminPanel state={state} status={status} onChanged={refresh} />
          </TabsContent>
        </Tabs>
      </div>

      <footer className="retro-statusbar shrink-0">
        <span>Document: Done</span>
        <span>服务: {meta.text}</span>
        {state?.workbenchOpen ? <span>工作台: 已打开</span> : <span>工作台: 已关闭</span>}
        <span className="ml-auto truncate">{state?.serverUrl ?? '…'}</span>
      </footer>
    </div>
  );
}