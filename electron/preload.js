// preload.js — safe bridge between the web UI and the local filesystem.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  loadData: () => ipcRenderer.invoke('desktop:load'),
  saveData: (data) => ipcRenderer.invoke('desktop:save', data),
  backup: (payloadText) => ipcRenderer.invoke('desktop:backup', payloadText),
  restore: () => ipcRenderer.invoke('desktop:restore'),
  savePdf: (bytes, saleId, customerName) => ipcRenderer.invoke('desktop:savePdf', bytes, saleId, customerName),
  printPdf: (bytes) => ipcRenderer.invoke('desktop:printPdf', bytes),
  paths: () => ipcRenderer.invoke('desktop:paths'),
  version: () => ipcRenderer.invoke('desktop:version'),
  showDataLocation: () => ipcRenderer.invoke('desktop:showDataLocation'),
  onMenu: (callback) => ipcRenderer.on('menu', (_event, action) => callback(action)),
  // Custom window controls
  minimize: () => ipcRenderer.invoke('desktop:winMinimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop:winToggleMaximize'),
  close: () => ipcRenderer.invoke('desktop:winClose'),
  isMaximized: () => ipcRenderer.invoke('desktop:winIsMaximized'),
  onMaximized: (callback) => ipcRenderer.on('window-maximized', (_event, maximized) => callback(maximized))
});
