import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { STATUS_META } from '@/App';
import type { DshSettings, DshState } from '@/types';

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <Label>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function AdminPanel({
  state,
  status,
  onChanged,
}: {
  state: DshState | null;
  status?: string;
  onChanged: () => void;
}) {
  const s = state?.settings;
  const [serverCommand, setServerCommand] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (s) setServerCommand(s.serverCommand);
    if (state) setServerUrl(state.serverUrl);
  }, [s?.serverCommand, state?.serverUrl]);

  if (!s || !state) return null;

  const apply = (key: keyof DshSettings, value: unknown) => {
    window.dshDesktop.setSetting(key, value).then(onChanged);
  };

  const saveCommand = () => {
    apply('serverCommand', serverCommand.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const meta = STATUS_META[status ?? 'offline'] ?? STATUS_META.offline;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>服务管理</CardTitle>
          <CardDescription>DSH Web 服务的启停与自动拉起</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant={meta.variant}>{meta.text}</Badge>
            <span className="font-mono text-xs text-muted-foreground">
              地址：{state.serverUrl}
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => window.dshDesktop.startServer()}>
              启动服务
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.dshDesktop.stopServer()}
            >
              停止服务
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.dshDesktop.retry()}>
              重试连接
            </Button>
          </div>
          <Separator />
          <SettingRow
            label="服务未运行时自动启动"
            description="检测到离线时自动拉起 dsh（凶手可能就在这：关掉就不会自动启动）"
          >
            <Switch
              checked={s.autoStartServer}
              onCheckedChange={(v) => apply('autoStartServer', v)}
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>设置</CardTitle>
          <CardDescription>应用行为与 DSH 服务启动参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <SettingRow
            label="开机自动启动 DSH Desktop"
            description="写入 Windows 登录项"
          >
            <Switch
              checked={s.openAtLogin}
              onCheckedChange={(v) => apply('openAtLogin', v)}
            />
          </SettingRow>
          <SettingRow
            label="隐藏 DSH 网页的终端界面"
            description="注入样式隐藏 [data-terminal]"
          >
            <Switch
              checked={s.hideTerminal}
              onCheckedChange={(v) => apply('hideTerminal', v)}
            />
          </SettingRow>
          <SettingRow
            label="系统证书"
            description="给启动的服务注入 --use-system-ca"
          >
            <Switch
              checked={s.systemCerts}
              onCheckedChange={(v) => apply('systemCerts', v)}
            />
          </SettingRow>
          <Separator className="my-2" />
          <div className="space-y-1.5 py-2">
            <Label>自定义启动命令</Label>
            <p className="text-xs text-muted-foreground">
              留空/恢复默认 `npx --yes @deepseek-ai/dsh web` 才会走内置 dsh；改成别的就绕开了。
            </p>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                value={serverCommand}
                onChange={(e) => setServerCommand(e.target.value)}
                placeholder="npx --yes @deepseek-ai/dsh web"
              />
              <Button size="sm" variant="secondary" onClick={saveCommand}>
                {saved ? '已保存' : '保存'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setServerCommand('npx --yes @deepseek-ai/dsh web');
                  apply('serverCommand', 'npx --yes @deepseek-ai/dsh web');
                }}
              >
                恢复默认
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>版本 / 状态</CardTitle>
          <CardDescription>运行时与内置资源信息</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Info label="内置 dsh" value={state.bundledVersions?.dshVersion ?? '—'} />
          <Info label="服务地址" value={state.serverUrl} />
          <Info label="Electron" value={state.versions.electron} />
          <Info label="Chromium" value={state.versions.chrome} />
          <Info label="Node" value={state.versions.node} />
          <Info label="模式" value={state.isPackaged ? '安装版' : '开发版'} />
          <div className="col-span-full">
            <Label className="mb-1 block">当前启动命令</Label>
            <div className="rounded border bg-black/40 p-2 font-mono text-xs text-sky-200">
              {state.launchDisplay}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label className="mb-0.5 block text-xs text-muted-foreground">{label}</Label>
      <div className="font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}
