import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary, { watchErrors } from './ErrorBoundary.tsx';
import './styles.css';
import './workbench/workbench.css';

watchErrors();
const root = document.getElementById('root');
if (root) createRoot(root).render(<ErrorBoundary><App /></ErrorBoundary>);
