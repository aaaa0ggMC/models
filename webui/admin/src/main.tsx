import React from 'react';
import { createRoot } from 'react-dom/client';
// Semi 全量样式：一次性引入，保证组件样式齐全（自托管、无 CDN、离线可用）。
import '@douyinfe/semi-ui/dist/css/semi.min.css';
// 视觉基座：设计令牌 + 应用外壳。必须排在 Semi 之后——里面要覆盖 Semi 的
// 语义令牌（primary / radius / shadow / border），同等特异性下后写的赢。
import './styles/theme.css';
import { App } from './App';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
