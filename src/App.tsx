import React, { useEffect, useState } from 'react';
import Toasts from './components/Toast.tsx';
import Dialogs from './components/Dialogs.tsx';
import DesignPreview from './preview/DesignPreview.tsx';
import Pages from './preview/Pages.tsx';
import { PHONE } from './preview/Shell.tsx';

const current = () => {
  // a phone opens on what waits on you
  if (!location.hash && matchMedia(PHONE).matches) history.replaceState(null, '', '#/waiting');
  const hash = location.hash || '#/';
  if (!hash.startsWith('#/design-preview')) return hash;
  const work = hash.replace(/^#\/design-preview/, '#/work');
  history.replaceState(null, '', work);
  return work;
};

const useHash = () => {
  const [hash, setHash] = useState(current);
  useEffect(() => {
    const on = () => setHash(current());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '');
};

export default function App() {
  const route = useHash();
  const [root, a] = route.split('/').filter(Boolean);
  if (root === 'work' && a !== 'new') return <><DesignPreview slug={a} /><Toasts /><Dialogs /></>;
  return <><Pages route={route} /><Toasts /><Dialogs /></>;
}
