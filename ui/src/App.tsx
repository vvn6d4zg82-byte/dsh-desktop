import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <span className="text-sm font-semibold tracking-wide">DSH DESKTOP</span>
        <Badge variant={meta.variant}>{meta.text}</Badge>
        <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
          {state?.serverUrl ?? '…'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dshOpenResult && <span className="text-xs text-destructive">{dshOpenResult}</span>}
          {state?.workbenchOpen ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                window.dshDesktop.closeDsh();
                refresh();
              }}
            >
              关闭工作台
            </Button>
          ) : (
            <Button size="sm" onClick={openDsh}>
              打开 DSH 工作台
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 p-4">
        <Tabs defaultValue="console" className="flex h-full flex-col">
          <TabsList className="w-fit">
            <TabsTrigger value="console">服务终端</TabsTrigger>
            <TabsTrigger value="admin">管理后台</TabsTrigger>
          </TabsList>
          <TabsContent value="console" className="min-h-0 flex-1">
            <ServiceConsole status={status} state={state} onOpenDsh={openDsh} />
          </TabsContent>
          <TabsContent value="admin">
            <AdminPanel state={state} status={status} onChanged={refresh} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
