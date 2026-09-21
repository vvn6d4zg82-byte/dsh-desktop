/**
 * 管理后台 —— **所有设置的唯一归属地**。
 *
 * 重构背景（用户指出「小齿轮里的功能为何不摊开，违反设计语言」）：
 *   重排前存在两个设置入口：
 *     · 顶栏「小齿轮」→ 320px 浮动弹层（438 行，7 个开关 + 6 个动作）
 *     · 「管理后台」页 → 卡片布局（326 行，同样的 5 个开关 + 4 个动作）
 *   两者有 5 个设置项与 4 个动作完全重叠，用户同屏能看到同一开关出现两次。
 *   更关键的是：Primer 的布局是「顶栏 + 左侧导航 + 内容区」，设置属于**内容区**，
 *   再用一个浮动弹层重复一遍内容区的功能，不是 Primer 的组件语言
 *   （GitHub 的 Settings 就是一个独立页面，不是一个齿轮弹层）。
 *
 * 重构后：
 *   · 小齿轮弹层**已删除**（SettingsMenu.tsx）。
 *   · 所有开关、启动命令、远程访问、更新、只读信息都摊开在本页，按分区排列。
 *   · 顶栏只保留「打开/关闭工作台」与窗口控制按钮。
 *   · 动作按钮统一走 actions.ts，不再各自写一套。
 *
 * 分区顺序按「用户找东西的直觉」排：
 *   服务与运行 → 工作台 → 外观与窗口 → 启动与后台 → 远程访问 → 更新 → 关于
 */
import { useEffect, useState } from 'react';
import type { DshSettings, DshState, RemoteInfo, UpdateState } from '@/types';
import { Card, SectionLabel, SettingRow, Switch } from './ui/primitives';
import { getAction, type ActionContext } from './actions';
import {
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  Globe,
  Info,
  Link2,
  Monitor,
  Power,
  RefreshCw,
  Rocket,
  Server,
  Settings,
  Shield,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

const UPDATE_TEXT: Record<UpdateState['status'], string> = {
  idle: '未检查',
  checking: '正在检查…',
  available: '发现新版本，正在下载…',
  downloading: '正在后台下载…',
  downloaded: '已下载，重启后生效',
  none: '已是最新版本',
  error: '检查失败（不影响使用）',
  dev: '开发模式不检查更新',
};

const UPDATE_TONE: Record<UpdateState['status'], string> = {
  idle: '',
  checking: 'starting',
  available: 'starting',
  downloading: 'starting',
  downloaded: 'online',
  none: 'online',
  error: 'failed',
  dev: '',
};

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="p-btn"
      title={label ? `复制${label}` : '复制'}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {copied ? <span className="p-mono">已复制 ✓</span> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** 动作按钮：从 actions.ts 取定义，保证与托盘的文案/可用条件一致 */
function ActionButton({
  id,
  ctx,
  onDone,
}: {
  id: Parameters<typeof getAction>[0];
  ctx: ActionContext;
  onDone: () => void;
}) {
  const a = getAction(id);
  const enabled = a.enabled(ctx);
  return (
    <button
      className={`p-btn ${a.tone === 'primary' ? 'p-btn-primary' : ''}`.trim()}
      disabled={!enabled}
      title={a.title}
      onClick={async () => {
        await a.run(ctx);
        onDone();
      }}
    >
      {a.label}
    </button>
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
  const [saved, setSaved] = useState(false);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [exposeBusy, setExposeBusy] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState('');
  const [upd, setUpd] = useState<UpdateState | null>(null);

  useEffect(() => {
    if (s) setServerCommand(s.serverCommand);
  }, [s?.serverCommand]);

  useEffect(() => {
    window.dshDesktop.remoteInfo().then(setRemote).catch(() => {});
    window.dshDesktop.updateState().then(setUpd).catch(() => {});
    window.dshDesktop.onUpdateState(setUpd);
  }, []);

  if (!s || !state) {
    return <div className="p-view-loading">正在读取设置…</div>;
  }

  const apply = (key: keyof DshSettings, value: unknown) => {
    window.dshDesktop.setSetting(key, value).then(onChanged);
  };

  const saveCommand = () => {
    apply('serverCommand', serverCommand.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const toggleExpose = async () => {
    setExposeBusy(true);
    setRemoteMsg('');
    const r = await window.dshDesktop.remoteExpose(!isExposed);
    setRemoteMsg(r.ok ? (isExposed ? '已关闭对外公开' : '已把服务公开到 Tailnet') : `失败：${r.error ?? 'tailscale 调用失败'}`);
    setExposeBusy(false);
    window.dshDesktop.remoteInfo().then(setRemote).catch(() => {});
  };

  // 暴露状态无法直接查询，用 httpsUri 是否带端口判断当前是否已 serve
  // （开启后主进程会把 httpsUri 写成带 :8443 的地址）
  const isExposed = Boolean(remote?.httpsUri && remote.httpsUri.includes(':8443'));
  const ctx: ActionContext = { state, status: status ?? 'offline', updateReady: upd?.status === 'downloaded' };

  return (
    <div className="p-admin">
      {/* ---------- 状态条 ---------- */}
      <div className="p-admin-status">
        <span className={`p-badge ${status ?? 'offline'}`}>
          <span className="p-dot" /> {status === 'online' ? '服务在线' : '服务离线'}
        </span>
        <span className="p-value truncate p-text-sm">{state.serverUrl}</span>
        <span className="p-mono p-dim ml-auto p-text-xs">
          Electron {state.versions.electron} · Chromium {state.versions.chrome} · Node {state.versions.node}
        </span>
      </div>

      <div className="p-grid">
        {/* ---------- 1. 服务与运行 ---------- */}
        <Card title="服务与运行" desc="启停 DSH 服务、重试连接" icon={<Server className="h-4 w-4" />}>
          <div className="p-btn-row">
            <ActionButton id="startServer" ctx={ctx} onDone={onChanged} />
            <ActionButton id="stopServer" ctx={ctx} onDone={onChanged} />
            <ActionButton id="retry" ctx={ctx} onDone={onChanged} />
            <ActionButton id="refresh" ctx={ctx} onDone={onChanged} />
          </div>
          <SectionLabel>启动参数</SectionLabel>
          <SettingRow
            icon={<Rocket className="h-3.5 w-3.5" />}
            label="服务未运行时自动拉起"
            description="检测到离线时自动启动 dsh"
          >
            <Switch
              checked={s.autoStartServer}
              onChange={(v) => apply('autoStartServer', v)}
              label="服务未运行时自动拉起"
            />
          </SettingRow>
          <SettingRow
            icon={<Shield className="h-3.5 w-3.5" />}
            label="使用系统证书"
            description="给启动的服务注入 --use-system-ca（内网/代理证书环境需要）"
          >
            <Switch checked={s.systemCerts} onChange={(v) => apply('systemCerts', v)} label="使用系统证书" />
          </SettingRow>
          <SettingRow
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            label="自定义启动命令"
            description="留空/恢复默认 npx --yes @deepseek-ai/dsh web 才会走内置 dsh"
            layout="stacked"
          >
            <div className="p-input-row">
              <input
                className="p-input p-mono"
                value={serverCommand}
                aria-label="自定义启动命令"
                onChange={(e) => setServerCommand(e.target.value)}
                placeholder="npx --yes @deepseek-ai/dsh web"
              />
              <button className="p-btn p-btn-primary" title="保存启动命令" onClick={saveCommand}>
                {saved ? '已保存' : '保存'}
              </button>
              <button
                className="p-btn"
                title="恢复为内置默认命令"
                onClick={() => {
                  const def = 'npx --yes @deepseek-ai/dsh web';
                  setServerCommand(def);
                  apply('serverCommand', def);
                }}
              >
                恢复默认
              </button>
            </div>
          </SettingRow>
        </Card>

        {/* ---------- 2. 工作台 ---------- */}
        <Card title="DSH 工作台" desc="独立窗口加载 DSH 网页界面" icon={<Monitor className="h-4 w-4" />}>
          <div className="p-btn-row">
            <ActionButton id="openWorkbench" ctx={ctx} onDone={onChanged} />
            <ActionButton id="closeWorkbench" ctx={ctx} onDone={onChanged} />
          </div>
          {state.workbenchUrl && (
            <>
              <SectionLabel>当前地址</SectionLabel>
              <div className="p-input-row">
                <span className="p-value truncate p-text-xs">{state.workbenchUrl}</span>
                <CopyButton text={state.workbenchUrl} label="工作台地址" />
              </div>
            </>
          )}
          <SectionLabel>相关设置</SectionLabel>
          <SettingRow
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            label="隐藏网页里的终端区块"
            description="注入样式隐藏 [data-terminal]"
          >
            <Switch checked={s.hideTerminal} onChange={(v) => apply('hideTerminal', v)} label="隐藏网页终端" />
          </SettingRow>
        </Card>

        {/* ---------- 3. 外观与窗口 ---------- */}
        <Card title="外观与窗口" desc="窗口外框与视觉行为" icon={<Settings className="h-4 w-4" />}>
          <SettingRow
            label="无边框窗口"
            description={s.frameless ? '当前：无边框（自绘标题栏），重启后彻底生效' : '当前：系统边框 + 菜单栏'}
          >
            <Switch
              checked={s.frameless}
              label="无边框窗口"
              onChange={(v) => {
                window.dshDesktop.setFrameless(v);
                onChanged();
              }}
            />
          </SettingRow>
        </Card>

        {/* ---------- 4. 启动与后台 ---------- */}
        <Card title="启动与后台" desc="登录项、托盘与关闭行为" icon={<Power className="h-4 w-4" />}>
          <SettingRow label="开机自动启动" description="写入 Windows 登录项">
            <Switch checked={s.openAtLogin} onChange={(v) => apply('openAtLogin', v)} label="开机自动启动" />
          </SettingRow>
          <SettingRow
            label="关闭时最小化到后台"
            description="点关闭不退出，收进任务栏小组件；服务继续运行"
          >
            <Switch checked={s.closeToTray} onChange={(v) => apply('closeToTray', v)} label="关闭时最小化到后台" />
          </SettingRow>
          <SettingRow
            label="显示任务栏小组件"
            description="在任务栏显示托盘图标（输入法旁边），双击叫回控制台"
          >
            <Switch checked={s.showTrayIcon} onChange={(v) => apply('showTrayIcon', v)} label="显示任务栏小组件" />
          </SettingRow>
          <SettingRow
            label="不在任务栏显示控制台按钮"
            description="像 CC Switch 那样只从托盘图标进入；开着此项会强制保留托盘图标"
          >
            <Switch
              checked={s.hideFromTaskbar}
              onChange={(v) => apply('hideFromTaskbar', v)}
              label="不在任务栏显示控制台按钮"
            />
          </SettingRow>
        </Card>

        {/* ---------- 5. 远程访问 ---------- */}
        <Card title="远程访问 · Tailscale" desc="把服务暴露到 Tailnet，手机可用" icon={<Globe className="h-4 w-4" />}>
          {remote?.fqdn ? (
            <>
              {/* tailnet 地址：域名较长，用 stacked 让地址独占一行，避免压扁标签列。
                  同时不再重复显示：标签描述里已含域名与 IP，右侧只放域名本身 */}
              <SettingRow
                icon={<Link2 className="h-3.5 w-3.5" />}
                label="tailnet 地址"
                description={`域名 ${remote.fqdn} · IP ${remote.ipv4}`}
                layout="stacked"
              >
                <span className="p-mono p-dim p-text-2xs break-all">{remote.fqdn}</span>
              </SettingRow>

              <div className="p-remote-card">
                <div className="p-remote-card-title">
                  手机连接（推荐）
                  <span className="p-remote-tag">暴露面小</span>
                </div>
                <div className="p-mono p-dim p-text-2xs break-all">{`ws://${remote.fqdn}:3080/remote`}</div>
                <div className="p-note">
                  由 dsh-remote 插件提供，只开一条 WebSocket 路由；手机上用它远程指挥 harness 执行任务。
                </div>
                <div className="p-btn-row">
                  <CopyButton text={`ws://${remote.fqdn}:3080/remote`} label="手机连接地址" />
                </div>
              </div>

              <div className="p-remote-card">
                <div className="p-remote-card-title">
                  完整 Web UI
                  <span className="p-remote-tag p-remote-tag-warn">暴露面大</span>
                </div>
                <div className="p-mono p-dim p-text-2xs break-all">{remote.httpsUri}</div>
                <div className="p-note">
                  会把整个控制台页面（含管理后台、文件浏览）暴露到 Tailnet。
                  走<b>认证桥</b>：任何设备打开即用 —— 不需要 key，服务重启也不用重来。
                </div>
                <div className="p-btn-row">
                  <CopyButton text={remote.httpsUri} label="Web UI 地址" />
                  <button
                    className="p-btn"
                    title="在系统默认浏览器打开"
                    onClick={() => window.dshDesktop.openExternal(remote.httpsUri)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> 打开
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="p-mono p-dim p-text-xs">（未检测到 Tailscale —— 本机装/连上 Tailscale 后会出现手机地址）</p>
          )}

          <div className="p-btn-row">
            <button className="p-btn" title={isExposed ? '关闭 tailscale serve 暴露' : '开启 tailscale serve：经认证桥把服务广告到 tailnet'} disabled={exposeBusy || !remote?.fqdn} onClick={toggleExpose}>
              {exposeBusy ? '处理中…' : isExposed ? '● 已公开' : '○ 未公开'}
            </button>
            <button className="p-btn" title="重新读取地址" onClick={() => window.dshDesktop.remoteInfo().then(setRemote)}>
              <RefreshCw className="h-3.5 w-3.5" /> 刷新地址
            </button>
          </div>
          {remoteMsg && <p className="p-mono break-all p-text-xs p-warn-text">{remoteMsg}</p>}
          <div className="p-note">
            暴露链路：tailnet → tailscale serve（固定 8443）→ <b>认证桥 (127.0.0.1:3090)</b> → dsh 网关 (127.0.0.1:3080)。
            不要在外网直接开放 3080 —— 那会把一台可执行任意命令的机器挂上公网。
          </div>
        </Card>

        {/* ---------- 6. 更新 ---------- */}
        <Card title="更新" desc="后台静默下载，重启生效" icon={<Download className="h-4 w-4" />}>
          <SettingRow icon={<Info className="h-3.5 w-3.5" />} label="当前版本" description={`v${upd?.currentVersion || '—'}`}>
            <span className="p-mono p-dim p-text-2xs">
              {upd?.version && upd.status === 'downloaded' ? `→ v${upd.version}` : ''}
            </span>
          </SettingRow>
          <SettingRow label="更新状态" description={upd ? UPDATE_TEXT[upd.status] : '读取中…'}>
            <span className={`p-upd-state ${upd ? UPDATE_TONE[upd.status] : ''}`}>
              {upd?.status === 'downloading' && upd.percent ? `${upd.percent}%` : ''}
            </span>
          </SettingRow>
          {upd?.status === 'error' && upd.error && <p className="p-hint-text">{upd.error}</p>}
          <div className="p-btn-row">
            <ActionButton id="checkUpdate" ctx={ctx} onDone={onChanged} />
            <ActionButton id="installUpdate" ctx={ctx} onDone={onChanged} />
          </div>
          <div className="p-note">新版本在后台静默下载，不打断使用；下一次重启应用时自动生效。</div>
        </Card>

        {/* ---------- 7. 关于 / 只读信息 ---------- */}
        <Card title="关于" desc="运行时与内置资源信息" icon={<Info className="h-4 w-4" />}>
          <div className="p-info-grid">
            <div><div className="p-key">服务地址</div><div className="p-value p-text-sm">{state.serverUrl}</div></div>
            <div><div className="p-key">Electron</div><div className="p-value p-text-sm">{state.versions.electron}</div></div>
            <div><div className="p-key">Chromium</div><div className="p-value p-text-sm">{state.versions.chrome}</div></div>
            <div><div className="p-key">Node</div><div className="p-value p-text-sm">{state.versions.node}</div></div>
            <div><div className="p-key">运行模式</div><div className="p-value p-text-sm">{state.isPackaged ? '安装版' : '开发版'}</div></div>
            <div><div className="p-key">访问凭据</div><div className="p-value p-text-sm">{state.hasToken ? '已捕获' : '未捕获'}</div></div>
          </div>
          <SectionLabel>当前启动命令</SectionLabel>
          <div className="p-mono p-code-block">{state.launchDisplay}</div>
          <SectionLabel>实用动作</SectionLabel>
          <div className="p-btn-row">
            <button className="p-btn" title="更换左侧文件浏览的根目录" onClick={async () => { await window.dshDesktop.fsSetRoot(); onChanged(); }}>
              <FolderInput className="h-3.5 w-3.5" /> 更换文件根目录
            </button>
            <button className="p-btn" title="清空服务终端里的日志显示" onClick={() => window.dispatchEvent(new CustomEvent('dsh-clear-logs'))}>
              <Trash2 className="h-3.5 w-3.5" /> 清空日志
            </button>
          </div>
        </Card>
      </div>

      {/* 退出应用：与托盘菜单的「退出」同一行为，放在页面最底部（破坏性操作不放在卡片流里） */}
      <div className="p-admin-foot">
        <button
          className="p-btn p-danger-btn"
          title="退出 DSH Desktop（含停止后台服务）"
          onClick={() => window.dshDesktop.winQuit()}
        >
          <Power className="h-3.5 w-3.5" /> 退出 DSH Desktop
        </button>
        <span className="p-mono p-dim p-text-2xs">
          点窗口关闭按钮只会收进后台；要真正退出用这里或托盘菜单的「退出」。
        </span>
      </div>
    </div>
  );
}
