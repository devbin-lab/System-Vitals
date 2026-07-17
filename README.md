<div align="center">

<img src="build/icon.png" width="96" alt="System Vitals" />

# System Vitals

**전용 서브모니터를 위한 실시간 PC 하드웨어 모니터링 대시보드**

CPU · GPU · 메모리 · 전력 · 스토리지 · 팬 · 네트워크를 한 화면에서.
Windows · Electron · 설치 없이 실측(선택적 LibreHardwareMonitor 연동).

</div>

---

## 주요 기능

- **실시간 실측 센서** — `nvidia-smi`(GPU) + Windows 성능 카운터/WMI(CPU·RAM·네트워크·디스크 사용률·부품 신원) + *(선택)* LibreHardwareMonitor(CPU 온도·전력, 메인보드 팬 RPM, 디스크 온도). 읽을 수 있는 것만 표시하고, 없는 값은 가짜로 채우지 않습니다.
- **커스텀 위젯 시스템** — 안드로이드 홈 위젯처럼 격자에 배치하고 모서리로 크기를 조절합니다. 원그래프 게이지, CPU/GPU 종합 패널, 전력·네트워크 꺾은선 그래프, 코어·팬·스토리지 리스트 등 20여 종. 위젯 크기에 맞춰 UI가 자동 최적화됩니다(container query).
- **CPU/GPU 통합 게이지** — 링 길이 = 사용률, 링 색 = 온도 심각도, 중앙 숫자 = 온도. 하나의 원그래프로 “얼마나 바쁜지 + 얼마나 뜨거운지”를 동시에.
- **2-pane 설정 창** — 좌측 네비 + 우측 콘텐츠(모양 · 레이아웃 · 디스플레이 · 일반). 라이트 / 다크 / 시스템 테마, UI 배율 조절.
- **서브모니터 최적화** — 원하는 모니터에만 전체화면으로 고정(작업표시줄까지 덮음), 해상도(FHD · QHD)에 맞춰 자동 정돈. 터치 디스플레이 지원.
- **조건부 자동 실행** — 부팅 시 자동 시작 + **지정한 모니터가 연결될 때만** 그 화면에 표시(없으면 트레이에서 대기, 연결되는 순간 자동 표시). 시스템 트레이로 표시·설정·종료 제어.
- **백그라운드 실행** — 작업표시줄에 버튼을 만들지 않습니다. 대시보드는 서브모니터에만 뜨고, 제어는 트레이와 설정(⚙) 창으로.
- **인앱 업데이트** — 설정 → 일반 탭에서 GitHub 최신 릴리즈를 확인하고, **"다운로드 후 설치"** 버튼으로 앱 안에서 바로 받아 설치까지. 설치본은 진행률 표시 후 설치 프로그램 자동 실행, 포터블은 다운로드 후 폴더 열기. 기어(⚙)에 새 버전 알림 점 표시. (서명 없는 빌드라 SmartScreen 경고 1회는 불가피)
- **가벼움** — GPU 가속 off + 상시 애니메이션 정리로 CPU/RAM 사용을 최소화.

## 요구 사항

- Windows 10 / 11
- Node.js 18+ (Electron 33)
- Python 3 — 실측 수집기 `collector.py`용. Windows 기본 도구만 사용하므로 별도 설치 불필요
- *(선택)* NVIDIA 드라이버 — GPU 실측(`nvidia-smi`)
- *(선택)* [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) — CPU 온도/전력 · 메인보드 팬 · 디스크 온도

## 실행

```bash
npm install
npm run dev
```

지정한 서브모니터에 대시보드가 전체화면으로 뜹니다.
브라우저로만 보려면 수집기를 직접 실행하세요:

```bash
python collector.py     # → http://localhost:8788/
```

## LibreHardwareMonitor 연동 *(선택)*

CPU 온도·전력, 메인보드 팬 RPM, 디스크 온도는 Windows 기본 API로는 노출되지 않습니다.
LibreHardwareMonitor를 **관리자 권한**으로 실행하고 *Remote Web Server*(포트 8085)를 켜면 자동으로 연동됩니다. 대시보드 상단 안내 배너에서 자동 설치도 가능합니다.

## 빌드 (설치 파일)

```bash
npm run dist            # portable + nsis 설치 파일
npm run dist:portable   # portable 단일 exe
```

앱 아이콘: `build/icon.ico`

## 구조

| 파일 | 역할 |
|---|---|
| `collector.py` | 백그라운드 스레드가 센서 스냅샷을 갱신하고, `http://127.0.0.1:8788` 에서 대시보드와 `/sensors` JSON을 같은 오리진으로 서빙 |
| `sensors_dynamic.ps1` | Windows 성능 카운터 · WMI로 CPU · RAM · 네트워크 · 디스크(모델명 포함) 수집 |
| `main.js` | Electron 메인 — 수집기 실행/정리, 지정 모니터 배치, 설정 IPC |
| `preload.js` | contextIsolation 하에서 안전한 패널 제어 API |
| `dashboard.html` | UI 전체(단일 파일, 인라인 CSS/JS) — 위젯 시스템 · 2-pane 설정 · 테마 |

## 조작

제어는 우하단 **설정(⚙)** 창, 그리고 **시스템 트레이** 아이콘에서 합니다.

- 테마 · UI 배율
- 레이아웃(기본 / 내 위젯) · 위젯 편집
- 디스플레이 선택 · 전체화면(작업표시줄까지 덮기) *(Electron 전용)*
- **부팅 시 자동 실행** · **지정 모니터 연결 시에만 표시** *(Electron 전용)*
- **업데이트 확인**(일반 탭) · 새로고침 · 종료

> 트레이 아이콘: 앱을 표시·설정·종료할 수 있는 창구. 좌클릭 = 표시.
> 창은 **작업표시줄에 표시되지 않습니다**(백그라운드 앱) — 항상 트레이에서 제어합니다.

## 라이선스

MIT © 2026 Bin (휴랑)
