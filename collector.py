#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
System Vitals — 실시간 센서 수집기. '설치 불필요' 실측 버전.

읽는 소스 (전부 Windows 기본 + 드라이버):
  - nvidia-smi         : GPU 온도·사용률·클럭·전력·VRAM·팬%   (완전 실측)
  - Windows 성능카운터  : CPU 사용률(코어별)·유효 클럭, RAM, 네트워크 처리량, 디스크 사용률
  - WMI                : 부품 신원(CPU/GPU/메인보드/RAM 규격/NIC/호스트)

읽을 수 없는 것(→ 대시보드에 'N/A · LHM 필요' 로 표시, 가짜값 없음):
  - CPU 온도/전력, 메인보드 팬 RPM, 디스크 온도, 전압
  이건 LibreHardwareMonitor(관리자 권한) 설치해야 노출됩니다.

실행:
  python collector.py    →    브라우저로 http://localhost:8788/
  (대시보드는 /sensors 가 응답하면 자동으로 '실측 모드'로 전환됩니다.)
"""
import json, os, re, socket, platform, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:                                   # 콘솔 한글 로그가 안 깨지게 UTF-8 + 줄단위 플러시
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

LHM_URL = "http://127.0.0.1:8085/data.json"   # LibreHardwareMonitor Remote Web Server

PORT = 8788
HERE = os.path.dirname(os.path.abspath(__file__))
PS1  = os.path.join(HERE, "sensors_dynamic.ps1")

def _num(x):
    try: return float(x)
    except Exception: return None

# ---------------------------------------------------------------- nvidia-smi (GPU 실측)
GPU_FIELDS = ("temperature.gpu,utilization.gpu,clocks.sm,clocks.mem,"
              "power.draw,memory.used,memory.total,fan.speed,name")
def read_nvidia():
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={GPU_FIELDS}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4.0)
        parts = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
        t,u,csm,cmem,pw,vu,vt,fan = [_num(x) for x in parts[:8]]
        name = ",".join(parts[8:]).strip() if len(parts) > 8 else None
        return {"name": name, "temp": t, "load": u, "clock": csm, "memClock": cmem,
                "power": pw,
                "vramUsed": (vu/1024.0) if vu is not None else None,   # MiB → GB
                "vramTotal": (vt/1024.0) if vt is not None else None,
                "fanPct": fan}
    except Exception:
        return {}

# ---------------------------------------------------------------- 부품 신원 (WMI, 1회 캐시)
_IDENT = None
def read_identity():
    global _IDENT
    if _IDENT is not None: return _IDENT
    ident = {"host": socket.gethostname(),
             "os": (platform.system()+" "+platform.release()).strip()}
    ps = r"""
$ErrorActionPreference='SilentlyContinue'
$mem = Get-CimInstance Win32_PhysicalMemory
$o = [ordered]@{
  cpu  = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)
  gpu  = (Get-CimInstance Win32_VideoController | Where-Object {$_.AdapterRAM -gt 0 -and $_.Name -notlike '*Parsec*' -and $_.Name -notlike '*Basic*'} | Select-Object -First 1 -ExpandProperty Name)
  mobo = (Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty Product)
  os   = (Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty Caption)
  ramSpeed = ($mem | Measure-Object -Property Speed -Maximum).Maximum
  ramType  = ($mem | Select-Object -First 1 -ExpandProperty SMBIOSMemoryType)
  ramTotal = [math]::Round((($mem | Measure-Object -Property Capacity -Sum).Sum)/1GB)
  nic  = (Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=true AND NetEnabled=true" | Select-Object -First 1 -ExpandProperty Name)
}
$o | ConvertTo-Json -Compress
"""
    try:
        out = subprocess.run(["powershell","-NoProfile","-NonInteractive","-Command",ps],
                             capture_output=True, text=True, timeout=20.0)
        d = json.loads(out.stdout.strip() or "{}")
        for k in ("cpu","gpu","mobo","os","nic"):
            if d.get(k): ident[k] = str(d[k]).strip()
        spd, typ = d.get("ramSpeed"), d.get("ramType")
        gen = {20:"DDR",21:"DDR2",24:"DDR3",26:"DDR4",34:"DDR5"}.get(typ,"DDR")
        if spd: ident["ramSpec"] = f"{gen}-{int(spd)}"
        if d.get("ramTotal"): ident["ramTotal"] = int(d["ramTotal"])
    except Exception:
        pass
    _IDENT = ident
    return ident

# ---------------------------------------------------------------- 동적 실측값 (성능카운터)
def read_dynamic():
    try:
        out = subprocess.run(
            ["powershell","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",PS1],
            capture_output=True, text=True, timeout=8.0)
        return json.loads(out.stdout.strip() or "{}")
    except Exception:
        return {}

# ---------------------------------------------------------------- LibreHardwareMonitor (선택)
def _pnum(s):
    if s is None: return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(s).replace(",", ""))
    return float(m.group()) if m else None

_LHM_LAST = {"flat": None, "t": 0.0}
def read_lhm():
    """LHM Remote Web Server(:8085)가 켜져 있으면 센서 트리를 평탄화, 아니면 None.
    일시적 실패 땐 최근 성공값을 잠깐 유지 → 값/배너 깜빡임 방지."""
    def recent():
        return _LHM_LAST["flat"] if (_LHM_LAST["flat"] is not None and time.time() - _LHM_LAST["t"] < 8) else None
    try:                                              # 아무도 안 듣고 있으면 즉시 포기(프록시/타임아웃 스톨 방지)
        socket.create_connection(("127.0.0.1", 8085), 0.35).close()
    except Exception:
        return recent()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(LHM_URL, timeout=3.5) as r:
            tree = json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return recent()
    flat = []
    def walk(node, hw, depth):
        img = (node.get("ImageURL", "") or "").lower()
        text = node.get("Text", "")
        if depth == 1: hw = {"name": text, "img": img}
        v = _pnum(node.get("Value")); t = node.get("Type", "")
        if v is not None and t:
            flat.append((hw or {"name": "", "img": ""}, text, t, v))
        for ch in node.get("Children", []): walk(ch, hw, depth + 1)
    walk(tree, None, 0)
    _LHM_LAST["flat"] = flat
    _LHM_LAST["t"] = time.time()
    return flat

def _lpick(flat, typ, hwkw=None, textkw=None):
    for hw, text, t, v in flat:
        if t != typ: continue
        if hwkw and hwkw.lower() not in hw["name"].lower(): continue
        if textkw:
            kws = textkw if isinstance(textkw, (list, tuple)) else [textkw]
            if not any(k.lower() in text.lower() for k in kws): continue
        return v
    return None

_FAN_SEEN = set()   # 한 번이라도 돈 팬 이름 (안 쓰는 0 RPM 헤더만 숨기고 목록은 안정 유지)
def lhm_fill(payload, flat):
    """LHM 값으로 N/A 자리(CPU 온도·전력, 팬 RPM, 디스크·핫스팟 온도)를 채운다."""
    # CPU 하드웨어 이름은 벤더마다 다르므로(예: 'Intel Core Ultra 7 265KF') hw 필터 대신 센서 이름으로 매칭
    cput = _lpick(flat, "Temperature", None, ["CPU Package"]) or _lpick(flat, "Temperature", None, ["Core Average", "Core Max", "Core (Tctl"])
    cpup = _lpick(flat, "Power", None, ["CPU Package", "Package"])
    ghot = _lpick(flat, "Temperature", None, ["Hot Spot", "Hotspot"]) or _lpick(flat, "Temperature", None, ["Junction"])
    # 팬: 계속 0 RPM 인 안 쓰는 헤더는 숨김. 단, 한 번이라도 돌았거나(유휴정지 표시 유지)
    # GPU 팬이면 유지 → 목록이 안정적이라 깜빡이지 않음.
    all_fans = [(text, v) for hw, text, t, v in flat if t == "Fan"]
    for nm, v in all_fans:
        if v and v > 0: _FAN_SEEN.add(nm)
    fans = [{"name": nm, "rpm": v} for nm, v in all_fans
            if (v and v > 0) or nm in _FAN_SEEN or "gpu" in nm.lower()]
    dtemps = [v for hw, text, t, v in flat
              if t == "Temperature" and ("composite temperature" in text.lower()
                                         or any(k in hw["img"] for k in ("hdd", "ssd", "nvme", "disk")))]
    if cput is not None: payload["cpu"]["temp"] = cput
    if cpup is not None: payload["cpu"]["power"] = cpup
    if ghot is not None: payload["gpu"]["hotspot"] = ghot
    for i, d in enumerate(payload["drives"]):
        if i < len(dtemps): d["temp"] = dtemps[i]
    if fans:
        payload["fans"] = fans
        payload["meta"]["fanNames"] = [f["name"] for f in fans]
    payload["meta"]["lhm"] = True
    payload["meta"]["avail"] = {
        "cpuTemp": cput is not None, "cpuPower": cpup is not None,
        "fans": bool(fans), "driveTemp": bool(dtemps), "gpuHotspot": ghot is not None,
    }
    return payload

# ---------------------------------------------------------------- 페이로드 조립
def build_sensors():
    ident = read_identity()
    dyn   = read_dynamic()
    g     = read_nvidia()
    cores = dyn.get("cpuCores") or []
    clk   = dyn.get("cpuClock")

    payload = {
        "meta": {
            "mode": "real",
            "lhm": False,
            "host": ident.get("host"), "os": ident.get("os"),
            "cpu":  ident.get("cpu"),
            "gpu":  g.get("name") or ident.get("gpu"),
            "mobo": ident.get("mobo"),
            "ramSpec": ident.get("ramSpec"),
            "ramTotal": dyn.get("ramTotal") or ident.get("ramTotal"),
            "vramTotal": g.get("vramTotal"),
            "nic": ident.get("nic"),
            "coreCount": (len(cores) or None),
            "driveNames": [d["name"] for d in (dyn.get("drives") or [])],
            "fanNames": [],
            # 읽을 수 없는 것 → 대시보드가 N/A 로 표시
            "avail": {"cpuTemp": False, "cpuPower": False, "fans": False,
                      "driveTemp": False, "gpuHotspot": False},
        },
        "cpu": {
            "temp": None, "power": None,                       # LHM 필요
            "load": dyn.get("cpuLoad"),
            "clock": (clk/1000.0) if clk else None,            # MHz → GHz
            "cores": [{"load": v} for v in cores],
        },
        "gpu": {
            "temp": g.get("temp"), "hotspot": None,            # nvidia-smi 는 hotspot 미제공
            "load": g.get("load"), "clock": g.get("clock"),
            "memClock": g.get("memClock"), "power": g.get("power"),
            "vramUsed": g.get("vramUsed"), "vramTotal": g.get("vramTotal"),
            "fan": g.get("fanPct"),                            # % (RPM 아님 → 대시보드가 % 로 표기)
        },
        "ram": {"used": dyn.get("ramUsed"), "total": dyn.get("ramTotal"),
                "commit": dyn.get("ramCommit"), "cache": dyn.get("ramCache")},
        "drives": [{"name": d["name"], "temp": None, "used": d["used"]}
                   for d in (dyn.get("drives") or [])],        # 온도는 LHM 필요
        "fans": [],                                            # RPM 은 LHM 필요
        "net": {"down": dyn.get("netDown"), "up": dyn.get("netUp")},
    }
    lhm = read_lhm()                       # LHM 켜져 있으면 N/A 자리를 실측으로 채움
    if lhm: lhm_fill(payload, lhm)
    return payload

# ---------------------------------------------------------------- 백그라운드 새로고침
# 센서 수집(PowerShell/nvidia-smi)은 수 초 걸리므로, 백그라운드 스레드가 계속 스냅샷을
# 갱신하고 /sensors 는 캐시된 스냅샷을 '즉시' 돌려준다 (HTTP 응답 지연/타임아웃 제거).
_SNAP = {"data": None}
_SNAP_LOCK = threading.Lock()
def _refresh_loop():
    # build_sensors() 는 매번 powershell.exe(내부 Get-Counter 로 ~1초 블록) + nvidia-smi 를 새로
    # 띄운다 — 프로세스 생성 자체가 CPU/일시 RAM을 크게 쓴다. 대시보드는 1초에 한 번만 읽어가므로
    # 갱신 주기를 넉넉히 벌려(sleep) 프로세스 생성 빈도를 낮춘다(하드웨어 모니터엔 ~2초 갱신이면 충분).
    while True:
        try:
            snap = build_sensors()
            with _SNAP_LOCK: _SNAP["data"] = snap
        except Exception:
            pass
        time.sleep(1.2)
def get_snapshot():
    with _SNAP_LOCK: return _SNAP["data"]

# ---------------------------------------------------------------- HTTP (같은 오리진 서빙)
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass   # 클라이언트가 응답 도중 끊음 — 무해

    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p.startswith("/setup/lhm"):
            # CSRF 방지: 같은 오리진(대시보드)에서 온 요청만 허용 — 아무 웹페이지가
            # <img src=".../setup/lhm"> 로 설치 스크립트를 트리거하지 못하게 막는다.
            sfs = self.headers.get("Sec-Fetch-Site")
            origin = self.headers.get("Origin", "")
            allowed = ("", f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}")
            if (sfs and sfs not in ("same-origin", "none")) or origin not in allowed:
                self._send(403, json.dumps({"ok": False, "error": "cross-site request 거부"}), "application/json; charset=utf-8"); return
            # 대시보드 '자동 설치' 버튼 → 로컬 설치 스크립트를 분리 실행(관리자 승인은 UAC로)
            try:
                ps1 = os.path.join(HERE, "setup_lhm.ps1")
                subprocess.Popen(["powershell","-NoProfile","-ExecutionPolicy","Bypass","-File",ps1],
                                 creationflags=getattr(subprocess, "DETACHED_PROCESS", 0x00000008))
                self._send(200, json.dumps({"ok": True, "msg": "설치 스크립트를 시작했습니다. UAC(관리자) 창을 승인하세요."}),
                           "application/json; charset=utf-8")
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "error": str(e)}), "application/json; charset=utf-8")
            return
        if p.startswith("/sensors/raw"):
            dump = {"identity": read_identity(), "dynamic": read_dynamic(),
                    "nvidia": read_nvidia(), "lhm": read_lhm()}
            self._send(200, json.dumps(dump, ensure_ascii=False, indent=2), "application/json; charset=utf-8"); return
        if p.startswith("/sensors"):
            snap = get_snapshot()
            if snap is None:                       # 첫 스냅샷 준비 전 — 빠른 503(느린 즉석수집/연결끊김 방지)
                self._send(503, json.dumps({"warming": True}), "application/json; charset=utf-8"); return
            self._send(200, json.dumps(snap, ensure_ascii=False), "application/json; charset=utf-8")
            return
        rel = (p.lstrip("/") or "dashboard.html")
        fp = os.path.normpath(os.path.join(HERE, rel))
        if not (fp == HERE or fp.startswith(HERE + os.sep)) or not os.path.isfile(fp):
            self._send(404, "not found", "text/plain"); return
        ctype = "text/html; charset=utf-8" if fp.endswith(".html") else "application/octet-stream"
        with open(fp, "rb") as f: self._send(200, f.read(), ctype)

    def log_message(self, *a): pass

class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        if isinstance(e, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return   # 클라이언트가 응답 도중 끊음 — 트레이스백 안 찍음
        super().handle_error(request, client_address)

if __name__ == "__main__":
    idn = read_identity()
    print("[HW ] CPU  =", idn.get("cpu","?"))
    print("[HW ] GPU  =", idn.get("gpu","?"))
    print("[HW ] MOBO =", idn.get("mobo","?"))
    print("[HW ] RAM  =", idn.get("ramSpec","?"), idn.get("ramTotal","?"), "GB   |  NIC =", idn.get("nic","?"))
    print(f"[collector] http://localhost:{PORT}/          <- dashboard (auto real-sensor mode)")
    print(f"[collector] http://localhost:{PORT}/sensors   <- live JSON")
    threading.Thread(target=_refresh_loop, daemon=True).start()   # 백그라운드로 스냅샷 갱신
    QuietServer(("127.0.0.1", PORT), Handler).serve_forever()
