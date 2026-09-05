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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { STATUS_META } from '@/App';
import type { DshSettings, DshState, RemoteInfo } from '@/types';

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
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [exposeOn, setExposeOn] = useState(false);
  const [exposeBusy, setExposeBusy] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState('');

  useEffect(() => {
    if (s) setServerCommand(s.serverCommand);
    if (state) setServerUrl(state.serverUrl);
  }, [s?.serverCommand, state?.serverUrl]);

  useEffect(() => {
    window.dshDesktop.remoteInfo().then(setRemote);
  }, []);

  if (!s || !state) return null;

  const apply = (key: keyof DshSettings, value: unknown) => {
    window.dshDesktop.setSetting(key, value).then(onChanged);
  };

  const saveCommand = () => {
    apply('serverCommand', serverCommand.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const toggleExpose = async () => {
    const next = !exposeOn;
    setExposeBusy(true);
    setRemoteMsg('');
    const r = await window.dshDesktop.remoteExpose(next);
    if (r.ok) {
      setExposeOn(next);
      setRemoteMsg(next ? '已把 :3080 公开到 Tailscale（手机可用域名/ IP 访问）' : '已关闭对外公开');
    } else {
      setRemoteMsg(`失败：${r.error ?? 'tailscale 调用失败'}`);
    }
    setExposeBusy(false);
  };

  const meta = STATUS_META[status ?? 'offline'] ?? STATUS_META.offline;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="bevel-raise">
        <CardHeader>
          <CardTitle>服务管理</CardTitle>
          <CardDescription>DSH Web 服务的启停与自动拉起</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant={meta.variant}>{meta.text}</Badge>
            <span className="truncate font-mono text-xs text-muted-foreground">
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
            <RetroCheckbox checked={s.autoStartServer} onChange={(v) => apply('autoStartServer', v)} />
          </SettingRow>
        </CardContent>
      </Card>

      <Card className="bevel-raise">
        <CardHeader>
          <CardTitle>设置</CardTitle>
          <CardDescription>应用行为与 DSH 服务启动参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <SettingRow
            label="开机自动启动 DSH Desktop"
            description="写入 Windows 登录项"
          >
            <RetroCheckbox checked={s.openAtLogin} onChange={(v) => apply('openAtLogin', v)} />
          </SettingRow>
          <SettingRow
            label="隐藏 DSH 网页的终端界面"
            description="注入样式隐藏 [data-terminal]"
          >
            <RetroCheckbox checked={s.hideTerminal} onChange={(v) => apply('hideTerminal', v)} />
          </SettingRow>
          <SettingRow
            label="系统证书"
            description="给启动的服务注入 --use-system-ca"
          >
            <RetroCheckbox checked={s.systemCerts} onChange={(v) => apply('systemCerts', v)} />
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

      <Card className="bevel-raise lg:col-span-2">
        <CardHeader>
          <CardTitle className="font-mono">远程手机访问 · Tailscale</CardTitle>
          <CardDescription>
            把 DSH 的 3080 公开给手机，走 tailnet（Tailscale），KB 级文本流量
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {remote?.fqdn ? (
            <>
              <p className="break-all font-mono text-sm font-semibold text-foreground">
                HTTPS：{remote.httpsUri}（手机最佳）
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                HTTP（兜底）：{remote.httpUri} · 域名 {remote.fqdn} · IP {remote.ipv4}
              </p>
            </>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">
              （未检测到 Tailscale——本机装/连上 Tailscale 后会出现手机地址）
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant={exposeOn ? 'default' : 'outline'} onClick={toggleExpose} disabled={exposeBusy}>
              {exposeBusy ? '处理中…' : exposeOn ? '● 已公开 :3080' : '○ 未公开'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.dshDesktop.remoteInfo().then(setRemote)}>
              刷新地址
            </Button>
          </div>
          {remoteMsg && <p className="break-all font-mono text-xs text-amber-700">{remoteMsg}</p>}
          <p className="font-mono text-xs text-muted-foreground">
            手机：Tailscale 在线 → 打开上面的地址 → 粘 /sync token（首次运行时自动生成的那个）
          </p>
        </CardContent>
      </Card>

      <Card className="bevel-raise lg:col-span-2">
        <CardHeader>
          <CardTitle>版本 / 状态</CardTitle>
          <CardDescription>运行时与内置资源信息</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Info label="服务地址" value={state.serverUrl} />
          <Info label="Electron" value={state.versions.electron} />
          <Info label="Chromium" value={state.versions.chrome} />
          <Info label="Node" value={state.versions.node} />
          <Info label="模式" value={state.isPackaged ? '安装版' : '开发版'} />
          <div className="col-span-full">
            <Label className="mb-1 block">当前启动命令</Label>
            <div className="bevel-sink rounded bg-muted/60 p-2 font-mono text-xs text-foreground">
              {state.launchDisplay}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// 复古复选框：选框 ✓ + 「开/关」双态文本，一眼看清状态（替代难辨别的 Switch）
function RetroCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex h-6 min-w-[72px] cursor-pointer items-center gap-1.5 border border-[#0a0a0a] bg-[#e6e9ed] px-2 font-mono text-xs shadow-[inset_-1px_-1px_0_#0a0a0a,inset_1px_1px_0_#ffffff] active:shadow-[inset_1px_1px_0_#0a0a0a,inset_-1px_-1px_0_#ffffff]"
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-[#0a0a0a] bg-white text-[13px] font-bold leading-none text-black">
        {checked ? '✓' : ''}
      </span>
      <span className={checked ? 'text-[#1a1a1a]' : 'text-[#a0a0a0]'}>开</span>
      <span className={checked ? 'text-[#a0a0a0]' : 'text-[#1a1a1a]'}>关</span>
    </button>
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
