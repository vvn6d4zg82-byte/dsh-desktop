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

- 🪟 原生窗口加载 DSH Web GUI（自动读取 `DSH_WEB_URL` 环境变量，默认 `http://127.0.0.1:3080`）
- 🔁 服务离线时显示「未连接」提示页，每 3 秒自动探测，上线后自动进入，也可手动重试
- 🖱️ 外部链接（非 DSH 服务的 http/https）自动用系统默认浏览器打开
- 📌 单实例运行：重复启动会聚焦已有窗口，不会开多个
- 🧭 内置中文菜单：重新加载 / 缩放 / 全屏 / 开发者工具 / 关于
- 🚀 一键安装器：装到 `%LOCALAPPDATA%\Programs\@dsh-aidesktop\`，自动创建桌面与开始菜单快捷方式

## 快速开始

### 方式一：一键安装（推荐）

下载最新 [Release](https://github.com/vvn6d4zg82-byte/dsh-desktop/releases) 里的
`DSH-Desktop-Setup-<版本>.exe`，双击安装，装完自动启动。

安装位置：`%LOCALAPPDATA%\Programs\@dsh-aidesktop\DSH Desktop.exe`

### 方式二：从源码运行

```bash
npm install
npm start
```

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

> **离线构建**：打包默认复用 `node_modules/electron/dist`（`build.electronDist`），不联网下载 Electron。
> **证书问题**：内网/代理环境遇到 `unable to verify the first certificate` 时，
> 用系统证书信任再打包：
> ```powershell
> $env:NODE_OPTIONS = "--use-system-ca"; npm run dist
> ```
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
