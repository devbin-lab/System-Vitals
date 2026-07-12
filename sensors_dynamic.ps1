# 실제 동적 센서값 수집 (설치 불필요: Windows 성능 카운터 + WMI). JSON 한 줄 출력.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

# CPU(전체+코어별 사용률, 터보 클럭) + 네트워크(처리량) 를 1초 샘플 1회로
$counters = @(
  '\Processor(*)\% Processor Time',
  '\Processor Information(_Total)\% Processor Performance',
  '\Network Interface(*)\Bytes Received/sec',
  '\Network Interface(*)\Bytes Sent/sec'
)
$cs = (Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples 1).CounterSamples

$total = ($cs | Where-Object { $_.Path -like '*\processor(_total)\% processor time' }).CookedValue
$cores = @($cs | Where-Object { $_.Path -like '*\processor(*)\% processor time' -and $_.InstanceName -match '^\d+$' } |
           Sort-Object { [int]$_.InstanceName } | ForEach-Object { [math]::Round($_.CookedValue) })
$perf  = ($cs | Where-Object { $_.Path -like '*% processor performance' }).CookedValue
$base  = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty MaxClockSpeed)
$clk   = if ($perf) { [math]::Round($base * $perf / 100) } else { $base }

$rx = ($cs | Where-Object { $_.Path -like '*received/sec*' -and $_.InstanceName -notmatch 'isatap|loopback|teredo|virtual' } |
        Sort-Object CookedValue -Descending | Select-Object -First 1).CookedValue
$tx = ($cs | Where-Object { $_.Path -like '*sent/sec*' -and $_.InstanceName -notmatch 'isatap|loopback|teredo|virtual' } |
        Sort-Object CookedValue -Descending | Select-Object -First 1).CookedValue

$os      = Get-CimInstance Win32_OperatingSystem
$ramUsed = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
$ramTot  = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$commit  = [math]::Round((Get-Counter '\Memory\Committed Bytes' -MaxSamples 1).CounterSamples[0].CookedValue / 1GB, 1)
$cache   = [math]::Round((Get-Counter '\Memory\Cache Bytes'     -MaxSamples 1).CounterSamples[0].CookedValue / 1GB, 1)

# 논리 드라이브(C:, D: ...)를 실제 물리 디스크 모델명(예: Samsung 990 PRO 2TB)에 매핑.
# Win32_LogicalDisk 만으로는 드라이브 문자만 나오므로, Partition->Disk 연결로 실제 이름을 붙인다.
$driveLetterToDiskNum = @{}
try {
  Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
    $driveLetterToDiskNum[[string]$_.DriveLetter] = $_.DiskNumber
  }
} catch {}
$diskLabel = @{}
try {
  Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    $bus = if ($_.BusType -and $_.BusType -ne 'Unknown') { " ($($_.BusType))" } else { '' }
    $nm  = if ($_.FriendlyName) { "$($_.FriendlyName)$bus" } else { $null }
    if ($nm) { $diskLabel[[string]$_.DeviceId] = $nm }
  }
} catch {}

$drives = @()
foreach ($v in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
  if ($v.Size -gt 0) {
    $letter = $v.DeviceID.TrimEnd(':')
    $label  = $v.DeviceID
    if ($driveLetterToDiskNum.ContainsKey($letter)) {
      $dnum = [string]$driveLetterToDiskNum[$letter]
      if ($diskLabel.ContainsKey($dnum)) { $label = $diskLabel[$dnum] }
    }
    $drives += [pscustomobject]@{ name = $label; used = [math]::Round(($v.Size - $v.FreeSpace) / $v.Size * 100) }
  }
}

[ordered]@{
  cpuLoad   = [math]::Round($total, 1)
  cpuCores  = $cores
  cpuClock  = $clk
  ramUsed   = $ramUsed
  ramTotal  = $ramTot
  ramCommit = $commit
  ramCache  = $cache
  netDown   = [math]::Round(($rx * 8) / 1e6, 1)
  netUp     = [math]::Round(($tx * 8) / 1e6, 1)
  drives    = $drives
} | ConvertTo-Json -Compress -Depth 4
