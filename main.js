// System Vitals — Electron main process.
// (1) 파이썬 수집기(collector.py) 견고하게 실행/종료, (2) 선택한 모니터에만 전체화면,
// (3) 모니터 해상도에 맞춰 그 디스플레이에 맞춤(대시보드 CSS 가 자동 정돈).
const { app, BrowserWindow, screen, ipcMain, Menu, shell, Tray, nativeImage } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------- RAM 최적화 ----------
// 이 대시보드는 텍스트·작은 SVG·CSS 트랜지션뿐이라 GPU 하드웨어 가속의 이득이 거의 없는데,
// GPU 프로세스 하나가 WorkingSet ~128MB(Private ~224MB)를 상시 점유하고 있었다(실측).
// 가속을 끄면 GPU 프로세스가 사라져 그만큼 통째로 절약된다. 소프트웨어 래스터는 갱신 영역이
// 작은 이 화면에선 CPU 부담이 미미하다. (app ready 전에 호출해야 적용됨)
app.disableHardwareAcceleration();
// 가속을 꺼도 소프트웨어 컴포지터용 GPU 프로세스(~80MB)가 별도로 남는다 — 메인 프로세스에
// 합쳐서 프로세스 하나를 통째로 없앤다(전용 서브모니터 패널이라 프로세스 격리 이득이 없음).
app.commandLine.appendSwitch('in-process-gpu');
// V8 힙 상한(이 페이지의 JS 힙 실사용은 ~10MB대 — 여유 2배 이상). 힙이 커지기 전에 GC 를
// 유도해 렌더러 상주 메모리 증식을 막는 안전망이다.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');
const resDir = app.isPackaged ? process.resourcesPath : __dirname;   // collector.py / dashboard.html 위치
const cfgFile = path.join(app.getPath('userData'), 'panel-config.json');
const ICON = path.join(__dirname, 'build', 'icon.ico');   // 창·트레이 공용 아이콘

let win = null;
let tray = null;
let collector = null;
// targetSig: 지정 모니터의 안정적 서명(모델명+해상도). waitForDisplay: 그 모니터 연결 시에만 표시.
// openAtLogin: 부팅 시 자동 실행(Windows 로그인 항목).
let cfg = { displayId: null, kiosk: false, targetSig: null, waitForDisplay: false, openAtLogin: false };
let serverUp = false;   // /sensors 응답 확인됨
let quitting = false;

function loadCfg() { try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (e) {} }
function saveCfg() {
  try { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg)); }
  catch (e) {}
}

// 이전 실행에서 남은(유령) 수집기가 8788 을 물고 있으면 정리한 뒤 진행
function reapPort(cb) {
  if (process.platform !== 'win32') return cb();
  exec('netstat -ano -p tcp', { windowsHide: true }, (err, out) => {
    const pids = new Set();
    (out || '').split(/\r?\n/).forEach(l => {
      const m = l.match(/:8788\s.*?LISTENING\s+(\d+)/i);
      if (m) pids.add(m[1]);
    });
    pids.forEach(pid => { try { spawn('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true }); } catch (e) {} });
    setTimeout(cb, pids.size ? 500 : 0);
  });
}

// ---------- 수집기(python) — 여러 후보를 순서대로 시도, 실제로 살아서 서빙하는 것만 채택 ----------
function startCollector() {
  const script = path.join(resDir, 'collector.py');
  if (!fs.existsSync(script)) { console.error('[collector] collector.py not found:', script); return; }
  // Windows: 'py -3'(런처, MS Store 스텁 회피) → python → python3
  const cands = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  let i = 0;
  const tryNext = () => {
    if (quitting) return;
    if (i >= cands.length) { console.error('[collector] no runnable Python 3 found (install Python 3)'); return; }
    const [cmd, pre] = cands[i++];
    let p;
    try { p = spawn(cmd, [...pre, script], { cwd: resDir, windowsHide: true }); }
    catch (e) { return tryNext(); }
    p.once('spawn', () => { collector = p; });
    p.on('error', () => { if (collector !== p) tryNext(); });                 // 실행 자체 실패 → 다음 후보
    p.on('exit', (code) => {                                                  // 조기 종료(Store 스텁 등) → 다음 후보
      if (collector === p) collector = null;
      if (!quitting && !serverUp) tryNext();
    });
    if (p.stdout) p.stdout.on('data', d => console.log('[collector]', d.toString().trim()));
    if (p.stderr) p.stderr.on('data', d => console.error('[collector]', d.toString().trim()));
  };
  tryNext();
}

function killCollector() {
  if (!collector || !collector.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(collector.pid), '/T', '/F']);
    else collector.kill();
  } catch (e) {}
  collector = null;
}

// 확실한 종료: 그레이스풀 단계를 우회하고 즉시 프로세스 종료 + 수집기 정리
function hardQuit() {
  quitting = true;
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  killCollector();
  app.exit(0);
}
function toggleKiosk() { cfg.kiosk = !cfg.kiosk; saveCfg(); if (win) win.setKiosk(cfg.kiosk); pushDisplays(); }

function waitForCollector(cb, tries = 0) {
  const again = () => { if (tries > 80) return cb(false); setTimeout(() => waitForCollector(cb, tries + 1), 300); };
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/sensors', timeout: 2000 }, res => {
    res.resume();
    if (res.statusCode === 200) { serverUp = true; cb(true); } else again();   // 503=준비중 → 재시도
  });
  req.on('error', again);
  req.on('timeout', () => req.destroy(new Error('timeout')));   // 에러로 destroy 해야 재시도 체인이 이어짐
}

// ---------- 디스플레이 ----------
function allDisplays() { return screen.getAllDisplays(); }
function primaryId() { return screen.getPrimaryDisplay().id; }

// 지정 모니터를 '안정적으로' 식별한다. displayId 는 재연결 시 바뀌므로 모델명(label)+해상도 서명으로 매칭.
function matchesSig(d) {
  const s = cfg.targetSig; if (!s) return false;
  if (s.label && d.label) return d.label === s.label && d.size.width === s.w && d.size.height === s.h;
  return d.size.width === s.w && d.size.height === s.h;   // 라벨 없으면 해상도로
}
// 지금 '연결돼 있는' 지정 모니터 (없으면 null)
function chosenDisplay() {
  const ds = allDisplays();
  return (cfg.targetSig ? ds.find(matchesSig) : null)
      || (cfg.displayId != null ? ds.find(x => x.id === cfg.displayId) : null)
      || null;
}
function targetDisplay() {
  const found = chosenDisplay();
  if (found) return found;
  // 지정 모니터가 연결돼 있지 않음:
  const hasTarget = cfg.targetSig || cfg.displayId != null;
  if (hasTarget && cfg.waitForDisplay) return null;   // '연결 시에만 표시' → 숨김(연결되면 자동으로 표시)
  // 그 외: 지금 커서가 있는 화면으로 폴백 — 수동 실행 시 '켰는데 안 보임' 방지
  try { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }
  catch (e) { return screen.getPrimaryDisplay(); }
}

function applyDisplay(d) {
  if (!win || win.isDestroyed()) return;
  if (!d) { if (win.isVisible()) win.hide(); pushDisplays(); return; }  // 고른 모니터 부재 → 숨김(타 화면 침범 방지)
  if (!win.isVisible()) win.show();
  const b = d.bounds, cur = win.getBounds();
  const onTarget = win.isFullScreen() &&
    cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height;
  if (!onTarget) {                                    // 이미 그 화면·크기면 재적용 생략(깜빡임 방지)
    if (win.isKiosk()) win.setKiosk(false);
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.setFullScreen(true);
  }
  if (cfg.kiosk && !win.isKiosk()) win.setKiosk(true);
  if (!cfg.kiosk && win.isKiosk()) win.setKiosk(false);
  pushDisplays();
}

function displayPayload() {
  const cur = chosenDisplay();   // '고른' 모니터가 연결돼 있을 때만 하이라이트(폴백 화면 아님)
  return {
    displays: allDisplays().map((d, i) => ({
      id: d.id, index: i, w: d.size.width, h: d.size.height, label: d.label || '',
      primary: d.id === primaryId(), current: !!cur && d.id === cur.id,
    })),
    kiosk: !!cfg.kiosk, openAtLogin: !!cfg.openAtLogin, waitForDisplay: !!cfg.waitForDisplay,
  };
}
function pushDisplays() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('panel:displays', displayPayload());
}

function switchToDisplay(id) {
  const d = allDisplays().find(x => x.id === id);
  if (!d) { console.warn('[display] id not found:', id); return; }
  console.log('[display] switch ->', d.id, d.label || '', `${d.size.width}x${d.size.height}`);
  cfg.displayId = id;
  cfg.targetSig = { label: d.label || '', w: d.size.width, h: d.size.height };   // 재연결에도 견디는 서명 저장
  saveCfg(); applyDisplay(d); updateTray();
}

// ---------- 트레이 · 부팅 자동실행 · 지정 모니터 연결 시 표시 ----------
// 수동 '표시'는 대기 모드여도 강제로 창을 띄운다(숨은 앱을 되살릴 유일한 경로).
function showOnTarget() {
  if (!win || win.isDestroyed()) return;
  const d = targetDisplay() || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const b = d.bounds;
  if (win.isKiosk()) win.setKiosk(false);
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  win.show(); win.setFullScreen(true);
  if (cfg.kiosk) win.setKiosk(true);
  win.focus(); pushDisplays();
}
function setOpenAtLogin(v) {
  cfg.openAtLogin = !!v; saveCfg();
  try { app.setLoginItemSettings({ openAtLogin: cfg.openAtLogin }); } catch (e) {}
  updateTray(); pushDisplays();
}
function setWaitForDisplay(v) {
  cfg.waitForDisplay = !!v; saveCfg();
  applyDisplay(targetDisplay());   // 즉시 반영: 지정 모니터 없으면 숨김 / 있으면 표시
  updateTray(); pushDisplays();
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '표시', click: showOnTarget },
    { label: '설정 열기', click: () => { showOnTarget(); if (win && !win.isDestroyed()) win.webContents.send('panel:openSettings'); } },
    { type: 'separator' },
    { label: '부팅 시 자동 실행', type: 'checkbox', checked: !!cfg.openAtLogin, click: (mi) => setOpenAtLogin(mi.checked) },
    { label: '지정 모니터 연결 시에만 표시', type: 'checkbox', checked: !!cfg.waitForDisplay, click: (mi) => setWaitForDisplay(mi.checked) },
    { type: 'separator' },
    { label: '종료', click: hardQuit },
  ]);
}
function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON);
    if (img.isEmpty()) return;   // 아이콘 없으면 트레이 생략(치명적 아님)
    tray = new Tray(img);
    tray.setToolTip('System Vitals');
    tray.setContextMenu(trayMenu());
    tray.on('click', showOnTarget);   // 좌클릭 = 표시
  } catch (e) { /* 트레이 실패는 앱 동작에 치명적이지 않음 */ }
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  const waiting = !chosenDisplay() && cfg.waitForDisplay;
  tray.setToolTip(waiting ? 'System Vitals — 대기 중 (지정 모니터 미연결)' : 'System Vitals');
}

// ---------- 창 ----------
const page = (title, msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0b0e;color:#98a3b2;
   font-family:system-ui,'Segoe UI',sans-serif;text-align:center">
   <div><div style="font-size:15px;letter-spacing:.2em;color:#eef2f7">${title}</div>
   <div style="margin-top:10px;font-size:12px;line-height:1.7">${msg}</div></div></body></html>`);
const LOADING = page('SYSTEM VITALS', '센서 수집기 시작 중…');
const ERRPAGE = page('수집기 시작 실패',
  'Python 3 이 설치돼 있는지 확인하세요.' +
  '<div style="margin-top:18px;display:flex;gap:10px;justify-content:center">' +
    '<button onclick="window.panelAPI&amp;&amp;panelAPI.reload()" style="padding:9px 20px;border-radius:9px;border:1px solid #2a3441;background:#181c23;color:#eef2f7;font-size:12px;font-weight:600;cursor:pointer">재시도</button>' +
    '<button onclick="window.panelAPI&amp;&amp;panelAPI.quit()" style="padding:9px 20px;border-radius:9px;border:1px solid #5a2a2a;background:#181c23;color:#ff8a8a;font-size:12px;font-weight:600;cursor:pointer">종료</button>' +
  '</div>');

function loadDashboardOrError(ok) {
  if (!win || win.isDestroyed()) return;
  if (ok) win.loadURL(`${ORIGIN}/dashboard.html`);
  else win.loadURL(ERRPAGE);
}

function retry() {
  if (serverUp && win && !win.isDestroyed()) { win.reload(); return; }
  serverUp = false;
  if (win && !win.isDestroyed()) win.loadURL(LOADING);
  startCollector();
  waitForCollector(loadDashboardOrError);
}

function createWindow() {
  const d = targetDisplay();
  const startBounds = (d || screen.getPrimaryDisplay()).bounds;
  win = new BrowserWindow({
    x: startBounds.x, y: startBounds.y, width: startBounds.width, height: startBounds.height,
    frame: false, show: false, backgroundColor: '#0a0b0e', autoHideMenuBar: true, skipTaskbar: false,
    icon: ICON,   // 작업표시줄 아이콘(개발). 패키징은 build.win.icon 이 담당
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      // RAM 절약: 맞춤법 사전 로드 안 함 / WebSQL 비활성 / V8 코드캐시 생략(시작 몇 ms 느려지는 대신 상주 메모리 ↓)
      spellcheck: false, enableWebSQL: false, v8CacheOptions: 'none',
    },
  });
  // 하드닝: 새 창은 거부(외부 링크는 기본 브라우저로), 오리진 밖 이동 차단
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN) && !url.startsWith('data:')) e.preventDefault();
  });
  win.loadURL(LOADING);
  // applyDisplay 가 show/hide 를 판단한다: 지정 모니터가 있으면 그 화면에 표시,
  // '연결 시에만 표시' + 지정 모니터 부재면 숨긴 채 트레이에서 대기(깜빡임 없음).
  win.once('ready-to-show', () => applyDisplay(targetDisplay()));
  win.webContents.on('did-finish-load', pushDisplays);
  win.on('closed', () => { win = null; });

  waitForCollector(loadDashboardOrError);
}

// ---------- IPC (렌더러 → 메인) ----------
ipcMain.handle('panel:getDisplays', () => displayPayload());
ipcMain.on('panel:selectDisplay', (_e, id) => { if (Number.isInteger(id)) switchToDisplay(id); });
ipcMain.on('panel:toggleKiosk', () => toggleKiosk());
ipcMain.on('panel:setOpenAtLogin', (_e, v) => setOpenAtLogin(v));
ipcMain.on('panel:setWaitForDisplay', (_e, v) => setWaitForDisplay(v));
ipcMain.on('panel:reload', () => retry());
ipcMain.on('panel:quit', () => hardQuit());

// ---------- 라이프사이클 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    loadCfg();
    try { cfg.openAtLogin = app.getLoginItemSettings().openAtLogin; } catch (e) {}   // 실제 OS 등록 상태로 동기화
    Menu.setApplicationMenu(null);
    reapPort(() => startCollector());   // 오래된 수집기 정리 후 새로 실행
    createWindow();
    createTray();   // 대기 모드에서 숨은 앱을 제어할 트레이(표시·설정·자동실행·종료)
    // 모든 패널 제어는 설정(⚙) 창 + 트레이 메뉴로. 키보드 단축키는 없음.

    // 모니터 연결/해제/해상도 변경 시: 지정 모니터면 그 화면에 표시, 대기 모드면 숨김/표시 자동 전환
    const replace = () => { applyDisplay(targetDisplay()); updateTray(); };
    screen.on('display-added', replace);
    screen.on('display-removed', replace);
    screen.on('display-metrics-changed', replace);
  });

  app.on('will-quit', () => { quitting = true; killCollector(); });
  app.on('window-all-closed', () => app.quit());
}
