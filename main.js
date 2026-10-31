// main.js —— 星兔启动器主进程（全接口版）
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Client } = require('minecraft-launcher-core');
const crypto = require('crypto');

let mainWindow = null;
let launcher = null; // mclc 实例
let cancelFlag = false; // 取消下载标志

// ===== 路径与配置 =====
function defaultGameDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}
function cfgPath() { return path.join(app.getPath('userData'), 'config.json'); }
function musicDir() { return path.join(app.getPath('userData'), 'music'); }
function favDir() { return path.join(app.getPath('userData'), 'music', 'favorites'); }
function skinPath() { return path.join(app.getPath('userData'), 'skin.png'); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf-8')); } catch (_) { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}
function getCfg() {
  const c = loadConfig();
  return {
    playerName: c.playerName || 'Steve',
    maxMemory: c.maxMemory || 2048,
    theme: c.theme || 'green',
    customColor: c.customColor || '',
    gameDir: c.gameDir || defaultGameDir(),
    authConfig: c.authConfig || {}
  };
}

// ===== 工具 =====
// ===== 批量日志：攒 200ms 一次性发给界面，避免 IPC 刷屏导致鼠标延迟 =====
const _logQueue = [];
let _logTimer = null;
function flushLogs() {
  _logTimer = null;
  if (mainWindow && !mainWindow.isDestroyed() && _logQueue.length) {
    mainWindow.webContents.send('game-log', _logQueue.join('\n'));
    _logQueue.length = 0;
  }
}
function sendLog(text) {
  _logQueue.push(String(text));
  if (!_logTimer) _logTimer = setTimeout(flushLogs, 200);
}
function sendProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', p);
}

// ===== 全局下载并发池：最多 6 个网络请求同时跑，防止带宽/IO 打爆 =====
const _pool = { active: 0, wait: [], max: 6 };
async function poolRun(task) {
  if (_pool.active >= _pool.max) {
    await new Promise(res => _pool.wait.push(res));
  }
  _pool.active++;
  try {
    return await task();
  } finally {
    _pool.active--;
    const next = _pool.wait.shift();
    if (next) next();
  }
}

// 简单 https GET（返回 Buffer）
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'XingTuLauncher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        return resolve(httpGet(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}
function httpGetJSON(url) { return httpGet(url).then(b => JSON.parse(b.toString('utf-8'))); }
function httpDownload(url, dest, timeoutMs = 60000, redirects = 0) {
  return poolRun(() => new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? require('http') : https;
    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch (e) {
      return reject(e);
    }
    const cleanup = () => {
      try { file.destroy(); } catch (_) {}
      setTimeout(() => { try { fs.unlinkSync(dest); } catch (_) {} }, 100);
    };
    const req = lib.get(url, { headers: { 'User-Agent': 'XingTuLauncher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        const next = new URL(res.headers.location, url).href;
        return resolve(httpDownload(next, dest, timeoutMs, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close(); res.resume();
        try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      // 节流进度：200ms 才上报一次，不逐块发 IPC
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let got = 0, lastReport = 0;
      res.on('data', d => {
        got += d.length;
        const now = Date.now();
        if (total && now - lastReport > 200) {
          lastReport = now;
          sendProgress({ total, progress: got, name: path.basename(dest) });
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('下载超时(' + timeoutMs + 'ms): ' + url));
    });
    req.on('error', e => {
      cleanup();
      reject(e);
    });
    req.on('close', () => { cleanup(); });
  }));
}

// 确保游戏内中文
function ensureChineseLang(gameDir) {
  const optFile = path.join(gameDir, 'options.txt');
  let lines = fs.existsSync(optFile) ? fs.readFileSync(optFile, 'utf-8').split(/\r?\n/) : [];
  let found = false;
  lines = lines.map(l => {
    if (l.startsWith('lang:')) { found = true; return 'lang:zh_cn'; }
    return l;
  });
  if (!found) lines.push('lang:zh_cn');
  fs.writeFileSync(optFile, lines.join('\n'), 'utf-8');
}

// ===== 版本扫描 =====
function scanInstalledVersions(gameDir) {
  const dir = path.join(gameDir, 'versions');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    const json = path.join(sub, name + '.json');
    if (fs.statSync(sub).isDirectory() && fs.existsSync(json)) out.push(name);
  }
  return out;
}

// ===== 窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 680, minWidth: 900, minHeight: 600,
    title: '星兔启动器', backgroundColor: '#1a1a2e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: false
    }
  });

  // 调试：打印前端控制台日志、加载失败信息
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[前端 ${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[加载失败] code=${code} ${desc} url=${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log('[渲染进程崩溃]', details);
  });

  // 自动定位 index.html：先找 src/ 下，找不到就找同级目录
  const candidates = [
    path.join(__dirname, 'src', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  const indexFile = candidates.find(p => fs.existsSync(p));

  console.log('[调试] 候选路径:');
  candidates.forEach(p => console.log('   ', p, fs.existsSync(p) ? '✓存在' : '✗'));

  if (!indexFile) {
    dialog.showErrorBox('文件缺失', '找不到 index.html，已尝试:\n' + candidates.join('\n') +
      '\n\n请把 index.html 放到上面任意一个位置。');
    return;
  }
  console.log('[调试] 实际加载:', indexFile);
  mainWindow.loadFile(indexFile);
  mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ===== IPC：配置 =====
ipcMain.handle('get-config', () => getCfg());

ipcMain.handle('save-settings', (_e, patch) => {
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  saveConfig(next);
  return true;
});

ipcMain.handle('choose-game-dir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  saveConfig({ ...loadConfig(), gameDir: dir });
  return dir;
});

// ===== IPC：版本列表 =====
ipcMain.handle('get-versions', async () => {
  const cfg = getCfg();
  let allVersions = [];
  try {
    const data = await httpGetJSON('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json');
    allVersions = data.versions || [];
    sendLog(`[星兔] 共获取到 ${allVersions.length} 个版本`);
  } catch (e) {
    sendLog('[星兔] BMCLAPI获取失败: ' + e.message);
    try {
      const data = await httpGetJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      allVersions = data.versions || [];
    } catch (_) {}
  }
  return { releases: allVersions, installed: scanInstalledVersions(cfg.gameDir) };
});

// ===== IPC：启动游戏 =====
ipcMain.handle('launch-game', (_e, versionId) => {
  const cfg = getCfg();
  const gameDir = cfg.gameDir;
  ensureChineseLang(gameDir);

  // 调试日志：看看前端到底传了什么过来
  sendLog(`[调试] versionId 类型: ${typeof versionId}, 值: ${JSON.stringify(versionId)}`);

  // 防御：不管前端传过来的是字符串还是对象，都抠出版本号字符串
  let verNum;
  if (typeof versionId === 'string') {
    verNum = versionId;
  } else if (typeof versionId === 'object' && versionId !== null) {
    verNum = versionId.number || versionId.id || versionId.version || '';
  } else {
    verNum = String(versionId || '');
  }
  sendLog(`[调试] 提取到版本号: "${verNum}"`);

  // 清理0字节的库文件（下载失败残留），让mclc重新下载
  if (verNum.startsWith('fabric-')) {
    const libDir = path.join(gameDir, 'libraries', 'net', 'fabricmc');
    let cleaned = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
        if (f.endsWith('.jar') && fs.statSync(fp).size < 1024) {
          fs.rmSync(fp, { force: true });
          cleaned++;
          sendLog(`[星兔] 清理损坏文件: ${f} (${fs.statSync(fp).size}bytes)`);
        }
      }
    };
    walk(libDir);
    if (cleaned > 0) sendLog(`[星兔] 已清理 ${cleaned} 个损坏文件，将重新下载`);
  }

  return new Promise((resolve, reject) => {
    // 写入中文语言设置
    try {
      const optFile = path.join(gameDir, 'options.txt');
      let opts = '';
      if (fs.existsSync(optFile)) opts = fs.readFileSync(optFile, 'utf-8');
      if (!/^lang:/m.test(opts)) opts += (opts ? '\n' : '') + 'lang:zh_cn';
      else opts = opts.replace(/^lang:.*/m, 'lang:zh_cn');
      fs.writeFileSync(optFile, opts, 'utf-8');
    } catch (_) {}

    launcher = new Client();
    const maxMem = (cfg.maxMemory || 2048) + 'M';

    // JVM 启动优化参数：G1GC 调优，减少卡顿，加快启动
    const jvmArgs = [
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-Dfile.encoding=UTF-8',
      '-Djava.net.preferIPv4Stack=true'
    ];

    const opts = {
      authorization: {
        access_token: (cfg.authConfig && cfg.authConfig.accessToken) || '0',
        client_token: (cfg.authConfig && cfg.authConfig.clientToken) || ('xingtu-' + Date.now()),
        uuid: (cfg.authConfig && cfg.authConfig.uuid) || ('offline-' + (cfg.playerName || 'Steve')),
        name: cfg.playerName || 'Steve',
        user_properties: '{}'
      },
      root: gameDir,
      version: { number: verNum, type: 'release' },
      memory: { max: maxMem, min: '512M' },
      customLaunchArgs: ['--lang', 'zh_CN'],
      customArgs: jvmArgs,
      overrides: {
        downloads: 'https://bmclapi2.bangbang93.com',
        meta: 'https://bmclapi2.bangbang93.com'
      },
      downloadFileOptions: {
        timeout: 10000
      },
      eula: true
    };

    sendLog(`[星兔] 启动 ${verNum}，内存 ${maxMem}`);
    sendProgress({ total: 100, progress: 0 });
    cancelFlag = false;

    let dlCount = 0;
    let gameStarted = false;
    launcher.on('data', d => {
      if (cancelFlag) return;
      const line = d.toString();
      sendLog(line);
      // 只有当日志出现游戏窗口标题或 Java 进程启动时才认为游戏真正开始
      if (!gameStarted && (line.includes('Setting user') || line.includes('LWJGL'))) {
        gameStarted = true;
        mainWindow.webContents.send('game-started');
      }
    });
    launcher.on('debug', d => { if (!cancelFlag) sendLog('[debug] ' + d); });
    launcher.on('progress', p => {
      if (cancelFlag) return;
      if (p.task) {
        dlCount++;
        sendLog(`[下载] ${p.task} ${p.type || ''}`);
      }
      const total = p.total || 100;
      sendProgress({ total: total, progress: dlCount });
      // 下载完成后提示
      if (p.total && dlCount >= p.total && !gameStarted) {
        sendLog('[星兔] 资源下载完成，正在启动游戏...');
      }
    });
    launcher.on('close', code => {
      sendLog(`[星兔] 游戏退出，代码 ${code}`);
      launcher = null;
      resolve(code);
    });
    launcher.on('error', err => {
      sendLog('[星兔] 错误: ' + err.message);
      launcher = null;
      reject(err);
    });

    try {
      launcher.launch(opts);
    } catch (e) {
      sendLog('[星兔] 启动异常: ' + e.message);
      reject(e);
    }
  });
});

ipcMain.handle('cancel-download', () => {
  cancelFlag = true;
  if (launcher) {
    try { launcher.kill('SIGTERM'); } catch (_) {}
    try { if (launcher.abort) launcher.abort(); } catch (_) {}
    launcher = null;
  }
  sendLog('[星兔] 已取消下载');
  return true;
});

// ===== IPC：卸载版本 =====
ipcMain.handle('uninstall-version', (_e, versionId) => {
  const cfg = getCfg();
  const dir = path.join(cfg.gameDir, 'versions', versionId);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
});

// ===== IPC：Fabric / Forge 安装 =====
ipcMain.handle('install-fabric', async (_e, mcVersion, loaderVersion) => {
  const cfg = getCfg();
  const mirror = 'https://bmclapi2.bangbang93.com/fabric-meta';
  // 取最新稳定 loader（或用指定版本）
  const loaders = await httpGetJSON(`${mirror}/v2/versions/loader/${mcVersion}`);
  const loader = loaderVersion || loaders[0].loader.version;
  const profileJson = await httpGetJSON(`${mirror}/v2/versions/loader/${mcVersion}/${loader}/profile/json`);

  // 合并：优先读本地已安装的父版本 JSON，不用请求网络（避免限流）
  let parentJson = {};
  const parentLocal = path.join(cfg.gameDir, 'versions', mcVersion, mcVersion + '.json');
  if (fs.existsSync(parentLocal)) {
    try { parentJson = JSON.parse(fs.readFileSync(parentLocal, 'utf-8')); sendLog('[星兔] 已读取本地父版本JSON: ' + parentLocal); } catch (e) { sendLog('[星兔] 读本地父版本失败: ' + e.message); }
  } else {
    sendLog('[星兔] 本地无父版本JSON: ' + parentLocal + '，尝试网络下载');
  }
  if (!parentJson.downloads) {
    try {
      const manifest = await httpGetJSON('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json');
      const parentInfo = (manifest.versions || []).find(v => v.id === mcVersion);
      if (parentInfo) {
        parentJson = await httpGetJSON(parentInfo.url.replace('piston-meta.mojang.com', 'bmclapi2.bangbang93.com'));
        sendLog('[星兔] 已从网络获取父版本JSON');
      }
    } catch (e) {
      sendLog('[星兔] 警告：无法获取父版本JSON: ' + e.message);
    }
  }

  // 合并：父版本为基础，Fabric profile 覆盖
  const merged = { ...parentJson, ...profileJson };
  merged.id = `fabric-${mcVersion}-${loader}`;
  delete merged.inheritsFrom;

  // 合并 libraries（父版本 + Fabric），用 BMCLAPI maven 地址
  const parentLibs = Array.isArray(parentJson.libraries) ? parentJson.libraries : [];
  const fabricLibs = Array.isArray(profileJson.libraries) ? profileJson.libraries : [];
  const allLibs = [...parentLibs];
  for (const lib of fabricLibs) {
    if (!lib.downloads || !lib.downloads.artifact) {
      const parts = (lib.name || '').split(':');
      if (parts.length >= 3) {
        const group = parts[0].replace(/\./g, '/');
        const artifact = parts[1];
        const version = parts[2];
        const classifier = parts[3] ? '-' + parts[3] : '';
        const fileName = `${artifact}-${version}${classifier}.jar`;
        const relPath = `${group}/${artifact}/${version}/${fileName}`;
        // 用 BMCLAPI maven 地址，mclc 启动时自动下载
        lib.downloads = { artifact: { url: `https://bmclapi2.bangbang93.com/maven/${relPath}`, path: relPath, size: 0 } };
      }
    }
    allLibs.push(lib);
  }
  merged.libraries = allLibs;

  const id = merged.id;
  const dir = path.join(cfg.gameDir, 'versions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(merged, null, 2), 'utf-8');
  sendLog(`[星兔] Fabric 已安装: ${id}（共 ${allLibs.length} 个库）`);
  return id;
});

// 获取 Fabric Loader 版本列表
ipcMain.handle('get-fabric-loaders', async (_e, mcVersion) => {
  try {
    const loaders = await httpGetJSON(`https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${mcVersion}`);
    return loaders.map(l => ({ version: l.loader.version, stable: l.loader.stable }));
  } catch (e) {
    return [{ version: '0.20.1' }];
  }
});

// 另存为：下载安装包到用户指定位置
ipcMain.handle('save-installer-to', async (_e, mcVer, type, ver) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存安装包到...',
    defaultPath: `${type}-${mcVer}-${ver}.jar`,
    filters: [{ name: 'JAR', extensions: ['jar'] }]
  });
  if (!filePath) return null;
  let urls = [];
  if (type === 'forge') {
    const jarBase = `net/minecraftforge/forge/${mcVer}-${ver}/forge-${mcVer}-${ver}-installer.jar`;
    urls = [
      `https://mirrors.qlu.edu.cn/bmclapi/${jarBase}`,
      `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
      `https://maven.minecraftforge.net/${jarBase}`
    ];
  } else if (type === 'fabric') {
    urls = [
      `https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/${ver}/fabric-loader-${ver}.jar`,
      `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${ver}/fabric-loader-${ver}.jar`
    ];
  } else if (type === 'neoforge') {
    const jarBase = `net/neoforged/neoforge/${mcVer}-${ver}/neoforge-${mcVer}-${ver}-installer.jar`;
    urls = [
      `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
      `https://maven.neoforged.net/releases/${jarBase}`
    ];
  }
  for (const u of urls) {
    try {
      sendLog('[星兔] 下载: ' + u.replace('https://','').split('/')[0]);
      await httpDownload(u, filePath, 12000);
      sendLog('[星兔] ✅ 已保存: ' + filePath);
      return filePath;
    } catch (e) { sendLog('[星兔] 失败: ' + e.message); }
  }
  throw new Error('所有镜像都下载失败');
});

// 预下载所有加载器版本列表到本地缓存
ipcMain.handle('preload-loaders', async () => {
  const cfg = getCfg();
  const cacheDir = path.join(cfg.gameDir, '.xingtu-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  let count = 0;
  try {
    const loaders = await httpGetJSON('https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader');
    fs.writeFileSync(path.join(cacheDir, 'fabric-loaders.json'), JSON.stringify(loaders));
    count++;
    sendLog(`[星兔] 已缓存 Fabric loader 列表（${loaders.length} 个版本）`);
  } catch (e) { sendLog('[星兔] Fabric 列表缓存失败: ' + e.message); }
  try {
    const forge = await httpGetJSON('https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.json');
    fs.writeFileSync(path.join(cacheDir, 'forge-versions.json'), JSON.stringify(forge));
    count++;
    sendLog('[星兔] 已缓存 Forge 版本列表');
  } catch (e) { sendLog('[星兔] Forge 列表缓存失败: ' + e.message); }
  return `${count} 个加载器列表已缓存到 .xingtu-cache`;
});

// 下载单个文件到缓存目录
function downloadToCache(url, filename, cacheDir) {
  return new Promise((resolve, reject) => {
    const out = path.join(cacheDir, filename);
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) return resolve(out);
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        https.get(r.headers.location, r2 => {
          const chunks = [];
          r2.on('data', d => chunks.push(d));
          r2.on('end', () => { fs.writeFileSync(out, Buffer.concat(chunks)); resolve(out); });
        }).on('error', reject);
      } else {
        const chunks = [];
        r.on('data', d => chunks.push(d));
        r.on('end', () => { fs.writeFileSync(out, Buffer.concat(chunks)); resolve(out); });
      }
    }).on('error', reject);
  });
}

// 预下载所有加载器安装包到本地
ipcMain.handle('preload-all-installers', async () => {
  const cfg = getCfg();
  const cacheDir = path.join(cfg.gameDir, '.xingtu-cache', 'installers');
  fs.mkdirSync(cacheDir, { recursive: true });
  let done = 0, fail = 0;
  // Fabric loader
  try {
    await downloadToCache('https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar', 'fabric-loader-0.20.1.jar', cacheDir);
    sendLog('[星兔] ✅ Fabric loader 已缓存'); done++;
  } catch (e) { sendLog('[星兔] ❌ Fabric: ' + e.message); fail++; }
  // Forge 1.20.1
  try {
    await downloadToCache('https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar', 'forge-installer.jar', cacheDir);
    sendLog('[星兔] ✅ Forge installer 已缓存'); done++;
  } catch (e) { sendLog('[星兔] ❌ Forge: ' + e.message); fail++; }
  return `完成 ${done} 个，失败 ${fail} 个，缓存在 .xingtu-cache/installers`;
});

// ===== 加载器本地缓存（SHA1 校验 + 断点续传 + 去重）=====
function loaderCacheDir() { return path.join(app.getPath('userData'), 'cache', 'loader'); }

function getFileSha1(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(p);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// 带断点续传的缓存下载：已存在且校验通过直接返回；不完整则带 Range 续传
async function downloadToCacheResume(url, dest, expectedSha1) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 已存在：先校验大小+SHA1
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    if (!expectedSha1) return dest;
    try {
      const real = await getFileSha1(dest);
      if (real.toLowerCase() === expectedSha1.toLowerCase()) {
        sendLog('[缓存] 命中本地: ' + path.basename(dest));
        return dest;
      }
      sendLog('[缓存] SHA1 不匹配，重新下载: ' + path.basename(dest));
      fs.unlinkSync(dest);
    } catch (_) {}
  }
  // 续传：若残留文件 >0，带 Range；网络请求进全局并发池
  let startBytes = 0;
  if (fs.existsSync(dest)) startBytes = fs.statSync(dest).size;
  await poolRun(() => new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? require('http') : https;
    const headers = { 'User-Agent': 'XingTuLauncher/1.0' };
    if (startBytes > 0) headers['Range'] = 'bytes=' + startBytes + '-';
    const out = fs.createWriteStream(dest, { flags: startBytes > 0 ? 'a' : 'w' });
    const req = lib.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return resolve(downloadToCacheResume(new URL(res.headers.location, url).href, dest, expectedSha1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        out.close(); res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
    });
    req.on('error', e => { try { out.close(); } catch (_) {} reject(e); });
    req.setTimeout(300000, () => req.destroy(new Error('下载超时(5分钟)')));
  }));
  if (expectedSha1) {
    const real = await getFileSha1(dest);
    if (real.toLowerCase() !== expectedSha1.toLowerCase()) {
      try { fs.unlinkSync(dest); } catch (_) {}
      throw new Error('SHA1 校验失败，已删除: ' + path.basename(dest));
    }
  }
  return dest;
}

// 列出已缓存的加载器
ipcMain.handle('get-loader-cache', () => {
  const dir = loaderCacheDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { name: f, size: st.size };
  });
});

// 预下载四个加载器到本地（Fabric / Forge / NeoForge / OptiFine）
ipcMain.handle('preload-loader-cache', async (_e, mcVersion) => {
  const dir = loaderCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const results = [];

  // 通用下载 + 大小校验：小于 minSize KB 判定为失败（防止下到 HTML 跳转页）
  async function tryDownload(job) {
    const dest = path.join(dir, job.name);
    // 已存在且大小合理，直接跳过
    if (fs.existsSync(dest)) {
      const sz = fs.statSync(dest).size;
      if (sz >= (job.minSizeKB || 100) * 1024) {
        const kb = Math.round(sz / 1024);
        sendLog('[缓存] ⏭️ ' + job.key + ' 已存在 (' + kb + ' KB)，跳过');
        return { key: job.key, ok: true, size: kb + ' KB', file: job.name, cached: true };
      }
      try { fs.unlinkSync(dest); } catch (_) {}
    }
    const urls = Array.isArray(job.url) ? job.url : [job.url];
    let lastErr = null;
    for (const u of urls) {
      try {
        sendLog('[缓存] 下载 ' + job.key + ' ← ' + u.replace('https://', '').split('/')[0]);
        await downloadToCacheResume(u, dest, null);
        const sz = fs.statSync(dest).size;
        if (sz < (job.minSizeKB || 100) * 1024) {
          try { fs.unlinkSync(dest); } catch (_) {}
          throw new Error('文件太小(' + Math.round(sz / 1024) + 'KB)，可能是 HTML 错误页');
        }
        const kb = Math.round(sz / 1024);
        sendLog('[缓存] ✅ ' + job.key + ' 完成 (' + kb + ' KB)');
        return { key: job.key, ok: true, size: kb + ' KB', file: job.name };
      } catch (e) {
        lastErr = e;
        sendLog('[缓存] ↩️ 该镜像失败: ' + e.message);
      }
    }
    throw lastErr || new Error('所有镜像都失败');
  }

  // 1. Fabric loader（BMCLAPI，~1MB）
  try {
    results.push(await tryDownload({
      key: 'fabric',
      name: `fabric-loader-0.16.5.jar`,
      url: [
        'https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar',
        'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar'
      ],
      minSizeKB: 500
    }));
  } catch (e) {
    results.push({ key: 'fabric', ok: false, err: e.message });
    sendLog('[缓存] ❌ fabric: ' + e.message);
  }

  // 2. Forge（多镜像 fallback）
  try {
    const builds = await httpGetJSON(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`);
    if (!Array.isArray(builds) || !builds.length) throw new Error('BMCLAPI 没返回该版本的 Forge');
    builds.sort((a, b) => (a.build || 0) - (b.build || 0));
    const latest = builds[builds.length - 1];
    const fullVer = `${mcVersion}-${latest.version}`;
    const jarBase = `net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
    results.push(await tryDownload({
      key: 'forge',
      name: `forge-${fullVer}-installer.jar`,
      url: [
        `https://mirrors.qlu.edu.cn/bmclapi/${jarBase}`,
        `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
        `https://maven.minecraftforge.net/${jarBase}`
      ],
      minSizeKB: 3000  // Forge installer 一般 5~50MB
    }));
  } catch (e) {
    results.push({ key: 'forge', ok: false, err: e.message });
    sendLog('[缓存] ❌ forge: ' + e.message);
  }

  // 3. NeoForge（1.20.1+，用官方 API 取对应 MC 版本的最新版本）
  try {
    const neoVersions = ['1.20.1', '1.20.2', '1.20.4', '1.20.6', '1.21', '1.21.1', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7', '1.21.8', '1.21.9'];
    if (!neoVersions.includes(mcVersion)) {
      results.push({ key: 'neoforge', ok: false, err: '该 MC 版本无 NeoForge（支持: ' + neoVersions.slice(0, 5).join('/') + ' 等）' });
    } else {
      // 从 BMCLAPI 找对应 MC 版本的最新 build（api.neoforged.net 国内被墙）
      let neoBuild = '';
      try {
        const arr = await httpGetJSON(`https://bmclapi2.bangbang93.com/neoforge/minecraft/${mcVersion}`);
        if (Array.isArray(arr) && arr.length) {
          arr.sort(versionCmp);
          neoBuild = arr[arr.length - 1];
        }
      } catch (e) { sendLog('[缓存] NeoForge 元数据获取失败: ' + e.message); }
      if (!neoBuild) throw new Error('未找到 ' + mcVersion + ' 的 NeoForge 版本');
      const neoVer = neoBuild;
      const jarBase = `net/neoforged/neoforge/${neoVer}/neoforge-${neoVer}-installer.jar`;
      results.push(await tryDownload({
        key: 'neoforge',
        name: `neoforge-${neoVer}-installer.jar`,
        url: [
          `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
          `https://maven.neoforged.net/releases/${jarBase}`
        ],
        minSizeKB: 2000
      }));
    }
  } catch (e) {
    results.push({ key: 'neoforge', ok: false, err: e.message });
    sendLog('[缓存] ❌ neoforge: ' + e.message);
  }

  // 4. OptiFine（官网有广告栅栏，无法直接脚本下载，返回手动提示）
  results.push({
    key: 'optifine',
    ok: false,
    manual: true,
    err: 'OptiFine 官网有广告页无法直接下载，请手动到 optifine.net 下载后放到 cache/loader 文件夹',
    url: 'https://optifine.net/downloads'
  });
  sendLog('[缓存] ℹ️ optifine: 需手动到 optifine.net/downloads 下载');

  return results;
});

// 清空加载器缓存
ipcMain.handle('clear-loader-cache', () => {
  const dir = loaderCacheDir();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });
  return true;
});

// ===== 全版本元数据 + 热门安装包批量预下载 =====
const POPULAR_MC_VERSIONS = ['1.7.10', '1.12.2', '1.16.5', '1.18.2', '1.19.2', '1.19.4', '1.20.1', '1.20.4', '1.20.6', '1.21', '1.21.1', '1.21.4', '1.21.9'];

// 缓存全版本元数据（Fabric/Forge/NeoForge 的版本列表 JSON，很小）
ipcMain.handle('preload-all-loader-metadata', async () => {
  const dir = loaderCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  let done = 0, fail = 0;
  // Fabric 全 loader 列表
  try {
    let data;
    try {
      data = await httpGetJSON('https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader');
    } catch (e1) {
      sendLog('[缓存] BMCLAPI Fabric 失败，尝试官方源: ' + e1.message);
      data = await httpGetJSON('https://meta.fabricmc.net/v2/versions/loader');
    }
    if (!Array.isArray(data) || !data.length) throw new Error('Fabric 列表为空');
    fs.writeFileSync(path.join(dir, '_meta-fabric-loaders.json'), JSON.stringify(data));
    sendLog('[缓存] ✅ Fabric loader 全列表 (' + data.length + ' 个)');
    done++;
  } catch (e) { sendLog('[缓存] ❌ Fabric 列表: ' + e.message); fail++; }
  // Forge 全版本（按 MC 版本聚合）
  try {
    const data = await httpGetJSON('https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.json');
    fs.writeFileSync(path.join(dir, '_meta-forge-maven.json'), JSON.stringify(data));
    sendLog('[缓存] ✅ Forge maven 元数据');
    done++;
  } catch (e) { sendLog('[缓存] ❌ Forge maven: ' + e.message); fail++; }
  // NeoForge 全版本（官方超时就用 BMCLAPI 镜像）
  try {
    let data;
    try {
      data = await httpGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    } catch (e1) {
      sendLog('[缓存] NeoForge 官方超时，尝试 BMCLAPI: ' + e1.message);
      data = await httpGet('https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml');
    }
    fs.writeFileSync(path.join(dir, '_meta-neoforge-maven.xml'), data);
    sendLog('[缓存] ✅ NeoForge maven 元数据');
    done++;
  } catch (e) { sendLog('[缓存] ❌ NeoForge maven: ' + e.message); fail++; }
  return { done, fail };
});

// 批量下载热门 MC 版本的安装包
ipcMain.handle('preload-popular-installers', async (_e, opts) => {
  const dir = loaderCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const cfg = getCfg();
  // 并发数：用户可配置，默认 5，范围 1~32
  const concurrency = Math.max(1, Math.min(32, (opts && opts.concurrency) || cfg.dlConcurrency || 5));
  const summary = { fabric: 0, forge: 0, neoforge: 0, skipped: 0, failed: 0 };

  // 一次性扫描整个缓存目录，建立 文件名→大小 的 Map，避免逐个 stat
  const cacheMap = new Map();
  try {
    for (const f of fs.readdirSync(dir)) {
      try { cacheMap.set(f, fs.statSync(path.join(dir, f)).size); } catch (_) {}
    }
  } catch (_) {}
  sendLog('[缓存] 扫描到 ' + cacheMap.size + ' 个已缓存文件');

  // 单个文件下载
  async function dl(job) {
    // 直接查 Map，不碰磁盘
    const existingSize = cacheMap.get(job.name);
    if (existingSize && existingSize >= job.minKB * 1024) {
      summary.skipped++;
      sendLog('[缓存] ⏭️ ' + job.name + ' 已存在 (' + Math.round(existingSize/1024) + 'KB)');
      if (job.key === 'fabric') summary.fabric = 1;
      else summary[job.key]++;
      return;
    }
    const dest = path.join(dir, job.name);
    for (const u of job.urls) {
      try {
        sendLog('[缓存] ⬇ ' + job.name);
        await downloadToCacheResume(u, dest, null);
        const sz = fs.statSync(dest).size;
        if (sz < job.minKB * 1024) { try { fs.unlinkSync(dest); } catch (_) {} throw new Error('太小 ' + Math.round(sz/1024) + 'KB'); }
        cacheMap.set(job.name, sz); // 下载完更新 Map
        sendLog('[缓存] ✅ ' + job.name + ' (' + Math.round(sz/1024) + 'KB)');
        if (job.key === 'fabric') summary.fabric = 1;
        else summary[job.key]++;
        return;
      } catch (e) { sendLog('[缓存] ↩️ ' + u.replace('https://','').split('/')[0] + ' 失败: ' + e.message); }
    }
    summary.failed++;
  }

  const jobs = [];

  // 1. Fabric loader
  try {
    sendLog('[缓存] 获取 Fabric 最新稳定版...');
    let loaders = [];
    try {
      loaders = await httpGetJSON('https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader');
    } catch (e1) {
      sendLog('[缓存] BMCLAPI Fabric 列表失败，尝试官方源: ' + e1.message);
      loaders = await httpGetJSON('https://meta.fabricmc.net/v2/versions/loader');
    }
    if (!Array.isArray(loaders) || !loaders.length) throw new Error('Fabric 版本列表为空');
    const stable = loaders.find(l => l && l.loader && l.loader.stable) || loaders[0];
    const lv = (stable && stable.loader && stable.loader.version) || '0.16.5';
    jobs.push({
      key: 'fabric', name: `fabric-loader-${lv}.jar`, minKB: 500,
      urls: [
        `https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/${lv}/fabric-loader-${lv}.jar`,
        `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${lv}/fabric-loader-${lv}.jar`
      ]
    });
  } catch (e) { sendLog('[缓存] Fabric 列表失败: ' + e.message); }

  // 2. 并发查所有 MC 版本的 Forge 最新 build
  sendLog('[缓存] 并发查询 ' + POPULAR_MC_VERSIONS.length + ' 个 MC 版本的 Forge 列表...');
  await Promise.all(POPULAR_MC_VERSIONS.map(async mcVer => {
    try {
      const builds = await httpGetJSON(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVer}`);
      if (Array.isArray(builds) && builds.length) {
        builds.sort((a, b) => (a.build || 0) - (b.build || 0));
        const latest = builds[builds.length - 1];
        const fullVer = `${mcVer}-${latest.version}`;
        const jarBase = `net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
        jobs.push({
          key: 'forge', name: `forge-${fullVer}-installer.jar`, minKB: 3000,
          urls: [
            `https://mirrors.qlu.edu.cn/bmclapi/${jarBase}`,
            `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
            `https://maven.minecraftforge.net/${jarBase}`
          ]
        });
      }
    } catch (_) {}
  }));

  // 3. NeoForge 元数据（用 BMCLAPI 按 MC 版本取最新版，绕开 api.neoforged.net 污染）
  try {
    for (const mcVer of POPULAR_MC_VERSIONS) {
      try {
        const arr = await httpGetJSON(`https://bmclapi2.bangbang93.com/neoforge/minecraft/${mcVer}`);
        if (Array.isArray(arr) && arr.length) {
          arr.sort(versionCmp);
          const ver = arr[arr.length - 1];
          const jarBase = `net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
          jobs.push({
            key: 'neoforge', name: `neoforge-${ver}-installer.jar`, minKB: 2000,
            urls: [
              `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
              `https://maven.neoforged.net/releases/${jarBase}`
            ]
          });
        }
      } catch (e) { /* 该版本无 NeoForge 就跳过 */ }
    }
  } catch (e) { sendLog('[缓存] NeoForge 元数据失败: ' + e.message); }

  // 4. 并发池：最多同时跑 concurrency 个下载
  sendLog('[缓存] 共 ' + jobs.length + ' 个任务，' + concurrency + ' 路并发下载中...');
  let idx = 0;
  let doneCount = 0;
  const total = jobs.length;
  // 立即发一次进度（0%）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preload-progress', { done: 0, total, percent: 0, current: '' });
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, jobs.length); i++) {
    workers.push((async () => {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        await dl(job);
        doneCount++;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('preload-progress', {
            done: doneCount, total,
            percent: Math.round(doneCount / total * 100),
            current: job.name
          });
        }
      }
    })());
  }
  await Promise.all(workers);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preload-progress', { done: total, total, percent: 100, current: '完成' });
  }
  sendLog('[缓存] 🎉 全部任务结束');
  return summary;
});

// 列出本地已缓存的安装包（按 loader 类型分组）
ipcMain.handle('get-cached-installers', () => {
  const dir = loaderCacheDir();
  if (!fs.existsSync(dir)) return { fabric: [], forge: [], neoforge: [], meta: [] };
  const out = { fabric: [], forge: [], neoforge: [], meta: [] };
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    const sz = Math.round(fs.statSync(p).size / 1024);
    if (f.startsWith('_meta-')) { out.meta.push({ name: f, size: sz }); continue; }
    if (f.startsWith('fabric-')) out.fabric.push({ name: f, size: sz });
    else if (f.startsWith('forge-')) out.forge.push({ name: f, size: sz });
    else if (f.startsWith('neoforge-')) out.neoforge.push({ name: f, size: sz });
  }
  return out;
});

// 在缓存里找指定 MC 版本的安装包
ipcMain.handle('find-cached-installer', (_e, { loader, mcVersion }) => {
  const dir = loaderCacheDir();
  if (!fs.existsSync(dir)) return null;
  const prefix = loader === 'forge' ? 'forge-' : loader === 'neoforge' ? 'neoforge-' : 'fabric-';
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    if (loader === 'fabric') return path.join(dir, f); // fabric 只有一个 jar
    if (f.includes(mcVersion)) return path.join(dir, f);
  }
  return null;
});

// NeoForge 安装（复用 Forge 逻辑，NeoForge 地址不同）
ipcMain.handle('install-neoforge', async (_e, mcVersion) => {
  sendLog('[星兔] NeoForge 安装功能开发中，暂时请用 Forge');
  throw new Error('NeoForge 暂未接入，请用 Forge');
});

// OptiFine 安装
// 获取指定 MC 版本的 OptiFine 版本列表（BMCLAPI 镜像）
ipcMain.handle('get-optifine-versions', async (_e, mcVersion) => {
  if (!mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) return [];
  try {
    // BMCLAPI 正确接口：/optifine/{mcVersion} 直接返回该版本的列表（字段是 mcversion）
    const all = await httpGetJSON(`https://bmclapi2.bangbang93.com/optifine/${mcVersion}`);
    if (!Array.isArray(all)) return [];
    return all.filter(o => (o.mcversion || o.mcVersion) === mcVersion);
  } catch (e) {
    sendLog('[星兔] 获取 OptiFine 列表失败: ' + e.message);
    return [];
  }
});

// 安装指定版本的 OptiFine
ipcMain.handle('install-optifine-version', async (_e, mcVersion, type, patch) => {
  if (!mcVersion || !type || !patch) throw new Error('参数不全');
  const optiVer = `${mcVersion}_${type}_${patch}`;
  sendLog('[星兔] 安装 OptiFine: ' + optiVer);
  const cfg = getCfg();
  const tmpDir = app.getPath('userData');
  const finalJar = path.join(tmpDir, `optifine-${optiVer}.jar`);
  // 多个镜像（BMCLAPI 标准 OptiFine maven 路径）
  const urls = [
    `https://bmclapi2.bangbang93.com/maven/com/optifine/${mcVersion}/OptiFine_${mcVersion}_${type}_${patch}.jar`,
    `https://optifine.net/adloadx?f=OptiFine_${optiVer}.jar`
  ];
  let downloaded = false;
  for (const u of urls) {
    const tmpJar = path.join(tmpDir, `optifine-dl.jar`);
    try {
      sendLog('[星兔] 下载: ' + u.replace('https://','').split('/')[0]);
      await httpDownload(u, tmpJar, 12000);
      const sz = fs.statSync(tmpJar).size;
      if (sz < 100000) throw new Error('文件太小(' + sz + '字节)，可能是广告页');
      fs.renameSync(tmpJar, finalJar);
      downloaded = true;
      sendLog('[星兔] ✅ 下载成功 ' + Math.round(sz/1024) + 'KB');
      break;
    } catch (e) {
      sendLog('[星兔] 下载失败: ' + e.message);
      try { fs.unlinkSync(tmpJar); } catch (_) {}
    }
  }
  if (!downloaded) throw new Error('OptiFine 下载失败，BMCLAPI 可能没有此版本');

  // 用 Java 运行安装器
  const javas = findJavaCandidates();
  if (!javas.length) throw new Error('找不到 Java');
  for (const java of javas) {
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(java, ['-jar', finalJar, '--installClient'], { cwd: cfg.gameDir });
        p.stdout.on('data', d => sendLog('  ' + d.toString().trimEnd()));
        p.stderr.on('data', d => sendLog('  ! ' + d.toString().trimEnd()));
        p.on('close', code => code === 0 ? resolve() : reject(new Error('退出码 ' + code)));
      });
      break;
    } catch (e) { sendLog('[星兔] Java 失败: ' + e.message); }
  }
  sendLog('[星兔] ✅ OptiFine 安装完成: ' + optiVer);
  return optiVer;
});

// 自动查找可用的 java（优先 MC 自带运行时，因为 1.20.1 需要 Java 17）
function findJavaCandidates() {
  const candidates = [];
  const seen = new Set();
  const push = p => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); candidates.push(p); } };

  // 1. MC 自带运行时（刚启动过原版 1.20.1，一定带了 java-runtime-gamma = Java 17）
  const runtimeBases = [
    path.join(getCfg().gameDir, 'runtime'),
    path.join(os.homedir(), '.minecraft', 'runtime')
  ];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (_) { continue; }
      if (!isDir) continue;
      const bin = path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(bin)) push(bin);
      else walk(p, depth + 1);
    }
  };
  runtimeBases.forEach(b => { if (fs.existsSync(b)) walk(b, 0); });

  // 2. 系统常见 Java 安装目录
  const sysBases = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    process.env.LOCALAPPDATA + '\\Programs\\Java',
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines'
  ];
  for (const base of sysBases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const dir of fs.readdirSync(base)) {
        const c = path.join(base, dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        push(c);
      }
    } catch (_) {}
  }

  // 3. PATH 里的 java
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = require('child_process').spawnSync(cmd, ['java'], { shell: true });
    r.stdout.toString().split(/\r?\n/).forEach(l => { if (l.trim()) push(l.trim()); });
  } catch (_) {}

  return candidates;
}

ipcMain.handle('install-forge', async (_e, mcVersion) => {
  try {
  // 校验版本号格式：必须是 1.x 或 1.x.y（防 26.2 这种脏值把主进程卡死）
  if (!mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) {
    throw new Error('版本号无效: "' + mcVersion + '"，请先在下拉框选一个原版 MC 版本（如 1.20.1），不要选预览版/活动版');
  }
  const cfg = getCfg();
  // BMCLAPI 专用接口：按 MC 版本返回所有 Forge build
  let forgeBuilds = [];
  try {
    forgeBuilds = await httpGetJSON(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`);
  } catch (e) {
    sendLog('[星兔] 获取 Forge 列表失败: ' + e.message);
  }
  if (!Array.isArray(forgeBuilds) || !forgeBuilds.length) {
    throw new Error('未找到适用于 ' + mcVersion + ' 的 Forge');
  }
  // 按 build 号排序，取最新稳定版
  forgeBuilds.sort((a, b) => (a.build || 0) - (b.build || 0));
  const latest = forgeBuilds[forgeBuilds.length - 1];
  const forgeVer = latest.version;          // 例如 47.4.28
  const fullVer = `${mcVersion}-${forgeVer}`; // 例如 1.20.1-47.4.28
  sendLog('[星兔] 选定 Forge 版本: ' + fullVer);

  // 优先用本地缓存的安装包
  const tmpDir = app.getPath('userData');
  const finalJar = path.join(tmpDir, `forge-installer-${fullVer}.jar`);
  const cachedJar = path.join(loaderCacheDir(), `forge-${fullVer}-installer.jar`);
  let downloaded = false;
  if (fs.existsSync(cachedJar) && fs.statSync(cachedJar).size > 100000) {
    sendLog('[星兔] ✅ 命中本地缓存: ' + cachedJar);
    fs.copyFileSync(cachedJar, finalJar);
    downloaded = true;
  }

  // 多个镜像源，按顺序尝试
  const jarBase = `net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
  const mirrorUrls = [
    `https://mirrors.qlu.edu.cn/bmclapi/${jarBase}`,
    `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
    `https://maven.minecraftforge.net/${jarBase}`
  ];
  let lastDlErr = null;
  let attempt = 0;
  for (const u of mirrorUrls) {
    if (downloaded) break;
    attempt++;
    const tmpJar = path.join(tmpDir, `forge-installer-${fullVer}-a${attempt}.jar`);
    sendLog(`[星兔] 尝试下载(${u.includes('bangbang93') ? 'BMCLAPI' : '官方源'})…`);
    try {
      await httpDownload(u, tmpJar, 12000);
      const sz = fs.statSync(tmpJar).size;
      if (sz < 100000) throw new Error('文件太小(' + sz + '字节)');
      sendLog(`[星兔] ✅ 下载成功，${Math.round(sz / 1024)} KB`);
      try { fs.unlinkSync(finalJar); } catch (_) {}
      fs.renameSync(tmpJar, finalJar);
      downloaded = true;
      // 顺手存入缓存，下次免下载
      try { fs.copyFileSync(finalJar, cachedJar); } catch (_) {}
    } catch (e) {
      lastDlErr = e;
      sendLog(`[星兔] 失败: ${e.message}`);
      try { fs.unlinkSync(tmpJar); } catch (_) {}
    }
  }
  if (!downloaded) {
    const dlUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
    sendLog('[星兔] 自动下载全部失败');
    sendLog('[星兔] 正在打开浏览器下载页面，请下载后在弹出的文件框中选择…');
    // 自动打开浏览器下载
    try { shell.openExternal(dlUrl); } catch (_) {}
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载好的 forge-' + fullVer + '-installer.jar',
      properties: ['openFile'],
      filters: [{ name: 'Forge Installer JAR', extensions: ['jar'] }]
    });
    if (r.canceled) throw new Error('已取消：未选择 Forge installer 文件');
    const chosen = r.filePaths[0];
    fs.copyFileSync(chosen, finalJar);
    sendLog('[星兔] 已使用本地文件: ' + chosen);
  }
  const tmpJar = finalJar;

  const javas = findJavaCandidates();
  sendLog('[星兔] 找到 ' + javas.length + ' 个 Java:');
  javas.forEach((j, i) => sendLog('   [' + i + '] ' + j));
  if (!javas.length) {
    throw new Error('找不到 Java！请先在启动器里正常启动一次原版 ' + mcVersion + '，让它自动下载 Java 运行时，再回来装 Forge。');
  }

  // 记录安装前已有的版本目录，用来判断 Forge 是否真的写进去了
  const before = new Set(scanInstalledVersions(cfg.gameDir));

  let lastErr = null;
  for (const java of javas) {
    sendLog('[星兔] >>> 尝试用 Java: ' + java);
    try {
      await new Promise((resolve, reject) => {
        // 注意：用 java.exe（控制台版）而不是 javaw.exe，否则抓不到任何输出
        const p = spawn(java, ['-jar', tmpJar, '--installClient'], { cwd: cfg.gameDir });
        p.stdout.on('data', d => sendLog('  ' + d.toString().trimEnd()));
        p.stderr.on('data', d => sendLog('  ! ' + d.toString().trimEnd()));
        p.on('error', err => reject(new Error('无法启动 Java 进程: ' + err.message)));
        p.on('close', code => code === 0 ? resolve() : reject(new Error('安装进程退出码 ' + code)));
      });
      lastErr = null;
      sendLog('[星兔] 安装进程正常结束');
      break;
    } catch (e) {
      lastErr = e;
      sendLog('[星兔] 这个 Java 失败: ' + e.message + '，换下一个');
    }
  }
  if (lastErr) throw new Error('所有 Java 都失败了，最后错误: ' + lastErr.message);

  // 验证
  const after = scanInstalledVersions(cfg.gameDir);
  const newOnes = after.filter(v => !before.has(v));
  sendLog('[星兔] 安装后版本列表: ' + after.join(', '));
  if (newOnes.length) {
    sendLog('[星兔] ✅ Forge 安装成功，新目录: ' + newOnes.join(', '));
  } else {
    sendLog('[星兔] ⚠️ 安装进程返回 0，但 versions 目录里没看到新 Forge 文件夹，可能装到默认 .minecraft 了');
  }
  return fullVer;
  } catch (e) {
    sendLog('[星兔] ❌ install-forge 异常: ' + e.message);
    throw e;
  }
});

// 获取指定 MC 版本的所有 Forge build 列表
ipcMain.handle('get-forge-builds', async (_e, mcVersion) => {
  if (!mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) return [];
  try {
    const builds = await httpGetJSON(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`);
    if (!Array.isArray(builds)) return [];
    return builds.sort((a, b) => (a.build || 0) - (b.build || 0)).map(b => ({ version: b.version, build: b.build }));
  } catch (e) {
    sendLog('[星兔] 获取 Forge 列表失败: ' + e.message);
    return [];
  }
});

// 获取指定 MC 版本的 NeoForge 版本列表
// 版本号比较（数字分段）
function versionCmp(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

ipcMain.handle('get-neoforge-builds', async (_e, mcVersion) => {
  if (!mcVersion) return [];
  try {
    // 从 BMCLAPI maven 仓库获取 NeoForge 版本列表
    // maven-metadata.xml 包含所有版本号，需按 MC 版本前缀过滤
    const xml = await httpGet('https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml');
    const text = xml.toString('utf-8');
    const allVersions = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(text)) !== null) allVersions.push(m[1]);

    // 根据 MC 版本号推断 NeoForge 版本前缀
    // MC "26.3" → NeoForge "26.3.x"
    // MC "1.21.4" → NeoForge "21.4.x"（去掉 "1." 前缀）
    let prefix;
    if (mcVersion.startsWith('1.')) {
      // 1.21.4 → 21.4
      const parts = mcVersion.split('.');
      prefix = parts[1] + '.' + (parts[2] || '');
    } else {
      const parts = mcVersion.split('.');
      prefix = parts[0] + '.' + (parts[1] || '');
    }

    // 过滤：以前缀开头，且是正式版（不含 beta/alpha/preview/snapshot/rc）
    const versions = allVersions.filter(v => {
      if (!v.startsWith(prefix + '.')) return false;
      if (/beta|alpha|preview|snapshot|rc|pre/i.test(v)) return false;
      return true;
    });

    versions.sort((a, b) => versionCmp(a, b));
    sendLog('[星兔] NeoForge 找到 ' + versions.length + ' 个版本 for MC ' + mcVersion + ' (前缀 ' + prefix + ')');
    return versions;
  } catch (e) {
    sendLog('[星兔] 获取 NeoForge 列表失败: ' + e.message);
    return [];
  }
});

// 安装指定版本的 Forge（带版本号）
ipcMain.handle('install-forge-version', async (_e, mcVersion, forgeVer) => {
  // 复用 install-forge 的完整逻辑，但强制使用指定版本
  if (!mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) throw new Error('MC 版本号无效');
  if (!forgeVer || !/^[\d.]+$/.test(forgeVer)) throw new Error('Forge 版本号无效');
  const fullVer = `${mcVersion}-${forgeVer}`;
  sendLog('[星兔] 安装指定 Forge: ' + fullVer);

  const cfg = getCfg();
  const tmpDir = app.getPath('userData');
  const finalJar = path.join(tmpDir, `forge-installer-${fullVer}.jar`);
  const cachedJar = path.join(loaderCacheDir(), `forge-${fullVer}-installer.jar`);
  let downloaded = false;
  if (fs.existsSync(cachedJar) && fs.statSync(cachedJar).size > 100000) {
    sendLog('[星兔] ✅ 命中本地缓存: ' + cachedJar);
    fs.copyFileSync(cachedJar, finalJar);
    downloaded = true;
  }
  const jarBase = `net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
  const mirrorUrls = [
    `https://mirrors.qlu.edu.cn/bmclapi/${jarBase}`,
    `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
    `https://maven.minecraftforge.net/${jarBase}`
  ];
  let attempt = 0;
  for (const u of mirrorUrls) {
    if (downloaded) break;
    attempt++;
    const tmpJar = path.join(tmpDir, `forge-installer-${fullVer}-a${attempt}.jar`);
    sendLog(`[星兔] 下载: ${u.replace('https://','').split('/')[0]}`);
    try {
      await httpDownload(u, tmpJar, 12000);
      const sz = fs.statSync(tmpJar).size;
      if (sz < 100000) throw new Error('文件太小(' + sz + '字节)');
      sendLog(`[星兔] ✅ 下载成功，${Math.round(sz / 1024)} KB`);
      try { fs.unlinkSync(finalJar); } catch (_) {}
      fs.renameSync(tmpJar, finalJar);
      downloaded = true;
      try { fs.copyFileSync(finalJar, cachedJar); } catch (_) {}
    } catch (e) {
      sendLog(`[星兔] 失败: ${e.message}`);
      try { fs.unlinkSync(tmpJar); } catch (_) {}
    }
  }
  if (!downloaded) throw new Error('下载失败，请检查网络');

  const javas = findJavaCandidates();
  if (!javas.length) throw new Error('找不到 Java，请先启动一次原版游戏');
  const before = new Set(scanInstalledVersions(cfg.gameDir));
  for (const java of javas) {
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(java, ['-jar', finalJar, '--installClient'], { cwd: cfg.gameDir });
        p.stdout.on('data', d => sendLog('  ' + d.toString().trimEnd()));
        p.stderr.on('data', d => sendLog('  ! ' + d.toString().trimEnd()));
        p.on('error', err => reject(new Error('无法启动 Java: ' + err.message)));
        p.on('close', code => code === 0 ? resolve() : reject(new Error('退出码 ' + code)));
      });
      break;
    } catch (e) {
      sendLog('[星兔] Java 失败: ' + e.message);
    }
  }
  const after = scanInstalledVersions(cfg.gameDir);
  const newOnes = after.filter(v => !before.has(v));
  sendLog('[星兔] ✅ 安装完成: ' + (newOnes.join(', ') || fullVer));
  return fullVer;
});

// 安装指定版本的 NeoForge
ipcMain.handle('install-neoforge-version', async (_e, mcVersion, neoVer) => {
  if (!mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) throw new Error('MC 版本号无效');
  // neoVer 形如 "47.1.0" / "21.1.0"（新版独立编号，不带 MC 前缀）
  const ver = String(neoVer);
  sendLog('[星兔] 安装 NeoForge: ' + ver + ' (MC ' + mcVersion + ')');
  const cfg = getCfg();
  const tmpDir = app.getPath('userData');
  const finalJar = path.join(tmpDir, `neoforge-installer-${ver}.jar`);
  const jarBase = `net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
  const mirrorUrls = [
    `https://bmclapi2.bangbang93.com/maven/${jarBase}`,
    `https://maven.neoforged.net/releases/${jarBase}`
  ];
  let downloaded = false;
  for (const u of mirrorUrls) {
    const tmpJar = path.join(tmpDir, `neoforge-installer-${ver}.jar`);
    try {
      await httpDownload(u, tmpJar, 12000);
      const sz = fs.statSync(tmpJar).size;
      if (sz < 100000) throw new Error('文件太小');
      fs.renameSync(tmpJar, finalJar);
      downloaded = true;
      break;
    } catch (e) { sendLog('[星兔] 下载失败: ' + e.message); }
  }
  if (!downloaded) throw new Error('NeoForge 下载失败');
  const javas = findJavaCandidates();
  if (!javas.length) throw new Error('找不到 Java');
  const before = new Set(scanInstalledVersions(cfg.gameDir));
  for (const java of javas) {
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(java, ['-jar', finalJar, '--installClient'], { cwd: cfg.gameDir });
        p.stdout.on('data', d => sendLog('  ' + d.toString().trimEnd()));
        p.stderr.on('data', d => sendLog('  ! ' + d.toString().trimEnd()));
        p.on('close', code => code === 0 ? resolve() : reject(new Error('退出码 ' + code)));
      });
      break;
    } catch (e) { sendLog('[星兔] Java 失败: ' + e.message); }
  }
  return ver;
});

// ===== IPC：Mod 管理 =====
function modsDir() { return path.join(getCfg().gameDir, 'mods'); }
function rpDir() { return path.join(getCfg().gameDir, 'resourcepacks'); }

// 从 JAR 里读 mod 名称和版本
function readModInfo(jarPath) {
  try {
    const { execSync } = require('child_process');
    // 用 unzip 读 fabric.mod.json（Fabric）或 mods.toml（Forge）
    const zlib = require('zlib');
    // 简单方式：直接读文件头找 fabric.mod.json
    const buf = fs.readFileSync(jarPath);
    // 找 fabric.mod.json
    const fmjIdx = buf.indexOf(Buffer.from('fabric.mod.json'));
    if (fmjIdx > 0) {
      // 从 zip 里提取（简化：找 JSON 起止）
      const start = buf.indexOf(Buffer.from('{'), fmjIdx);
      let depth = 0, end = start;
      for (let i = start; i < Math.min(start + 5000, buf.length); i++) {
        if (buf[i] === 123) depth++;
        if (buf[i] === 125) depth--;
        if (depth === 0 && i > start) { end = i + 1; break; }
      }
      try {
        const j = JSON.parse(buf.slice(start, end).toString('utf-8'));
        return { name: j.name || path.basename(jarPath), version: j.version || '' };
      } catch (_) {}
    }
    // Forge: mods.toml
    const mtIdx = buf.indexOf(Buffer.from('mods.toml'));
    if (mtIdx > 0) {
      const txt = buf.slice(mtIdx, Math.min(mtIdx + 2000, buf.length)).toString('utf-8');
      const nameM = txt.match(/displayName\s*=\s*"([^"]+)"/);
      const verM = txt.match(/version\s*=\s*"([^"]+)"/);
      if (nameM || verM) return { name: nameM ? nameM[1] : path.basename(jarPath), version: verM ? verM[1] : '' };
    }
  } catch (_) {}
  return { name: path.basename(jarPath), version: '' };
}

ipcMain.handle('get-mods-detail', () => {
  const dir = modsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const favFile = path.join(app.getPath('userData'), 'mod-favs.json');
  let favs = {};
  try { favs = JSON.parse(fs.readFileSync(favFile, 'utf-8')); } catch (_) {}
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    const enabled = f.endsWith('.jar');
    const name = enabled ? f : f.replace(/\.disabled$/, '');
    const info = readModInfo(full);
    out.push({ name: info.name || name, file: f, loader: 'Fabric', version: info.version || '', enabled, fav: favs[f] || 0 });
  }
  return out;
});

ipcMain.handle('toggle-mod', (_e, file) => {
  const dir = modsDir();
  const from = path.join(dir, file);
  const to = file.endsWith('.disabled')
    ? path.join(dir, file.replace(/\.disabled$/, ''))
    : path.join(dir, file + '.disabled');
  fs.renameSync(from, to);
  return true;
});

ipcMain.handle('delete-mod', (_e, file) => {
  fs.rmSync(path.join(modsDir(), file), { force: true });
  return true;
});

ipcMain.handle('toggle-mod-fav', (_e, file) => {
  const favFile = path.join(app.getPath('userData'), 'mod-favs.json');
  let favs = {};
  try { favs = JSON.parse(fs.readFileSync(favFile, 'utf-8')); } catch (_) {}
  if (favs[file]) delete favs[file]; else favs[file] = Date.now();
  fs.writeFileSync(favFile, JSON.stringify(favs));
  return favs[file] || 0;
});

ipcMain.handle('import-mod-files', async (_e, files) => {
  fs.mkdirSync(modsDir(), { recursive: true });
  let count = 0;
  for (const f of files) {
    try { fs.copyFileSync(f, path.join(modsDir(), path.basename(f))); count++; } catch (_) {}
  }
  return count;
});

ipcMain.handle('get-resourcepacks', () => {
  const dir = rpDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip'))
    .map(f => ({ name: f, file: f, desc: '' }));
});

ipcMain.handle('delete-resourcepack', (_e, file) => {
  fs.rmSync(path.join(rpDir(), file), { force: true });
  return true;
});

ipcMain.handle('import-resourcepack', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '材质包', extensions: ['zip'] }]
  });
  if (r.canceled) return 0;
  fs.mkdirSync(rpDir(), { recursive: true });
  for (const f of r.filePaths) fs.copyFileSync(f, path.join(rpDir(), path.basename(f)));
  return r.filePaths.length;
});

// ===== IPC：光影包 =====
function shaderDir() { return path.join(getCfg().gameDir, 'shaderpacks'); }

ipcMain.handle('get-shaders', () => {
  const dir = shaderDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip') || f.endsWith('.jar'))
    .map(f => ({ name: f, file: f }));
});

ipcMain.handle('delete-shader', (_e, file) => {
  fs.rmSync(path.join(shaderDir(), file), { force: true });
  return true;
});

ipcMain.handle('import-shader', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '光影包', extensions: ['zip'] }]
  });
  if (r.canceled) return 0;
  fs.mkdirSync(shaderDir(), { recursive: true });
  for (const f of r.filePaths) fs.copyFileSync(f, path.join(shaderDir(), path.basename(f)));
  return r.filePaths.length;
});

// ===== IPC：Modrinth 仓库 =====
ipcMain.handle('search-mods', async (_e, { query, mcVersion, loader }) => {
  // 动态拼 facets：版本/加载器非空才加入，支持只按一个维度筛选
  const facetGroups = [];
  if (mcVersion) facetGroups.push([`versions:${mcVersion}`]);
  if (loader && loader !== 'optifine') facetGroups.push([`categories:${loader}`]);
  if (loader === 'optifine') {
    // OptiFine 不在 Modrinth 上，直接返回空提示
    return [{ slug: '', title: 'OptiFine 不在 Modrinth 上', description: '请到 optifine.net 手动下载，或用 Sodium 替代', icon: '' }];
  }
  const facets = facetGroups.length ? JSON.stringify(facetGroups) : '[]';
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(facets)}&limit=30`;
  const data = await httpGetJSON(url);
  return (data.hits || []).map(m => ({
    slug: m.slug, title: m.title, description: m.description, icon: m.icon_url || '',
    downloads: m.downloads
  }));
});

ipcMain.handle('download-mod', async (_e, { slug, mcVersion, loader }) => {
  const versions = await httpGetJSON(`https://api.modrinth.com/v2/project/${slug}/version?game_versions=[${JSON.stringify(mcVersion)}]&loaders=${JSON.stringify([loader])}`);
  if (!versions.length) throw new Error('没有匹配的版本文件');
  const v = versions[0];
  const file = v.files.find(f => f.primary) || v.files[0];
  fs.mkdirSync(modsDir(), { recursive: true });
  await httpDownload(file.url, path.join(modsDir(), file.filename));
  return file.filename;
});

// ===== IPC：整合包（Modrinth）=====
ipcMain.handle('search-modpacks', async (_e, query) => {
  const facets = JSON.stringify([['project_type:modpack']]);
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=20`;
  const data = await httpGetJSON(url);
  return (data.hits || []).map(m => ({
    slug: m.slug, title: m.title, description: m.description, icon: m.icon_url || '', downloads: m.downloads
  }));
});

ipcMain.handle('download-modpack', async (_e, { slug, mcVersion }) => {
  const versions = await httpGetJSON(`https://api.modrinth.com/v2/project/${slug}/version?game_versions=[${JSON.stringify(mcVersion)}]`);
  if (!versions.length) throw new Error('没有匹配的整合包版本');
  const v = versions[0];
  const file = v.files.find(f => f.primary) || v.files[0];
  const dlDir = path.join(app.getPath('userData'), 'modpacks');
  fs.mkdirSync(dlDir, { recursive: true });
  await httpDownload(file.url, path.join(dlDir, file.filename));
  return file.filename;
});

// ===== IPC：数据包 =====
function datapackDir() { return path.join(getCfg().gameDir, 'datapacks'); }

ipcMain.handle('get-datapacks', () => {
  const dir = datapackDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip'))
    .map(f => ({ name: f, file: f }));
});

ipcMain.handle('delete-datapack', (_e, file) => {
  fs.rmSync(path.join(datapackDir(), file), { force: true });
  return true;
});

ipcMain.handle('import-datapack', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '数据包', extensions: ['zip'] }]
  });
  if (r.canceled) return 0;
  fs.mkdirSync(datapackDir(), { recursive: true });
  for (const f of r.filePaths) fs.copyFileSync(f, path.join(datapackDir(), path.basename(f)));
  return r.filePaths.length;
});

// ===== IPC：皮肤 =====
ipcMain.handle('get-skin', () => {
  if (!fs.existsSync(skinPath())) return null;
  try { return 'data:image/png;base64,' + fs.readFileSync(skinPath()).toString('base64'); } catch (_) { return null; }
});

ipcMain.handle('choose-skin', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: '皮肤 PNG', extensions: ['png'] }]
  });
  if (r.canceled) return null;
  fs.copyFileSync(r.filePaths[0], skinPath());
  return 'data:image/png;base64,' + fs.readFileSync(skinPath()).toString('base64');
});

ipcMain.handle('clear-skin', () => {
  fs.rmSync(skinPath(), { force: true });
  return true;
});

ipcMain.handle('set-skin-type', async (_e, type) => {
  const cfg = loadConfig();
  cfg.skinType = type;
  saveConfig(cfg);
  if (type === 'steve' || type === 'alex' || type === 'random') {
    fs.rmSync(skinPath(), { force: true });
  }
  return true;
});

// ===== IPC：音乐 =====
ipcMain.handle('get-music-files', () => {
  try {
    if (!fs.existsSync(musicDir())) return [];
    return fs.readdirSync(musicDir())
      .filter(f => fs.statSync(path.join(musicDir(), f)).isFile())
      .filter(f => /\.(mp3|ogg|wav|m4a|flac)$/i.test(f))
      .map(f => ({ name: f, path: pathToFileURL(path.join(musicDir(), f)).href }));
  } catch (e) {
    console.error('[音乐扫描失败]', e);
    return [];
  }
});

ipcMain.handle('add-music', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音乐', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'flac'] }]
    });
    if (r.canceled) return [];
    fs.mkdirSync(musicDir(), { recursive: true });
    const added = [];
    for (const f of r.filePaths) {
      const dest = path.join(musicDir(), path.basename(f));
      fs.copyFileSync(f, dest);
      added.push(pathToFileURL(dest).href);
    }
    return added;
  } catch (e) {
    console.error('[添加音乐失败]', e);
    return [];
  }
});

ipcMain.handle('delete-music', (_e, fileName) => {
  try {
    const p = path.join(musicDir(), path.basename(fileName));
    fs.rmSync(p, { force: true });
    return true;
  } catch (e) { console.error(e); return false; }
});

ipcMain.handle('add-favorite', (_e, fileName) => {
  try {
    fs.mkdirSync(favDir(), { recursive: true });
    const src = path.join(musicDir(), path.basename(fileName));
    const dst = path.join(favDir(), path.basename(fileName));
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    return true;
  } catch (e) { console.error(e); return false; }
});

ipcMain.handle('remove-favorite', (_e, fileName) => {
  try {
    fs.rmSync(path.join(favDir(), path.basename(fileName)), { force: true });
    return true;
  } catch (e) { console.error(e); return false; }
});

ipcMain.handle('favorite-all-music', () => {
  try {
    if (!fs.existsSync(musicDir())) return 0;
    fs.mkdirSync(favDir(), { recursive: true });
    let count = 0;
    for (const f of fs.readdirSync(musicDir())) {
      const src = path.join(musicDir(), f);
      if (!fs.statSync(src).isFile()) continue;
      if (!/\.(mp3|ogg|wav|m4a|flac)$/i.test(f)) continue;
      const dst = path.join(favDir(), f);
      if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); count++; }
    }
    return count;
  } catch (e) { console.error(e); return 0; }
});

ipcMain.handle('get-favorites', () => {
  try {
    if (!fs.existsSync(favDir())) return [];
    return fs.readdirSync(favDir())
      .filter(f => fs.statSync(path.join(favDir(), f)).isFile())
      .filter(f => /\.(mp3|ogg|wav|m4a|flac)$/i.test(f))
      .map(f => ({ name: f, path: pathToFileURL(path.join(favDir(), f)).href }));
  } catch (e) { return []; }
});

ipcMain.handle('save-music-state', (_e, state) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'music-state.json'), JSON.stringify(state));
  return true;
});

ipcMain.handle('load-music-state', () => {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'music-state.json'), 'utf-8')); }
  catch (_) { return { index: 0, time: 0 }; }
});

// ===== IPC：Yggdrasil 外置登录 =====
ipcMain.handle('yggdrasil-login', async (_e, { baseUrl, username, password }) => {
  const body = JSON.stringify({
    agent: { name: 'Minecraft', version: 1 },
    username, password,
    clientToken: 'xingtu-' + Date.now(),
    requestUser: true
  });
  const url = new URL(baseUrl.replace(/\/$/, '') + '/authserver/authenticate');
  const res = await new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => {
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (r.statusCode !== 200) return reject(new Error('登录失败 HTTP ' + r.statusCode + ': ' + text));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
  const profile = res.selectedProfile || {};
  const cfg = loadConfig();
  cfg.authConfig = {
    mode: 'yggdrasil',
    yggdrasilUrl: baseUrl,
    yggdrasilUser: username,
    accessToken: res.accessToken,
    uuid: profile.id,
    name: profile.name || username
  };
  saveConfig(cfg);
  return { name: profile.name || username };
});

// ===== IPC：微软正版登录（基础框架）=====
ipcMain.handle('microsoft-login', async () => {
  // 微软 OAuth 流程：打开浏览器登录，需要 Azure 应用注册
  // 这里先打开微软登录页面，完整 token 交换需要后续接入
  const clientId = '00000000402b5328'; // Minecraft 官方启动器常用 clientId
  const authUrl = `https://login.microsoftonline.com/oauth20_authorize?client_id=${clientId}&response_type=code&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient&scope=XboxLive.signin+offline_access&prompt=select_account`;
  try { shell.openExternal(authUrl); } catch (_) {}
  return { ok: true, message: '已打开浏览器，请在浏览器中登录微软账号' };
});

// ===== 启动 =====
// 全局异常兜底，防止一个未捕获错误直接闪退
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
  sendLog('[错误] ' + (err && err.message ? err.message : err));
});
process.on('unhandledRejection', (err) => {
  console.error('[未处理Promise]', err);
  sendLog('[错误] ' + (err && err.message ? err.message : err));
});

// 导入 .mrpack 整合包
ipcMain.handle('import-mrpack', async (_e, filePath) => {
  const cfg = getCfg();
  const extractDir = path.join(cfg.gameDir, 'mrpack-tmp');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await new Promise((res, rej) => {
    require('child_process').exec(`tar -xf "${filePath}" -C "${extractDir}"`, (err) => err ? rej(err) : res());
  });
  const idxPath = path.join(extractDir, 'modrinth.index.json');
  if (!fs.existsSync(idxPath)) throw new Error('不是有效的 mrpack 文件');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
  const mcVer = idx.dependencies?.['minecraft'];
  const overridesDir = path.join(extractDir, 'overrides');
  if (fs.existsSync(overridesDir)) {
    await new Promise((res) => {
      require('child_process').exec(`xcopy "${overridesDir}\\*" "${cfg.gameDir}\\" /E /Y /Q`, () => res());
    });
  }
  sendLog('[星兔] ✅ 整合包导入完成，MC 版本: ' + mcVer);
  return mcVer;
});

ipcMain.handle('import-zip-modpack', async (_e, filePath) => {
  const cfg = getCfg();
  await new Promise((res, rej) => {
    require('child_process').exec(`tar -xf "${filePath}" -C "${cfg.gameDir}"`, (err) => err ? rej(err) : res());
  });
  sendLog('[星兔] ✅ 整合包解压完成');
});

// 打开游戏目录和截图
ipcMain.handle('open-game-dir', () => { require('child_process').exec('explorer "' + getCfg().gameDir + '"'); });
ipcMain.handle('open-screenshots', () => { require('child_process').exec('explorer "' + path.join(getCfg().gameDir, 'screenshots') + '"'); });
ipcMain.handle('clear-cache', () => {
  const cacheDir = path.join(app.getPath('appData'), '星兔启动器', 'cache');
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// ===== IPC：报错诊断收集 =====
ipcMain.handle('get-error-reports', async () => {
  const gameDir = getCfg().gameDir;
  const reports = [];

  // 1. 崩溃报告 crash-reports/*.txt
  try {
    const crashDir = path.join(gameDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
      const files = fs.readdirSync(crashDir).filter(f => f.endsWith('.txt')).sort().reverse();
      for (const f of files.slice(0, 10)) {
        const fp = path.join(crashDir, f);
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8').slice(0, 5000);
        const parsed = parseCrashReport(content);
        reports.push({
          type: '崩溃报告',
          icon: '💥',
          file: f,
          time: stat.mtime.toLocaleString('zh-CN'),
          category: parsed.category,
          summary: parsed.summary,
          advice: parsed.advice,
          detail: content
        });
      }
    }
  } catch (e) {}

  // 2. 最近日志 logs/latest.log 中的错误
  try {
    const logPath = path.join(gameDir, 'logs', 'latest.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const errors = parseLogErrors(content);
      for (const e of errors.slice(0, 8)) {
        reports.push(e);
      }
    }
  } catch (e) {}

  // 3. JVM 崩溃日志 hs_err_pid*.log
  try {
    const files = fs.readdirSync(gameDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).sort().reverse();
    for (const f of files.slice(0, 5)) {
      const fp = path.join(gameDir, f);
      const stat = fs.statSync(fp);
      const content = fs.readFileSync(fp, 'utf-8').slice(0, 3000);
      reports.push({
        type: 'JVM崩溃',
        icon: '☕',
        file: f,
        time: stat.mtime.toLocaleString('zh-CN'),
        category: 'Java崩溃',
        summary: extractJvmCrashSummary(content),
        advice: 'JVM 崩溃通常是显卡驱动、Java 版本或内存不足导致。建议更新显卡驱动、使用 JDK 17+、分配足够内存。',
        detail: content
      });
    }
  } catch (e) {}

  // 4. Mod 加载错误（从日志中提取）
  try {
    const modsDir = path.join(gameDir, 'mods');
    if (fs.existsSync(modsDir)) {
      const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
      reports.push({
        type: 'Mod概览',
        icon: '📦',
        file: '',
        time: '',
        category: 'Mod',
        summary: `当前已安装 ${jars.length} 个 Mod`,
        advice: jars.length > 50 ? 'Mod 过多可能导致加载慢或冲突，建议排查不需要的 Mod。' : 'Mod 数量正常，注意版本兼容性。',
        detail: jars.join('\n')
      });
    }
  } catch (e) {}

  return reports;
});

// 解析崩溃报告
function parseCrashReport(content) {
  let category = '未知错误';
  let summary = '游戏崩溃';
  let advice = '请查看详细日志定位原因。';

  if (/OutOfMemoryError|java heap space|GC overhead/i.test(content)) {
    category = '内存不足';
    summary = '内存溢出（OutOfMemoryError / Java heap space）';
    advice = '解决方法：① 去设置里把最大内存调到 4098M 或 6144M（别超过你电脑内存的一半）；② 如果装了光影，先关掉试试；③ Mod 太多就删掉不用的；④ 装个 FoamFix/Sodium 类优化 Mod。';
  } else if (/mod.*conflict|incompatible|requires|missing.*dependency|NoSuchMethod|NoClassDefFound/i.test(content)) {
    category = 'Mod冲突/依赖缺失';
    summary = 'Mod 不兼容或缺少前置依赖';
    const modMatch = content.match(/mod[s]?[ :]*(.*?)[\n\r]/i) || content.match(/([A-Za-z0-9_]+) v?[\d.]+/);
    summary += modMatch ? `（涉及: ${modMatch[1]}）` : '';
    advice = '解决方法：① 看日志里提到哪个 Mod 报错，去 mods 文件夹把它先移出；② 检查这个 Mod 是否匹配你的 MC 版本和加载器（Forge/Fabric）；③ 它可能需要前置 Mod（如 Fabric API、Architectury API），去 Mod 仓库下载对应前置；④ 两个 Mod 冲突就二选一。';
  } else if (/shader|optifine|iris/i.test(content)) {
    category = '光影错误';
    summary = '光影包 / OptiFine / Iris 崩溃';
    advice = '解决方法：① 进游戏选项→视频设置→光影，先关掉光影看还崩不崩；② 换一个光影包试试（BSL/Complementary 比较稳）；③ 更新 OptiFine 或 Iris 到最新版；④ 更新显卡驱动；⑤ 光影版本要和 MC 版本对应。';
  } else if (/texturepack|resourcepack/i.test(content)) {
    category = '材质包错误';
    summary = '材质包加载失败或损坏';
    advice = '解决方法：① 把最近装的材质包从 resourcepacks 文件夹移出；② 材质包格式要和 MC 版本匹配（1.21 的材质不能给 1.12 用）；③ 重新下载材质包，可能下载过程中损坏了；④ 材质包分辨率别太高（512x 以上会卡）。';
  } else if (/OpenGL|GLFW|driver|显卡|Failed to create/i.test(content)) {
    category = '显卡驱动';
    summary = 'OpenGL / 显卡驱动初始化失败';
    advice = '解决方法：① 更新显卡驱动（N卡去 GeForce Experience，A卡去 Adrenalin）；② 笔记本注意用独显运行（右键→用图形处理器运行→高性能 NVIDIA）；③ 更新 Java 到 17+；④ 试试分配更多内存。';
  } else if (/java\.lang\.ClassNotFoundException|NoClassDefFoundError|missing.*library/i.test(content)) {
    category = '文件缺失';
    summary = '游戏文件或库文件损坏/缺失';
    advice = '解决方法：① 回主页点版本旁边的刷新按钮（🔄）重新校验下载；② 如果还不行，删掉版本文件夹重新下载；③ 检查网络，BMCLAPI 镜像可能抽风，多试几次；④ 别用下载工具下 MC 文件。';
  } else if (/tick.*entity|entity.*tick/i.test(content)) {
    category = '实体错误';
    summary = '某个实体（怪物/NPC）导致游戏崩溃';
    advice = '解决方法：① 这通常是某个 Mod 添加的实体 bug；② 回忆最近装了什么 Mod，先移出它；③ 如果进存档就崩，试试先开新存档看正不正常；④ 存档里可以用 NBTExplorer 删掉报错的实体。';
  } else if (/401|InvalidCredentials|authentication|user.*properties/i.test(content)) {
    category = '登录认证';
    summary = '外置登录 / 正版认证失败（401 错误）';
    advice = '解决方法：① 检查 LittleSkin 账号密码有没有输错；② 点登录按钮重新登录一次；③ 检查网络能不能访问 littleskin.cn；④ 如果是正版登录，去微软账户重新授权。';
  } else {
    const descMatch = content.match(/Description: (.*)/);
    if (descMatch) summary = descMatch[1].slice(0, 100);
  }

  return { category, summary, advice };
}

// 解析日志中的错误
function parseLogErrors(content) {
  const errors = [];
  const lines = content.split('\n');
  const seen = new Set();
  for (const line of lines) {
    if (!/ERROR|FATAL|Exception|Caused by/.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.length < 20) continue;
    const key = trimmed.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    let category = '日志错误';
    let advice = '查看详细日志定位问题，一般不影响游戏运行。';
    if (/mod.*error|mod.*load/i.test(trimmed)) { category = 'Mod加载'; advice = '解决：找到报错的 Mod，检查它是否匹配 MC 版本和加载器；缺少前置就装前置；不兼容就移除。'; }
    else if (/shader|iris/i.test(trimmed)) { category = '光影'; advice = '解决：换一个光影包，或在视频设置里关掉光影；更新 Iris/OptiFine。'; }
    else if (/texturepack|resourcepack/i.test(trimmed)) { category = '材质包'; advice = '解决：把材质包移出 resourcepacks 文件夹，换个版本试试。'; }
    else if (/connection|timeout|refused|401/i.test(trimmed)) { category = '网络/登录'; advice = '解决：检查网络；重新登录 LittleSkin；如果是离线登录可以忽略。'; }
    else if (/OutOfMemory|heap/i.test(trimmed)) { category = '内存'; advice = '解决：去设置把最大内存调到 4098M 以上，关掉光影和多余 Mod。'; }
    else if (/sound|audio/i.test(trimmed)) { category = '音频'; advice = '解决：音频设备小问题，不影响游戏；如果没声音就检查音箱/耳机连接。'; }
    else if (/crash|fatal/i.test(trimmed)) { category = '严重错误'; advice = '解决：这是导致崩溃的错误，去 crash-reports 文件夹看完整崩溃报告，或点报错诊断页查看详细分析。'; }

    errors.push({
      type: '日志错误',
      icon: '📋',
      file: 'logs/latest.log',
      time: '',
      category,
      summary: trimmed.slice(0, 200),
      advice,
      detail: trimmed
    });
  }
  return errors;
}

function extractJvmCrashSummary(content) {
  const m = content.match(/SIGSEGV|EXCEPTION_|Problematic frame[^\n]*/);
  return m ? m[0].slice(0, 150) : 'JVM 非正常退出';
}

// 清理报错文件
ipcMain.handle('clear-error-reports', async () => {
  const gameDir = getCfg().gameDir;
  let deleted = 0;
  try {
    // 删 crash-reports 里的 .txt
    const crashDir = path.join(gameDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
      for (const f of fs.readdirSync(crashDir)) {
        if (f.endsWith('.txt')) { fs.rmSync(path.join(crashDir, f), { force: true }); deleted++; }
      }
    }
    // 删 hs_err_pid*.log
    for (const f of fs.readdirSync(gameDir)) {
      if (f.startsWith('hs_err_pid') && f.endsWith('.log')) { fs.rmSync(path.join(gameDir, f), { force: true }); deleted++; }
    }
    return { ok: true, deleted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  fs.mkdirSync(musicDir(), { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (launcher) { try { launcher.kill('SIGTERM'); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
