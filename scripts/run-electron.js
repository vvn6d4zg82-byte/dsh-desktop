'use strict';

// 以干净环境启动 electron：防止外部残留的 ELECTRON_RUN_AS_NODE=1 把主进程变成 node 模式
// （那样 require('electron') 拿不到 app，主窗口起不来）
const { spawn } = require('child_process');
const electronPath = require('electron'); // 返回 electron 可执行文件路径（字符串）

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { env, stdio: 'inherit', windowsHide: false });
child.on('close', (code) => process.exit(code === null ? 0 : code));
child.on('error', (err) => {
  console.error('electron 启动失败:', err.message);
  process.exit(1);
});
