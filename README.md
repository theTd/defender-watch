# Defender Watch

Defender Watch is a portable Windows tray app that shows what Microsoft Defender
(MsMpEng.exe) is scanning, which file paths, processes and file extensions cost
the most CPU, and whether each hot path is already covered by a Defender
exclusion.

It is a Tauri 2 app: a Rust tray shell and a plain HTML/CSS/JavaScript UI. There
is no installer, no network code, no telemetry and no publishing pipeline.

## Portable model

Everything lives in one folder:

    Defender Watch.exe
    data\
      settings.json
      status.json
      exclusions.json
      windows\       one JSON file per recording
      cpu\           one JSONL file per UTC day
      collector.log
      collector.runtime.ps1   only when the collector does not fit on the command line

Copy the executable anywhere the current user can write. Data is stored in a
folder named **data** next to the executable. To use a different folder for
testing, set the environment variable **DEFENDER_WATCH_DATA_DIR** to an absolute
path before starting the app.

Nothing is monitored while the app is closed. The collector is not a Windows
service and no scheduled task is installed. Closing the window hides it in the
tray; quitting from the tray stops the collector. To remove the app, stop the
collector, quit from the tray, and delete the folder. There is no uninstaller.

## Elevation design

The UI is deliberately **not elevated**. Reading Defender's performance
recorder data and exclusions requires administrator rights, so the app starts a
separate elevated PowerShell 7 process through ShellExecuteEx with the
**runas** verb:

- The **Start collector** button asks for UAC once per app session. The
  **Start collector when the app starts** setting (default on) does the same
  automatically on launch.
- **Stop collector** writes a stop request. **Quit** in the tray menu stops the
  collector before exiting.
- The app passes its own PID to the collector. The collector checks every two
  seconds and exits if the app process is gone. This prevents an orphaned
  elevated process when the app is killed.
- Start collector never resolves pwsh.exe from the app folder. It uses PATH or
  the normal PowerShell 7 Program Files location.

Tamper safety: collector.ps1 is embedded in the executable with include_str!.
At build time build.rs computes its SHA-256 and bakes it into the executable as
DEFENDER_WATCH_COLLECTOR_SHA256.

If the encoded collector fits within the Windows command-line limit, it is
passed directly inside a small -EncodedCommand bootstrap. If it does not, the
app writes the script to data\collector.runtime.ps1 and passes only a bootstrap
that:

1. reads the file bytes once;
2. compares their SHA-256 with the build-time hash;
3. runs [ScriptBlock]::Create on that same in-memory string.

It does not dot-source, read the file twice or execute a different path. On a
hash mismatch it writes an error to status.json and exits. A non-admin process
can replace the data-folder file, but the elevated process will not execute it.

An elevated script is not automatically trusted just because it is stored in a
writable folder. This is why the hash is part of the design and not a cosmetic
check.

## What the UI shows

- MsMpEng CPU now and average over the selected interval, as a percentage of
  total CPU and as approximate cores.
- Collector status: not running, starting (UAC pending), running, stale (status
  has not updated for record + pause + 60 seconds) or error.
- A warning when Defender real-time protection is off. Defender then scans
  nothing, so recording windows stay empty; the collector checks this each cycle.
- A CPU trend chart, with recording windows shown as shaded bands.
- Intervals: last window, 15 minutes, 1 hour, 6 hours, 24 hours, 7 days.
- Hot paths from Defender's performance report, rolled up to depth 2–6, with
  scan seconds, scans, share of total scan time, seconds per recorded minute and
  an Excluded / Not excluded badge.
- Processes, extensions and files tabs with exclusion badges.
- Settings for record seconds (15–300), pause seconds (0–3600), retention days
  (1–90), auto-start, and a desktop alert.
- Record now: writes data\record-now.request. The collector checks for it every
  two seconds during pauses and starts a recording immediately.
- Tray icon: tooltip shows the latest MsMpEng CPU sample. The tray menu has
  Open Defender Watch and Quit (stops collector).

The app never adds, changes or removes a Defender exclusion. For each
not-excluded path it copies this command to the clipboard for the user to
review and run themselves:

    Add-MpPreference -ExclusionPath "E:\some\path"

AMSI memory scans are aggregated into one row named **AMSI memory scans**. They
are not a filesystem path, so that row has no exclusion command.

## Collector behaviour

The elevated collector loops:

1. Read settings.json. Only recordSeconds, pauseSeconds and retentionDays are
   used. They are parsed as numbers and clamped. Nothing from the file is
   executed, dot-sourced or used as a path.
2. Ask Defender for exclusions with Get-MpPreference and write exclusions.json.
3. Record with New-MpPerformanceRecording for the configured duration.
4. Read Get-MpPerformanceReport with TopPaths 60, TopPathsDepth 6,
   TopProcesses 30, TopExtensions 30, TopFiles 60 and -Raw.
5. Flatten the path tree, convert 100-nanosecond durations to seconds, group
   AMSI roots, and write one window JSON file.
6. Prune windows and CPU files older than retentionDays.
7. Sleep, checking every two seconds for a trigger file or a stop request.

A second thread job samples the performance counter
\Process(MsMpEng)\% Processor Time every five seconds, including while a
recording runs, divides by the logical processor count and appends
{t, pct} to data\cpu\YYYY-MM-DD.jsonl. CPU sampling is not blocked by the
synchronous recording.

The report's .etl file is temporary and is deleted after every attempt. The
collector fails one cycle at a time; a recording error is written to status.json
and the loop continues. A recording that is already in progress (another WPR
session) is one such error.

## Settings file

    {
      "recordSeconds": 60,
      "pauseSeconds": 120,
      "retentionDays": 7,
      "autoStartCollector": true,
      "alert": {
        "enabled": false,
        "thresholdPct": 5,
        "minutes": 5
      }
    }

The collector reads only the three numbers and re-clamps them. The app reads
the rest. Changes take effect on the collector's next cycle. The desktop alert
is evaluated by the non-elevated UI from the CPU samples. It fires once per
high-CPU episode when the average over the configured duration is above the
threshold, and names the top not-excluded path from the latest window.

## Privacy and locality

- No network code and no telemetry.
- Paths, process paths, extensions and scan times stay in the local data folder.
- The only external UI surface is the local Tauri IPC channel.
- The clipboard receives only the text the user asked to copy.

## Overhead

The performance recorder itself costs CPU while it is running. The default duty
cycle is 60 seconds recording, 120 seconds paused: one third of wall-clock time.
The recorder records only Defender's own scan activity, but WPR still runs. The
five-second CPU sampler is small. If the machine feels busier than expected,
raise pauseSeconds, lower recordSeconds or increase retention pruning.

## Requirements

- Windows 10 or Windows 11.
- Microsoft Defender with the ConfigDefender/ConfigDefenderPerformance
  PowerShell modules.
- PowerShell 7 (pwsh.exe) on PATH or in Program Files\PowerShell\7.
- WebView2 runtime for the UI (normally already installed on Windows).
- .NET desktop runtime is not required by this app.

## Build from source

Prerequisites: Node.js 20 or newer, Rust stable with the MSVC target, Visual
Studio Build Tools with the C++ workload, PowerShell 7.

    npm install
    npm run build

The build script imports the Visual Studio environment, runs the Tauri release
build without a bundle, and copies the executable to:

    dist\Defender Watch.exe

It also copies this README beside it. No installer, GitHub workflow or release
publishing file is created.

Run the PowerShell parser and unit tests without recording or elevation:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
    npm test

The collector can be exercised non-elevated on a captured report:

    pwsh -NoProfile -File collector\collector.ps1 -ConvertOnly tests\fixtures\report.json tests\out.json

That path performs no recording, no exclusion read and no UAC.

## Tests

The Node tests cover:

- flattening the real report.json fixture, including absolute child segments
  and AMSI grouping;
- path roll-up depth;
- exclusion matching (E:\misc vs E:\misc2, case, trailing slash, extension and
  process exclusions);
- interval aggregation across several windows;
- stale/missing/running/starting/error collector detection;
- alert decisions;
- CPU chart binning and geometry.

The collector test runs the real collector.ps1 with -ConvertOnly and compares
its output with the JavaScript expectations. The PowerShell parser checks run
through scripts\verify.ps1.

## Limitations

- The elevated recording path and real Defender exclusions cannot be verified
  without administrator rights. The collector's -ConvertOnly path is verified
  non-elevated.
- UAC is one prompt per app session. If it is declined, the app shows the error
  and no data is collected until the user starts the collector again.
- Defender may omit or merge very small paths because the report is requested
  with TopPaths 60 / TopPathsDepth 6. The UI can only show what Defender
  reported.
- The UI cannot detect a collector that was killed without writing status. It
  becomes stale after record + pause + 60 seconds.
- The app does not uninstall, register itself at logon, add exclusions or start
  itself when the app is closed.
- AMSI rows have no file path and therefore no copyable exclusion command.
