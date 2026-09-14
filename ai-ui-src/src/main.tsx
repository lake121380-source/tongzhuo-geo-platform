import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConfirmProvider, ToastProvider } from './components/ui';
import './index.css';

/**
 * 全局能力（Design System · D1）挂在最外层：
 *   ToastProvider   —— 统一的成功/失败反馈（原来只有 window.alert 和各页内联文字）
 *   ConfirmProvider —— 统一的确认对话框（原来 15 处 window.confirm，样式不可控、
 *                      在内嵌浏览器里甚至不渲染）
 * 放在 App 之外，登录页/启动遮罩这些"App 还没渲染完"的阶段也能弹提示与确认。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>
);
