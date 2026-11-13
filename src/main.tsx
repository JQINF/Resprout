import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('找不到应用挂载点 #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
