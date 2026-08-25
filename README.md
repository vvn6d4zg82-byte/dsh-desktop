# DSH Desktop

> DeepSeek Harness 的桌面客户端 —— 一个轻量 Electron 包装，把 DSH Web GUI 装进原生窗口。
> 安装与使用流程对齐 opencode 桌面端：一键安装器 → `%LOCALAPPDATA%\Programs\@dsh-aidesktop\` → 桌面快捷方式。

## 项目介绍

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）是一个 AI 编码代理平台，提供浏览器端的 Web GUI。
**DSH Desktop** 为它提供了一个原生桌面壳：

- 无需打开浏览器，双击即进入 DSH 工作台；
- 原生窗口体验：系统菜单、缩放、全屏、任务栏图标、单实例聚焦；
- 服务未启动时自动探测，上线后自动进入，无需手动刷新。

它本身**不包含任何 AI 能力**，只负责把 DSH Web 服务包装成桌面应用。

## 功能特性

- 🪟 原生窗口 = **shadcn/ui 双控制台**：服务终端（完整 dsh 日志 + 命令输入）+ 管理后台（服务启停/设置/版本信息）
- ⚡ **服务未运行时自动拉起**：系统 node + dsh 直连（npx 缓存，带 `--expose-internals`，跳过 cmd/批处理快 ~4s）；
  无缓存时自动 `npx --yes @deepseek-ai/dsh web` 联网安装（首次较慢，控制台可见进度）
- 🖥️ DSH 网页界面（工作台）在独立窗口打开，支持一键打开/关闭
- 📺 **可隐藏 DSH 网页里的终端界面**：菜单「视图 → 隐藏终端界面」（默认开启），
  通过注入 `[data-terminal]{display:none}` 实现
- ⏱️ 启动就绪等待 + 3 分钟超时看门狗 + 失败自动重试（15s 冷却）
- 🔐 给拉起的服务注入 `--use-system-ca`（内网/代理证书环境）与环回地址免代理
- 🖱️ 外部链接（非 DSH 服务的 http/https）自动用系统默认浏览器打开
- 📌 单实例运行：重复启动会聚焦已有窗口，不会开多个
- 🚀 一键安装器：装到 `%LOCALAPPDATA%\Programs\@dsh-aidesktop\`，自动创建桌面与开始菜单快捷方式

## 服务管理

- **开机自启（默认开启）**：安装版首次运行即注册 Windows 登录项（菜单「服务 → 开机自动启动」可关）。
  配合自动拉起：重启电脑后 DSH 服务在后台自动就绪，双击应用即用
- **终端全程后台静默**：dsh 由系统 node 静默运行（进程树中无 cmd/batch，绝不弹窗）；
  自定义命令经 `CREATE_NO_WINDOW` 方式启动，同样不弹任何终端/控制台窗口
- **自动拉起**：检测到 DSH 服务未运行且「自动启动」开启时，静默启动 dsh（优先 npx 缓存直连，无缓存联网安装），服务就绪后自动进入
- **自定义命令**：修改用户数据目录下 `settings.json` 的 `serverCommand` 字段，或用环境变量 `DSH_DESKTOP_SERVER_CMD` 覆盖

## 快速开始

### 方式一：一键安装（推荐）

下载最新 [Release](https://github.com/vvn6d4zg82-byte/dsh-desktop/releases) 里的
`DSH-Desktop-Setup-<版本>.exe`，双击安装，装完自动启动。

安装位置：`%LOCALAPPDATA%\Programs\@dsh-aidesktop\DSH Desktop.exe`

> 轻量安装包（~96MB）。**首次运行需联网**：应用会自动 `npx` 安装并启动 dsh 服务（控制台可见进度）；
> 需要系统装有 Node.js。装好一次后走 npx 缓存直连，后续离线可用。

### 方式二：从源码运行

```bash
npm install
npm start
```

> electron 二进制在 `npm install` 时自动下载（走 `.npmrc` 配置的 npmmirror 镜像，无需手动跑 install.js）。
> `npm start` 首次会通过系统 node 拉 dsh 服务（慢一点，之后走 npx 缓存直连）。

## 服务地址配置

窗口会自动连接 DSH Web 服务，地址解析顺序：

1. 命令行参数：`npm start -- --url=http://127.0.0.1:3080`
2. 环境变量：`DSH_WEB_URL`
3. 默认：`http://127.0.0.1:3080`

## 打包安装器

```bash
npm run dist
```

产物：`dist/DSH-Desktop-Setup-<版本>.exe`（NSIS 一键安装器）

> `npm run dist` 先 `vite build` 前端（`ui/dist`）再 electron-builder 打包，安装包轻量（~96MB），不含 dsh 依赖树。
> **离线构建**：打包默认复用 `node_modules/electron/dist`（`build.electronDist`），不联网下载 Electron。
> **证书问题**：内网/代理环境遇到 `unable to verify the first certificate` 时，
> 用系统证书信任再打包：
> ```powershell
> $env:NODE_OPTIONS = "--use-system-ca"; npm run dist
> ```
> 开发机 `npm install` 遇到证书错误同理：`npm config set strict-ssl false`（仅限信任的网络）。
> **安装目录名**：`@dsh-aidesktop` 由 `build/installer.nsh`（electron-builder 自动加载的自定义 NSIS 段）
> 注入，改这个文件即可自定义目录名。

## 技术栈

- [Electron](https://www.electronjs.org/) 43
- [electron-builder](https://www.electron.build/) 26（NSIS 一键安装器）

## 目录结构

```
dsh-desktop/
├── src/
│   ├── main.js          # 主进程：窗口、服务探测、菜单、单实例
│   ├── preload.js       # 预加载脚本（contextBridge 安全桥接）
│   └── fallback.html    # 服务未连接时的提示页
├── build/
│   ├── icon.png         # 应用图标
│   └── installer.nsh    # 自定义 NSIS 段（安装目录名）
├── package.json
└── README.md
```

## 许可证

[MIT](./LICENSE)
