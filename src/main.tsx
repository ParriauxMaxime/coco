import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';
import './workbench/workbench.css';

createRoot(document.getElementById('root')).render(<App />);
