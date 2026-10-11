// Tells the page it's running in the desktop app (the Download tab says so), and nothing else:
// the page gets no access to files, Node or Electron. (Sandboxed preloads can't read files, so the
// version arrives as a start-up argument from main.js.)
'use strict';
const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--ea-version='));
contextBridge.exposeInMainWorld('eaDesktop', Object.freeze({
  version: arg ? arg.slice('--ea-version='.length) : '',
  platform: process.platform,
}));
