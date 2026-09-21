import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './versions/primer/p-console.css';
import { ensureBrowserShim } from './lib/browserShim';
import PrimerApp from './versions/primer/App';

// 纯浏览器预览（无 Electron preload）时注入 mock 数据；Electron 内无影响
ensureBrowserShim();

// ---------------------------------------------------------------------------
// 正式版：Primer (GitHub) 设计系统（比赛胜出方案）
// 布局：GitHub 顶栏 + 左侧导航列表 + 内容区；终端为深色代码块视口。
// ?tab=admin 可定位管理后台（默认服务终端）。
// ---------------------------------------------------------------------------
const initialView = new URLSearchParams(window.location.search).get('tab') === 'admin' ? 'admin' : 'console';
document.documentElement.classList.add('view-primer');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrimerApp initialView={initialView} />
  </React.StrictMode>
);