// 回归测试：工作台窗口关闭 / loadURL 失败后，延迟触发的 did-finish-load
// 不得再抛 "Cannot read properties of null (reading 'webContents')"。
//
// 做法：用最小 Electron 桩件加载 src/main.js 的真实逻辑片段不现实（依赖 electron 模块），
// 因此这里复现的是「同一段代码形态」的两种写法对比：旧写法（读模块级可变量）会崩，
// 新写法（回调绑定实例）不会。用于证明修法有效，并留作回归护栏。
//
// 运行：node scripts/test-workbench-crash.mjs
'use strict';

import assert from 'node:assert';

// --- 模拟 BrowserWindow 与模块级状态 ---
function makeWindow({ loadURLRejects = false } = {}) {
  const handlers = {};
  const w = {
    destroyed: false,
    webContents: {
      css: [],
      on(evt, cb) {
        handlers[evt] = cb;
      },
    },
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    on(evt, cb) {
      handlers[evt] = cb;
    },
    async loadURL() {
      if (loadURLRejects) throw new Error('ERR_CONNECTION_REFUSED');
    },
    // 测试钩子：模拟生命周期事件
    _emit(evt) {
      if (handlers[evt]) handlers[evt]();
    },
    _handlers: handlers,
  };
  return w;
}

const applyTerminalCss = (webContents) => {
  assert.ok(webContents, 'applyTerminalCss 收到 null —— 正是崩溃点');
  webContents.css.push('TERMINAL');
};

// ===== 旧写法：回调读模块级可变 workbenchWin =====
async function oldOpen(loadURLRejects) {
  let workbenchWin = null;
  const wb = makeWindow({ loadURLRejects });
  workbenchWin = wb;
  workbenchWin.webContents.on('did-finish-load', () => {
    applyTerminalCss(workbenchWin.webContents); // ← 旧代码，无守卫
  });
  workbenchWin.on('closed', () => {
    workbenchWin = null;
  });
  try {
    await workbenchWin.loadURL('http://127.0.0.1:3080/');
  } catch {
    workbenchWin = null; // ← 置空，但 did-finish-load 可能仍未触发
    return { wb };
  }
  return { wb };
}

// ===== 新写法：回调绑定本次创建的实例 =====
async function newOpen(loadURLRejects) {
  let workbenchWin = null;
  const wb = makeWindow({ loadURLRejects });
  workbenchWin = wb;

  wb.webContents.on('did-finish-load', () => {
    if (!wb.isDestroyed()) applyTerminalCss(wb.webContents);
  });
  wb.on('closed', () => {
    if (workbenchWin === wb) workbenchWin = null;
  });
  try {
    await wb.loadURL('http://127.0.0.1:3080/');
    if (wb.isDestroyed()) {
      if (workbenchWin === wb) workbenchWin = null;
      return { wb, ok: false };
    }
  } catch {
    if (workbenchWin === wb) workbenchWin = null;
    if (!wb.isDestroyed()) wb.destroy();
    return { wb, ok: false };
  }
  return { wb, ok: true };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

console.log('回归测试：工作台 did-finish-load 的 null 崩溃\n');

// 1) 旧写法在 loadURL 失败 + 延迟 did-finish-load 时必须崩（证明能复现）
{
  const { wb } = await oldOpen(true);
  check('旧写法：loadURL 失败后触发 did-finish-load → 抛 TypeError（复现原崩溃）', () => {
    assert.throws(() => wb._emit('did-finish-load'), {
      name: 'TypeError',
      message: /reading 'webContents'/,
    });
  });
}

// 2) 新写法同样场景必须不崩
{
  const { wb } = await newOpen(true);
  check('新写法：loadURL 失败后触发 did-finish-load → 不抛异常', () => {
    assert.doesNotThrow(() => wb._emit('did-finish-load'));
  });
}

// 3) 新写法：窗口已被用户关闭后触发 did-finish-load → 不崩
{
  const { wb } = await newOpen(false);
  wb.destroy();
  wb._emit('closed');
  check('新写法：窗口关闭后触发 did-finish-load → 不抛异常', () => {
    assert.doesNotThrow(() => wb._emit('did-finish-load'));
  });
}

// 4) 新写法：正常路径仍然要注入终端隐藏 CSS（修复不能把功能修没）
{
  const { wb } = await newOpen(false);
  wb._emit('did-finish-load');
  check('新写法：正常路径仍注入终端隐藏 CSS', () => {
    assert.deepStrictEqual(wb.webContents.css, ['TERMINAL']);
  });
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
