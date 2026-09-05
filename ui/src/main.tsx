import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './retro.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="retro-app h-screen overflow-hidden">
      <App />
    </div>
  </React.StrictMode>
);
