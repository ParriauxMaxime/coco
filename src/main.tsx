import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary, { watchErrors } from './ErrorBoundary.tsx';
import { watchUpdates } from './updates.ts';
import './styles.css';
import './workbench/workbench.css';

// the height left above an on-screen keyboard, for browsers that only shrink the visual viewport: the phone layout fits in it
const fit = () => visualViewport && document.documentElement.style.setProperty('--dp-vh', `${Math.round(visualViewport.height)}px`);
visualViewport?.addEventListener('resize', fit);
fit();

watchErrors();
watchUpdates();
const root = document.getElementById('root');
if (root) createRoot(root).render(<ErrorBoundary><App /></ErrorBoundary>);
