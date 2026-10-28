// What the coco page may tell the desktop shell: how many things wait on the owner.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cocoDesktop', {
  setWaiting: (count) => ipcRenderer.send('coco:waiting', Number(count) || 0),
});
