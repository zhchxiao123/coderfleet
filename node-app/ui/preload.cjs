'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coderFleet', {
  list: () => ipcRenderer.invoke('backends:list'),
  addLocal: () => ipcRenderer.invoke('backends:addLocal'),
  addRemote: input => ipcRenderer.invoke('backends:addRemote', input),
  remove: id => ipcRenderer.invoke('backends:remove', id),
  connect: id => ipcRenderer.invoke('backends:connect', id),
  request: (id, method, path, body) => ipcRenderer.invoke('backends:request', { id, method, path, body }),
  setupLocal: () => ipcRenderer.invoke('backends:setupLocal'),
  pickDirectory: () => ipcRenderer.invoke('dialog:directory'),
  platform: process.platform,
});
