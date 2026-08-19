'use strict';
/**
 * Mini-OJ 可信 Windows Judge Worker —— Electron 主进程
 * 系统托盘 + 状态窗口 + 核心 Agent（注册/心跳/收任务/评测/回传）
 *
 * 运行：npm start（需先 npm install 安装 electron）
 * 无 GUI 环境可改用 headless：node judge/headless.js
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const agent = require('./agent/core');

let win = null;
let tray = null;
let statusLines = [];

function createWindow() {
  win = new BrowserWindow({
    width: 720, height: 520, show: false,
    title: 'Mini-OJ Trusted Worker',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', (e) => { e.preventDefault(); win.hide(); });
}

function createTray() {
  // 用 16x16 点阵生成托盘图标（无需外部资源）
  const size = 16;
  const canvas = nativeImage.createEmpty();
  const bmp = require('electron').nativeImage.createFromBitmap ? null : null;
  // 简化：生成一个纯色位图作为占位
  tray = new Tray(nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk+M9Qz0AEYBxVSFUBAP0AAf8Vd3B5AAAAAElFTkSuQmCC'
  ));
  tray.setToolTip('Mini-OJ Trusted Worker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开面板', click: () => win && win.show() },
    { label: '退出', click: () => { app.quit(); } }
  ]));
  tray.on('click', () => win && win.show());
}

function updateStatus(msg) {
  statusLines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (statusLines.length > 100) statusLines.shift();
  if (win && !win.isDestroyed()) {
    win.webContents.send('status', { lines: statusLines });
  }
}

app.whenReady().then(async () => {
  createWindow();
  createTray();

  const argv = process.argv.slice(1);
  const args = { server: process.env.MINIOJ_SERVER || null, register: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--register') args.register = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
  }
  if (!args.server) args.server = process.env.MINIOJ_SERVER || 'http://localhost:3000';

  try {
    await agent.run(args, { onStatus: updateStatus });
  } catch (err) {
    updateStatus('致命错误: ' + err.message);
    console.error('[fatal]', err.message);
  }
});

app.on('window-all-closed', () => { /* 保持托盘运行 */ });
