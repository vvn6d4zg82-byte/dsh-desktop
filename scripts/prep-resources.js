'use strict';

// 构建期准备内置资源：
//   1. dsh 依赖树（优先从本机 npx 缓存复制，否则 npm install @deepseek-ai/dsh）
//   2. 瘦身（删除非 win32-x64 的预编译平台目录）
// 运行时用 Electron 自带 node（ELECTRON_RUN_AS_NODE）直接跑内置 dsh，不捆绑独立 node.exe。
// 产物进 resources/，不入 git，由 electron-builder extraResources 打进安装包。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const DSH_DIR = path.join(RES, 'dsh');
const DSH_PKG_DIR = path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh');

const FORCE = process.argv.includes('--force');
const DSH_VERSION = (process.env.DSH_VERSION || 'latest').trim();

function log(msg) {
  console.log(`[prep] ${msg}`);
}

function fail(msg) {
  console.error(`[prep] ERROR: ${msg}`);
  process.exit(1);
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function installedDshVersion() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DSH_PKG_DIR, 'package.json'), 'utf8'));
    return p.version || null;
  } catch {
    return null;
  }
}

// 从本机 npx 缓存找现成的 dsh 树（跑过 `npx @deepseek-ai/dsh` 的机器都有），命中直接复制，免安装
function findLocalNpxDsh() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm-cache', '_npx'),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of entries) {
      const pkgDir = path.join(root, dir, 'node_modules', '@deepseek-ai', 'dsh');
      try {
        const v = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
        if (DSH_VERSION !== 'latest' && DSH_VERSION !== v) continue;
        return { nodeModules: path.join(root, dir, 'node_modules'), version: v };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function ensureDsh() {
  const current = installedDshVersion();
  if (current && !FORCE && (DSH_VERSION === 'latest' || DSH_VERSION === current)) {
    log(`dsh 已存在：@deepseek-ai/dsh@${current}`);
    return current;
  }
  // 快路径：本机 npx 缓存有现成 dsh 树 → 直接复制，免联网安装
  const local = findLocalNpxDsh();
  if (local && !FORCE) {
    log(`复制 npx 缓存 dsh@${local.version}（免安装）`);
    fs.rmSync(DSH_DIR, { recursive: true, force: true });
    fs.mkdirSync(DSH_DIR, { recursive: true });
    fs.cpSync(local.nodeModules, path.join(DSH_DIR, 'node_modules'), { recursive: true });
    if (!installedDshVersion()) fail('复制 npx 缓存后校验不到 dsh');
    return installedDshVersion();
  }
  const spec = DSH_VERSION === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${DSH_VERSION}`;
  log(`安装 dsh（${spec}）到 ${DSH_DIR} …`);
  fs.rmSync(DSH_DIR, { recursive: true, force: true });
  const npmCli = findNpmCli();
  const args = ['install', '--prefix', DSH_DIR, '--omit=dev', '--no-audit', '--no-fund', spec];
  if (npmCli) {
    const r = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' });
    if (r.status !== 0) fail('dsh 安装失败');
  } else {
    const r = spawnSync('npm.cmd', args, { stdio: 'inherit', shell: true });
    if (r.status !== 0) fail('dsh 安装失败');
  }
  if (!installedDshVersion()) fail('dsh 安装后校验不到版本号');
  log(`dsh 安装完成：@deepseek-ai/dsh@${installedDshVersion()}`);
  return installedDshVersion();
}

function prunePlatformDirs() {
  const pty = path.join(DSH_DIR, 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(pty)) return;
  for (const name of fs.readdirSync(pty)) {
    if (name !== 'win32-x64') {
      try {
        fs.rmSync(path.join(pty, name), { recursive: true, force: true });
        log(`瘦身：删除 node-pty/prebuilds/${name}`);
      } catch { /* ignore */ }
    }
  }
}

function writeVersionJson(dshVer) {
  fs.writeFileSync(
    path.join(RES, 'version.json'),
    JSON.stringify({ dshVersion: dshVer }, null, 2) + '\n'
  );
  log(`version.json: {"dshVersion":"${dshVer}"}`);
}

function main() {
  fs.mkdirSync(RES, { recursive: true });
  log(FORCE ? 'force 模式：重新准备全部资源' : '增量模式：已存在则跳过（--force 重做）');
  const dshVer = ensureDsh();
  prunePlatformDirs();
  writeVersionJson(dshVer);
  log('完成。');
}

main();
