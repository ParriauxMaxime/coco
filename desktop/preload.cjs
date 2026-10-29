// What the coco page may tell the desktop shell (how many things wait on the owner), and the classes its CSS reads: in the desktop app, in full screen.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cocoDesktop', {
  setWaiting: (count) => ipcRenderer.send('coco:waiting', Number(count) || 0),
});

const root = () => document.documentElement;
window.addEventListener('DOMContentLoaded', () => root().classList.add('dp-desktop'));
ipcRenderer.on('coco:open', (_e, hash) => { location.hash = hash; });
ipcRenderer.on('coco:fullscreen',(_e, on) => root().classList.toggle('dp-fullscreen', Boolean(on)));
