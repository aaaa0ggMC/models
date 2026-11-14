import React from 'react';
import { createRoot } from 'react-dom/client';
// Semi 全量样式：一次性引入，保证组件样式齐全（自托管、无 CDN、离线可用）。
import '@douyinfe/semi-ui/dist/css/semi.min.css';
import { App } from './App';
import { AuthProvider } from './auth';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
