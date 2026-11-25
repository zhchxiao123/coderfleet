'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coderFleet', {
  list: () => ipcRenderer.invoke('backends:list'),
  addLocal: () => ipcRenderer.invoke('backends:addLocal'),
  addRemote: input => ipcRenderer.invoke('backends:addRemote', input),
  remove: id => ipcRenderer.invoke('backends:remove', id),
  connect: id => ipcRenderer.invoke('backends:connect', id),
  restartLocal: id => ipcRenderer.invoke('backends:restartLocal', id),
  setLan: (id, enabled) => ipcRenderer.invoke('backends:setLan', id, enabled),
  request: (id, method, path, body) => ipcRenderer.invoke('backends:request', { id, method, path, body }),
  setupLocal: () => ipcRenderer.invoke('backends:setupLocal'),
  pickDirectory: () => ipcRenderer.invoke('dialog:directory'),
  pickFile: () => ipcRenderer.invoke('dialog:file'),
  addSsh: input => ipcRenderer.invoke('remote:addSsh', input),
  reinstallSsh: id => ipcRenderer.invoke('remote:reinstall', id),
  job: id => ipcRenderer.invoke('jobs:get', id),
  bundle: () => ipcRenderer.invoke('remote:bundle'),
  /** Shows one system notification now: { ok, error? }. */
  testNotification: () => ipcRenderer.invoke('notifications:test'),
  /** A clicked system notification: { backendId, conversationId, projectId }. */
  onOpenConversation: callback => ipcRenderer.on('notifications:open', (_event, target) => callback(target)),
  platform: process.platform,
});
