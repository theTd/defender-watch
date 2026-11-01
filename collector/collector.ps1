#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$ConvertOnly,
    [Parameter(Position = 0)][string]$InputPath,
    [Parameter(Position = 1)][string]$OutputPath,
    [string]$DataDir,
    [int]$AppPid = 0
)

$ErrorActionPreference = 'Stop'
$CollectorVersion = '0.1.0'
$script:LogPath = $null

function Write-CollectorLog {
    param([string]$Message)
    if (-not $script:LogPath) { return }
    try {
        $log = [IO.FileInfo]::new($script:LogPath)
        if ($log.Exists -and $log.Length -gt 524288) {
            $old = $script:LogPath + '.old'
            Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $script:LogPath -Destination $old -Force -ErrorAction SilentlyContinue
        }
        $line = [DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine
        [IO.File]::AppendAllText($script:LogPath, $line, [Text.UTF8Encoding]::new($false))
    } catch {
        # Logging must never take the collector down.
    }
}

function Write-Utf8Json {
    param([string]$Path, $Value)
    $json = $Value | ConvertTo-Json -Depth 100 -Compress
    $temp = $Path + '.tmp.' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    try {
        [IO.File]::Move($temp, $Path, $true)
    } catch {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Clamp-Int {
    param($Value, [int]$Default, [int]$Minimum, [int]$Maximum)
    if ($null -eq $Value) { return $Default }
    $number = 0.0
    $text = [string]$Value
    if (-not [double]::TryParse($text, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $Default
    }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return $Default }
    $rounded = [int][Math]::Round($number)
    if ($rounded -lt $Minimum) { return $Minimum }
    if ($rounded -gt $Maximum) { return $Maximum }
    return $rounded
}

function Read-CollectorSettings {
    param([string]$Folder)
    $result = [ordered]@{ recordSeconds = 60; pauseSeconds = 120; retentionDays = 7 }
    $path = Join-Path $Folder 'settings.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $result }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
        if ($null -eq $raw) { return $result }
        if ($null -ne $raw.recordSeconds) {
            $result.recordSeconds = Clamp-Int $raw.recordSeconds 60 15 300
        }
        if ($null -ne $raw.pauseSeconds) {
            $result.pauseSeconds = Clamp-Int $raw.pauseSeconds 120 0 3600
        }
        if ($null -ne $raw.retentionDays) {
            $result.retentionDays = Clamp-Int $raw.retentionDays 7 1 90
        }
    } catch {
        Write-CollectorLog ('settings.json could not be parsed; defaults will be used: ' + $_.Exception.Message)
    }
    return $result
}

function Test-AppAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return -not $process.HasExited
    } catch {
        return $false
    }
}

function Write-Status {
    param(
        [string]$State,
        $LastWindow,
        $NextWindowAt,
        [string]$LastError
    )
    $payload = [ordered]@{
        state = $State
        lastWindow = $LastWindow
        nextWindowAt = $NextWindowAt
        lastError = $LastError
        realTimeProtection = $script:RealTimeProtection
        pid = $PID
        version = $CollectorVersion
    }
    try {
        Write-Utf8Json (Join-Path $script:DataDir 'status.json') $payload
    } catch {
        Write-CollectorLog ('status.json write failed: ' + $_.Exception.Message)
    }
}

function Format-DisplayPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $p = $Path.Trim() -replace '/', '\'
    if ($p -match '^[A-Za-z]:') {
        $p = $p.Substring(0, 1).ToUpperInvariant() + $p.Substring(1)
    }
    if ($p.Length -gt 3) {
        $p = $p.TrimEnd('\')
    }
    return $p
}

function Test-AbsoluteSegment {
    param([string]$Segment)
    return (($Segment -match '^[A-Za-z]:[\\/]') -or $Segment.StartsWith('\\'))
}

function Join-DisplayPath {
    param([string]$Prefix, [string]$Segment)
    if ([string]::IsNullOrWhiteSpace($Segment)) { return $Prefix }
    $segmentValue = $Segment.Trim() -replace '/', '\'
    if (Test-AbsoluteSegment $segmentValue) {
        return Format-DisplayPath $segmentValue
    }
    if ([string]::IsNullOrWhiteSpace($Prefix)) {
        return Format-DisplayPath $segmentValue
    }
    return Format-DisplayPath ($Prefix.TrimEnd('\') + '\' + $segmentValue.Trim('\'))
}

function Get-PathDepth {
    param([string]$Path)
    if ($Path -eq 'AMSI memory scans') { return 1 }
    $p = $Path.TrimEnd('\')
    if ($p -match '^[A-Za-z]:$') { return 1 }
    return @(($p -split '\\') | Where-Object { $_ -ne '' }).Count
}

function Add-LeafPath {
    param($Node, [string]$Prefix)
    $full = Join-DisplayPath $Prefix ([string]$Node.Path)
    $children = @($Node.Folder | Where-Object { $null -ne $_ })
    if ($children.Count -gt 0) {
        foreach ($child in $children) {
            Add-LeafPath $child $full
        }
        return
    }
    $seconds = [Math]::Round(([double]$Node.TotalDuration / 10000000.0), 7)
    $maxSeconds = [Math]::Round(([double]$Node.MaxDuration / 10000000.0), 7)
    $script:LeafPaths.Add([ordered]@{
        path = $full
        depth = (Get-PathDepth $full)
        seconds = $seconds
        count = [int64]$Node.Count
        maxSeconds = $maxSeconds
    })
}

function Get-FlattenedPaths {
    param($Report)
    $script:LeafPaths = [Collections.Generic.List[object]]::new()
    $amsiSeconds = 0.0
    $amsiCount = 0L
    $amsiMax = 0.0
    foreach ($root in @($Report.TopPaths)) {
        if ($null -eq $root) { continue }
        $rootName = [string]$root.Path
        if ($rootName.StartsWith('MemScanVfz-AMSI-', [StringComparison]::OrdinalIgnoreCase)) {
            $amsiSeconds += ([double]$root.TotalDuration / 10000000.0)
            $amsiCount += [int64]$root.Count
            $amsiMax = [Math]::Max($amsiMax, [double]$root.MaxDuration)
            continue
        }
        Add-LeafPath $root ''
    }
    if ($amsiCount -gt 0 -or $amsiSeconds -gt 0) {
        $script:LeafPaths.Add([ordered]@{
            path = 'AMSI memory scans'
            depth = 1
            seconds = [Math]::Round($amsiSeconds, 7)
            count = $amsiCount
            maxSeconds = [Math]::Round(($amsiMax / 10000000.0), 7)
        })
    }
    return @($script:LeafPaths | Sort-Object -Property @{ Expression = { $_.seconds }; Descending = $true }, @{ Expression = { $_.path }; Descending = $false })
}

function Convert-ProcessEntries {
    param($Report)
    return @(@($Report.TopProcesses) | Where-Object { $null -ne $_ } | ForEach-Object {
        [ordered]@{
            path = [string]$_.ProcessPath
            seconds = [Math]::Round(([double]$_.TotalDuration / 10000000.0), 7)
            count = [int64]$_.Count
            maxSeconds = [Math]::Round(([double]$_.MaxDuration / 10000000.0), 7)
        }
    } | Sort-Object -Property @{ Expression = { $_.seconds }; Descending = $true }, @{ Expression = { $_.path }; Descending = $false })
}

function Convert-ExtensionEntries {
    param($Report)
    return @(@($Report.TopExtensions) | Where-Object { $null -ne $_ } | ForEach-Object {
        [ordered]@{
            extension = [string]$_.Extension
            seconds = [Math]::Round(([double]$_.TotalDuration / 10000000.0), 7)
            count = [int64]$_.Count
            maxSeconds = [Math]::Round(([double]$_.MaxDuration / 10000000.0), 7)
        }
    } | Sort-Object -Property @{ Expression = { $_.seconds }; Descending = $true }, @{ Expression = { $_.extension }; Descending = $false })
}

function Convert-FileEntries {
    param($Report)
    return @(@($Report.TopFiles) | Where-Object { $null -ne $_ } | ForEach-Object {
        [ordered]@{
            path = [string]$_.Path
            seconds = [Math]::Round(([double]$_.TotalDuration / 10000000.0), 7)
            count = [int64]$_.Count
            maxSeconds = [Math]::Round(([double]$_.MaxDuration / 10000000.0), 7)
        }
    } | Sort-Object -Property @{ Expression = { $_.seconds }; Descending = $true }, @{ Expression = { $_.path }; Descending = $false })
}

function Convert-ReportToWindow {
    param($Report, [DateTime]$Start, [DateTime]$End, [int]$RecordSeconds)
    $total = 0.0
    foreach ($root in @($Report.TopPaths)) {
        if ($null -ne $root) { $total += ([double]$root.TotalDuration) }
    }
    $window = [ordered]@{
        schema = 1
        start = $Start.ToUniversalTime().ToString('o')
        end = $End.ToUniversalTime().ToString('o')
        recordSeconds = $RecordSeconds
        totalScanSeconds = [Math]::Round(($total / 10000000.0), 7)
        paths = Get-FlattenedPaths $Report
        processes = Convert-ProcessEntries $Report
        extensions = Convert-ExtensionEntries $Report
        files = Convert-FileEntries $Report
        collectorSeconds = 0
    }
    return $window
}

function Convert-StringArray {
    param($Value)
    return @(@($Value) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' })
}

function Update-Exclusions {
    try {
        $preference = Get-MpPreference -ErrorAction Stop
        $payload = [ordered]@{
            paths = Convert-StringArray $preference.ExclusionPath
            processes = Convert-StringArray $preference.ExclusionProcess
            extensions = Convert-StringArray $preference.ExclusionExtension
            updatedAt = [DateTime]::UtcNow.ToString('o')
        }
        Write-Utf8Json (Join-Path $script:DataDir 'exclusions.json') $payload
    } catch {
        Write-CollectorLog ('Get-MpPreference failed; keeping the previous exclusions file: ' + $_.Exception.Message)
    }
    # With real-time protection off Defender scans nothing, so every window would be empty.
    try {
        $script:RealTimeProtection = [bool](Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled
    } catch {
        $script:RealTimeProtection = $null
        Write-CollectorLog ('Get-MpComputerStatus failed: ' + $_.Exception.Message)
    }
}

function Remove-OldFiles {
    param([int]$RetentionDays)
    $cutoff = [DateTime]::UtcNow.AddDays(-$RetentionDays)
    foreach ($folder in @((Join-Path $script:DataDir 'windows'), (Join-Path $script:DataDir 'cpu'))) {
        if (-not (Test-Path -LiteralPath $folder)) { continue }
        Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    }
}

function Start-CpuSampler {
    param([string]$Folder, [int]$RetentionDays)
    $cpuFolder = Join-Path $Folder 'cpu'
    New-Item -ItemType Directory -Force -Path $cpuFolder | Out-Null
    return Start-ThreadJob -ArgumentList @($cpuFolder, $RetentionDays) -ScriptBlock {
        param($CpuFolder, $RetentionDays)
        $lastPrune = [DateTime]::MinValue
        while ($true) {
            try {
                $sample = Get-Counter '\Process(MsMpEng)\% Processor Time' -MaxSamples 1 -ErrorAction Stop
                $sum = 0.0
                foreach ($counter in @($sample.CounterSamples)) {
                    if ($null -ne $counter) { $sum += [double]$counter.CookedValue }
                }
                $pct = [Math]::Round([Math]::Max(0.0, [Math]::Min(100.0, $sum / [Environment]::ProcessorCount)), 2)
                $now = [DateTime]::UtcNow
                $file = Join-Path $CpuFolder ($now.ToString('yyyy-MM-dd') + '.jsonl')
                $line = ([ordered]@{ t = $now.ToString('o'); pct = $pct } | ConvertTo-Json -Compress) + [Environment]::NewLine
                [IO.File]::AppendAllText($file, $line, [Text.UTF8Encoding]::new($false))
                if (($now - $lastPrune).TotalMinutes -ge 60) {
                    $lastPrune = $now
                    $cutoff = $now.AddDays(-$RetentionDays)
                    Get-ChildItem -LiteralPath $CpuFolder -File -Filter '*.jsonl' -ErrorAction SilentlyContinue |
                        Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
                        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
                }
            } catch {
                # A transient counter failure is skipped; the next sample tries again.
            }
            Start-Sleep -Seconds 5
        }
    }
}

function Start-Watchdog {
    param([int]$ProcessId, [string]$Folder, [string]$StopPath)
    return Start-ThreadJob -ArgumentList @($ProcessId, $Folder, $StopPath) -ScriptBlock {
        param($ProcessId, $Folder, $StopPath)
        $statusPath = Join-Path $Folder 'status.json'
        $wpr = Join-Path $env:SystemRoot 'System32\wpr.exe'
        while ($true) {
            $alive = $false
            try {
                $process = Get-Process -Id $ProcessId -ErrorAction Stop
                $alive = -not $process.HasExited
            } catch {
                $alive = $false
            }
            $stopRequested = Test-Path -LiteralPath $StopPath
            if ($stopRequested -or -not $alive) {
                if ($stopRequested) {
                    Remove-Item -LiteralPath $StopPath -Force -ErrorAction SilentlyContinue
                }
                try {
                    if (Test-Path -LiteralPath $wpr) {
                        $null = & $wpr -cancel 2>&1
                    }
                } catch {
                    # There may be no active WPR session.
                }
                Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
                [Environment]::Exit(0)
            }
            Start-Sleep -Seconds 2
        }
    }
}

$nowUtc = [DateTime]::UtcNow

if ($ConvertOnly) {
    if ([string]::IsNullOrWhiteSpace($InputPath) -or [string]::IsNullOrWhiteSpace($OutputPath)) {
        throw 'ConvertOnly needs an input report.json path and an output window JSON path.'
    }
    $inputFile = [IO.Path]::GetFullPath($InputPath)
    $outputFile = [IO.Path]::GetFullPath($OutputPath)
    $report = Get-Content -LiteralPath $inputFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $start = $nowUtc.AddSeconds(-90)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $window = Convert-ReportToWindow -Report $report -Start $start -End $nowUtc -RecordSeconds 90
    $window.collectorSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
    Write-Utf8Json $outputFile $window
    Write-Output $outputFile
    exit 0
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    throw 'Normal mode needs -DataDir.'
}
if ($DataDir -notmatch '^[A-Za-z]:\\') {
    throw 'The data folder must be an absolute local drive path.'
}
$script:DataDir = [IO.Path]::GetFullPath($DataDir)
if (-not $script:DataDir.StartsWith([IO.Path]::GetPathRoot($script:DataDir), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The data folder is not on a local absolute path.'
}
New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $script:DataDir 'windows') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $script:DataDir 'cpu') | Out-Null
$script:LogPath = Join-Path $script:DataDir 'collector.log'

if ($AppPid -le 0) {
    Write-Status 'error' $null $null 'Collector was started without a valid app PID.'
    exit 1
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Status 'error' $null $null 'The collector needs administrator rights. Use Start collector in Defender Watch.'
    Write-CollectorLog 'Refusing to run because the process is not elevated.'
    exit 2
}

$mutex = $null
try {
    $createdNew = $false
    $mutex = [Threading.Mutex]::new($false, 'Local\DefenderWatchCollector', [ref]$createdNew)
    if (-not $mutex.WaitOne(0)) {
        Write-CollectorLog 'Another Defender Watch collector is already running in this session.'
        exit 0
    }
} catch [Threading.AbandonedMutexException] {
    # The previous collector died while holding the mutex. Continue.
} catch {
    Write-CollectorLog ('Could not create the single-instance mutex: ' + $_.Exception.Message)
}

$triggerPath = Join-Path $script:DataDir 'record-now.request'
$stopPath = Join-Path $script:DataDir 'stop.request'
$statusPath = Join-Path $script:DataDir 'status.json'
$lastWindow = $null
$cpuJob = $null
$watchJob = $null

try {
    Write-CollectorLog ('Collector started. pid=' + $PID + ' appPid=' + $AppPid + ' data=' + $script:DataDir)
    $initialSettings = Read-CollectorSettings $script:DataDir
    Update-Exclusions
    Remove-OldFiles $initialSettings.retentionDays
    try {
        $cpuJob = Start-CpuSampler $script:DataDir $initialSettings.retentionDays
    } catch {
        Write-CollectorLog ('CPU sampler could not start: ' + $_.Exception.Message)
    }
    try {
        $watchJob = Start-Watchdog $AppPid $script:DataDir $stopPath
    } catch {
        Write-CollectorLog ('Parent watchdog could not start: ' + $_.Exception.Message)
    }

    while ($true) {
        if (Test-Path -LiteralPath $stopPath) {
            Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
            break
        }
        if (-not (Test-AppAlive $AppPid)) { break }

        $settings = Read-CollectorSettings $script:DataDir
        $immediateStart = $false
        if (Test-Path -LiteralPath $triggerPath) {
            Remove-Item -LiteralPath $triggerPath -Force -ErrorAction SilentlyContinue
            $immediateStart = $true
        }
        Update-Exclusions

        $recordStart = [DateTime]::UtcNow
        $etlPath = Join-Path ([IO.Path]::GetTempPath()) ('DefenderWatch-' + [Guid]::NewGuid().ToString('N') + '.etl')
        Write-Status 'recording' $lastWindow $null ''
        $recordingSucceeded = $false
        $nextAt = $null
        $failure = ''
        try {
            $null = New-MpPerformanceRecording -RecordTo $etlPath -Seconds $settings.recordSeconds -ErrorAction Stop
            $report = Get-MpPerformanceReport -Path $etlPath -TopPaths 60 -TopPathsDepth 6 -TopProcesses 30 -TopExtensions 30 -TopFiles 60 -Raw -ErrorAction Stop
            $overhead = [Diagnostics.Stopwatch]::StartNew()
            $end = [DateTime]::UtcNow
            $window = Convert-ReportToWindow -Report $report -Start $recordStart -End $end -RecordSeconds $settings.recordSeconds
            $window.collectorSeconds = [Math]::Round($overhead.Elapsed.TotalSeconds, 3)
            $fileName = $recordStart.ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '.json'
            $windowPath = Join-Path (Join-Path $script:DataDir 'windows') $fileName
            Write-Utf8Json $windowPath $window
            $lastWindow = $window.end
            $recordingSucceeded = $true
            Remove-OldFiles $settings.retentionDays
            $nextAt = [DateTime]::UtcNow.AddSeconds($settings.pauseSeconds).ToString('o')
            Write-Status 'idle' $lastWindow $nextAt ''
            Write-CollectorLog ('Window written: ' + $fileName + ' paths=' + @($window.paths).Count + ' scanSeconds=' + $window.totalScanSeconds)
        } catch {
            $failure = $_.Exception.Message
            if ([string]::IsNullOrWhiteSpace($failure)) { $failure = 'Unknown recording error.' }
            Write-Status 'error' $lastWindow $null $failure
            Write-CollectorLog ('Recording cycle failed: ' + $failure)
            $nextAt = [DateTime]::UtcNow.AddSeconds($settings.pauseSeconds).ToString('o')
        } finally {
            Remove-Item -LiteralPath $etlPath -Force -ErrorAction SilentlyContinue
        }

        if (-not $recordingSucceeded) {
            Write-Status 'error' $lastWindow $nextAt $failure
        }

        $deadline = [DateTime]::UtcNow.AddSeconds($settings.pauseSeconds)
        $startNow = $immediateStart
        $stopCollector = $false
        while (-not $startNow -and [DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $stopPath) {
                Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
                $stopCollector = $true
                break
            }
            if (-not (Test-AppAlive $AppPid)) {
                $stopCollector = $true
                break
            }
            if (Test-Path -LiteralPath $triggerPath) {
                Remove-Item -LiteralPath $triggerPath -Force -ErrorAction SilentlyContinue
                $startNow = $true
                break
            }
            Start-Sleep -Seconds 2
        }
        if ($stopCollector) { break }
    }
} finally {
    foreach ($job in @($watchJob, $cpuJob)) {
        if ($null -ne $job) {
            try { Stop-Job -Job $job -ErrorAction SilentlyContinue } catch {}
            try { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $triggerPath -Force -ErrorAction SilentlyContinue
    Write-CollectorLog 'Collector stopped.'
    if ($null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        try { $mutex.Dispose() } catch {}
    }
}

[Environment]::Exit(0)
