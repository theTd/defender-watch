#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sha256;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::c_void,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, WindowEvent,
};
use winrt_notification::{Duration as ToastDuration, Toast};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const COLLECTOR_SOURCE: &str = include_str!("../../collector/collector.ps1");
const COLLECTOR_SHA256: &str = env!("DEFENDER_WATCH_COLLECTOR_SHA256");
const DATA_DIR_ENV: &str = "DEFENDER_WATCH_DATA_DIR";
const DIRECT_COMMAND_LIMIT: usize = 29000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AlertSettings {
    enabled: bool,
    threshold_pct: f64,
    minutes: u32,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self { enabled: false, threshold_pct: 5.0, minutes: 5 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    record_seconds: u32,
    pause_seconds: u32,
    retention_days: u32,
    auto_start_collector: bool,
    alert: AlertSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            record_seconds: 60,
            pause_seconds: 120,
            retention_days: 7,
            auto_start_collector: true,
            alert: AlertSettings::default(),
        }
    }
}

impl Settings {
    fn normalized(mut self) -> Self {
        self.record_seconds = self.record_seconds.clamp(15, 300);
        self.pause_seconds = self.pause_seconds.min(3600);
        self.retention_days = self.retention_days.clamp(1, 90);
        self.alert.threshold_pct = if self.alert.threshold_pct.is_finite() {
            self.alert.threshold_pct.clamp(1.0, 100.0)
        } else {
            5.0
        };
        self.alert.minutes = self.alert.minutes.clamp(1, 120);
        self
    }
}

#[derive(Clone, Debug, Default)]
struct RuntimeState {
    phase: String,
    error: Option<String>,
    started_at: u64,
}

#[derive(Clone)]
struct CachedWindow {
    mtime: u64,
    data: Value,
}

struct Shared {
    data_dir: PathBuf,
    runtime: Mutex<RuntimeState>,
    windows: Mutex<HashMap<PathBuf, CachedWindow>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn ensure_data_layout(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir.join("windows")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("cpu")).map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_data_dir() -> Result<PathBuf, String> {
    let dir = match std::env::var_os(DATA_DIR_ENV) {
        Some(value) => PathBuf::from(value),
        None => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            exe.parent()
                .ok_or("The application has no parent folder")?
                .join("data")
        }
    };
    if !dir.is_absolute() {
        return Err("The data folder must be an absolute path".into());
    }
    ensure_data_layout(&dir)?;
    Ok(dir)
}

fn read_settings(dir: &Path) -> Settings {
    let path = dir.join("settings.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

fn write_settings(dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = dir.join("settings.json");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn ensure_default_settings(dir: &Path) -> Result<(), String> {
    let path = dir.join("settings.json");
    if !path.exists() {
        write_settings(dir, &Settings::default())?;
    }
    Ok(())
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn read_status(dir: &Path) -> (Option<Value>, u64) {
    let path = dir.join("status.json");
    if !path.exists() {
        return (None, 0);
    }
    (read_json_file(&path), modified_millis(&path))
}

fn status_is_fresh(dir: &Path, settings: &Settings) -> bool {
    let path = dir.join("status.json");
    if !path.exists() {
        return false;
    }
    let mtime = modified_millis(&path);
    let threshold = (u64::from(settings.record_seconds) + u64::from(settings.pause_seconds) + 60) * 1000;
    now_millis().saturating_sub(mtime) <= threshold
}

fn window_entry(shared: &Shared, path: &Path) -> Option<Value> {
    let mtime = modified_millis(path);
    {
        let cache = shared.windows.lock().ok()?;
        if let Some(entry) = cache.get(path) {
            if entry.mtime == mtime {
                return Some(json!({
                    "file": path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
                    "mtime": mtime,
                    "data": entry.data.clone()
                }));
            }
        }
    }
    let data = read_json_file(path)?;
    let mut cache = shared.windows.lock().ok()?;
    if cache.len() > 5000 {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), CachedWindow { mtime, data: data.clone() });
    Some(json!({
        "file": path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
        "mtime": mtime,
        "data": data
    }))
}

fn window_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("windows")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn latest_window_entry(shared: &Shared) -> Option<Value> {
    let mut paths = window_files(&shared.data_dir);
    paths.sort_by_key(|path| std::cmp::Reverse(modified_millis(path)));
    for path in paths {
        if let Some(entry) = window_entry(shared, &path) {
            return Some(entry);
        }
    }
    None
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let number = |start: usize, length: usize| -> Option<i64> {
        let end = start + length;
        if end > bytes.len() {
            return None;
        }
        std::str::from_utf8(&bytes[start..end]).ok()?.parse::<i64>().ok()
    };
    let year = number(0, 4)?;
    let month = number(5, 2)?;
    let day = number(8, 2)?;
    let hour = number(11, 2)?;
    let minute = number(14, 2)?;
    let second = number(17, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut fraction_ms = 0i64;
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index > start {
            let digits = &value[start..index];
            let take = digits.len().min(3);
            fraction_ms = digits[..take].parse::<i64>().ok()? * 10i64.pow((3 - take) as u32);
        }
    }
    let mut offset_minutes = 0i64;
    if index < bytes.len() {
        match bytes[index] {
            b'Z' | b'z' => {}
            b'+' | b'-' => {
                let sign = if bytes[index] == b'-' { -1 } else { 1 };
                index += 1;
                if index + 5 <= bytes.len() {
                    let oh = number(index, 2)?;
                    let om = number(index + 3, 2)?;
                    offset_minutes = sign * (oh * 60 + om);
                }
            }
            _ => {}
        }
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    Some((seconds - offset_minutes * 60) * 1000 + fraction_ms)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let mut y = year;
    let m = month as i64;
    if m <= 2 {
        y -= 1;
    }
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn read_cpu_range(dir: &Path, start_ms: i64, end_ms: i64) -> Vec<Value> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("cpu")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut samples = Vec::new();
    for path in files {
        let Ok(text) = fs::read_to_string(&path) else { continue; };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
            let Some(t) = value.get("t").and_then(Value::as_str) else { continue; };
            let Some(pct) = value.get("pct").and_then(Value::as_f64) else { continue; };
            let Some(ms) = parse_iso_ms(t) else { continue; };
            if ms >= start_ms && ms <= end_ms {
                samples.push(json!({ "t": t, "tMs": ms, "pct": pct }));
            }
        }
    }
    samples.sort_by_key(|value| value.get("tMs").and_then(Value::as_i64).unwrap_or(0));
    samples
}

fn interval_windows(shared: &Shared, start_ms: i64, end_ms: i64) -> Vec<Value> {
    let mut result = Vec::new();
    for path in window_files(&shared.data_dir) {
        let Some(entry) = window_entry(shared, &path) else { continue; };
        let data = &entry["data"];
        let Some(window_start) = data.get("start").and_then(Value::as_str).and_then(parse_iso_ms) else { continue; };
        let Some(window_end) = data.get("end").and_then(Value::as_str).and_then(parse_iso_ms) else { continue; };
        if window_end >= start_ms && window_start <= end_ms {
            result.push(entry);
        }
    }
    result.sort_by_key(|entry| {
        entry["data"]["start"].as_str().and_then(parse_iso_ms).unwrap_or(0)
    });
    result
}

fn latest_cpu_percent(dir: &Path) -> Option<f64> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir.join("cpu"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    files.sort();
    let path = files.last()?;
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let take = length.min(8192);
    file.seek(SeekFrom::End(-(take as i64))).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer);
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(pct) = value.get("pct").and_then(Value::as_f64) {
                return Some(pct);
            }
        }
    }
    None
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let combined = (b0 << 16) | (b1 << 8) | b2;
        output.push(TABLE[((combined >> 18) & 63) as usize] as char);
        output.push(TABLE[((combined >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 { TABLE[((combined >> 6) & 63) as usize] as char } else { '=' });
        output.push(if chunk.len() > 2 { TABLE[(combined & 63) as usize] as char } else { '=' });
    }
    output
}

fn utf16le(input: &str) -> Vec<u8> {
    input.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect()
}

fn error_status_script(data_dir: &str) -> String {
    format!(
        "try {{ $s = [ordered]@{{ state = 'error'; lastWindow = $null; nextWindowAt = $null; lastError = $_.Exception.Message; pid = $PID; version = '{}' }}; [IO.File]::WriteAllText((Join-Path '{}' 'status.json'), ($s | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)) }} catch {{}}",
        APP_VERSION,
        ps_quote(data_dir)
    )
}

fn prepare_collector(shared: &Shared, app_pid: u32) -> Result<String, String> {
    let local_hash = sha256::sha256_hex(COLLECTOR_SOURCE.as_bytes());
    if local_hash != COLLECTOR_SHA256 {
        return Err("The embedded collector failed its runtime hash self-check".into());
    }
    let data_dir = shared.data_dir.to_string_lossy().into_owned();
    let data_quoted = ps_quote(&data_dir);
    let catch_script = error_status_script(&data_dir);
    let direct_bootstrap = format!(
        "$ErrorActionPreference = 'Stop'\n$data = '{data}'\ntry {{\n  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{source}'))\n  & ([ScriptBlock]::Create($source)) -DataDir $data -AppPid {pid}\n}} catch {{\n  {catch_script}\n  exit 2\n}}\n",
        data = data_quoted,
        source = base64_encode(COLLECTOR_SOURCE.as_bytes()),
        pid = app_pid,
        catch_script = catch_script
    );
    let direct_encoded = base64_encode(&utf16le(&direct_bootstrap));
    if direct_encoded.len() <= DIRECT_COMMAND_LIMIT {
        return Ok(format!("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand {direct_encoded}"));
    }

    let runtime_path = shared.data_dir.join("collector.runtime.ps1");
    fs::write(&runtime_path, COLLECTOR_SOURCE.as_bytes())
        .map_err(|e| format!("Cannot write the collector bootstrap file: {e}"))?;
    let written = fs::read(&runtime_path)
        .map_err(|e| format!("Cannot re-read the collector bootstrap file: {e}"))?;
    if sha256::sha256_hex(&written) != COLLECTOR_SHA256 {
        return Err("The collector script on disk did not match the build-time hash after writing".into());
    }
    let runtime_quoted = ps_quote(&runtime_path.to_string_lossy());
    let fallback_bootstrap = format!(
        "$ErrorActionPreference = 'Stop'\n$data = '{data}'\ntry {{\n  $bytes = [IO.File]::ReadAllBytes('{script}')\n  $hasher = [Security.Cryptography.SHA256]::Create()\n  try {{ $actual = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }} finally {{ $hasher.Dispose() }}\n  if ($actual -ne '{hash}') {{ throw 'Collector integrity check failed: collector.runtime.ps1 does not match the hash embedded in Defender Watch.' }}\n  $source = [Text.Encoding]::UTF8.GetString($bytes)\n  & ([ScriptBlock]::Create($source)) -DataDir $data -AppPid {pid}\n}} catch {{\n  {catch_script}\n  exit 2\n}}\n",
        data = data_quoted,
        script = runtime_quoted,
        hash = COLLECTOR_SHA256,
        pid = app_pid,
        catch_script = catch_script
    );
    let fallback_encoded = base64_encode(&utf16le(&fallback_bootstrap));
    if fallback_encoded.len() > 60000 {
        return Err("The collector bootstrap is unexpectedly too large for a Windows command line".into());
    }
    Ok(format!("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand {fallback_encoded}"))
}

// The resolved pwsh.exe runs elevated, so only accept copies under admin-only folders.
// PATH can contain user-writable folders where a planted pwsh.exe would gain admin rights.
fn resolve_pwsh() -> Result<PathBuf, String> {
    let program_files = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    for candidate in [
        program_files.join(r"PowerShell\7\pwsh.exe"),
        program_files.join(r"PowerShell\7-preview\pwsh.exe"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        let trusted_root = program_files.to_string_lossy().to_lowercase();
        for folder in std::env::split_paths(&path_var) {
            let folder_lower = folder.to_string_lossy().to_lowercase();
            if !folder_lower.starts_with(&format!("{trusted_root}\\")) {
                continue;
            }
            let candidate = folder.join("pwsh.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("PowerShell 7 (pwsh.exe) was not found under Program Files. Defender Watch only runs an admin-protected copy elevated.".into())
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[repr(C)]
struct ShellExecuteInfoW {
    cb_size: u32,
    f_mask: u32,
    hwnd: *mut c_void,
    lp_verb: *const u16,
    lp_file: *const u16,
    lp_parameters: *const u16,
    lp_directory: *const u16,
    n_show: i32,
    h_inst_app: isize,
    lp_id_list: *mut c_void,
    lp_class: *const u16,
    hkey_class: isize,
    dw_hot_key: u32,
    h_icon_or_monitor: *mut c_void,
    h_process: *mut c_void,
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
}

fn launch_elevated(pwsh: &Path, parameters: &str) -> Result<(), String> {
    // ShellExecuteEx may delegate to the Shell COM proxy. Initialize this
    // blocking thread's apartment, but keep going if COM says it is already
    // initialized in a different mode.
    let com = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2) };
    let result = launch_elevated_inner(pwsh, parameters);
    if com >= 0 {
        unsafe { CoUninitialize() };
    }
    result
}

fn launch_elevated_inner(pwsh: &Path, parameters: &str) -> Result<(), String> {
    let verb = wide(std::ffi::OsStr::new("runas"));
    let file = wide(pwsh.as_os_str());
    let params = wide(std::ffi::OsStr::new(parameters));
    let mut info = ShellExecuteInfoW {
        cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        f_mask: 0,
        hwnd: std::ptr::null_mut(),
        lp_verb: verb.as_ptr(),
        lp_file: file.as_ptr(),
        lp_parameters: params.as_ptr(),
        lp_directory: std::ptr::null(),
        n_show: 0,
        h_inst_app: 0,
        lp_id_list: std::ptr::null_mut(),
        lp_class: std::ptr::null(),
        hkey_class: 0,
        dw_hot_key: 0,
        h_icon_or_monitor: std::ptr::null_mut(),
        h_process: std::ptr::null_mut(),
    };
    let success = unsafe { ShellExecuteExW(&mut info) };
    if success == 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if code == 1223 {
            return Err("The UAC prompt was declined, so the elevated collector was not started.".into());
        }
        return Err(format!("Windows could not start the elevated collector (ShellExecuteEx error {code})"));
    }
    Ok(())
}

#[link(name = "user32")]
extern "system" {
    fn OpenClipboard(hwnd: *mut c_void) -> i32;
    fn EmptyClipboard() -> i32;
    fn SetClipboardData(format: u32, memory: *mut c_void) -> *mut c_void;
    fn CloseClipboard() -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
    fn GlobalLock(memory: *mut c_void) -> *mut c_void;
    fn GlobalUnlock(memory: *mut c_void) -> i32;
    fn GlobalFree(memory: *mut c_void) -> *mut c_void;
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut opened = false;
    for _ in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if !opened {
        return Err("Windows kept the clipboard busy".into());
    }
    let result = (|| -> Result<(), String> {
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Windows could not clear the clipboard".into());
        }
        let wide_text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide_text.len() * 2;
        let memory = unsafe { GlobalAlloc(0x0002, bytes) };
        if memory.is_null() {
            return Err("Windows could not allocate clipboard memory".into());
        }
        let target = unsafe { GlobalLock(memory) } as *mut u16;
        if target.is_null() {
            unsafe { GlobalFree(memory) };
            return Err("Windows could not lock clipboard memory".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(wide_text.as_ptr(), target, wide_text.len());
            let _ = GlobalUnlock(memory);
        }
        if unsafe { SetClipboardData(13, memory) }.is_null() {
            unsafe { GlobalFree(memory) };
            return Err("Windows could not place the command on the clipboard".into());
        }
        Ok(())
    })();
    unsafe { CloseClipboard() };
    result
}

fn notify(title: &str, body: &str) -> Result<(), String> {
    Toast::new(Toast::POWERSHELL_APP_ID)
        .title(title)
        .text1(body)
        .duration(ToastDuration::Long)
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn dashboard_active(window: tauri::Window) -> Result<bool, String> {
    Ok(window.is_visible().map_err(|e| e.to_string())? && !window.is_minimized().map_err(|e| e.to_string())?)
}

#[tauri::command]
fn dashboard_state(state: State<'_, Arc<Shared>>, cpu_since_ms: Option<i64>) -> Result<Value, String> {
    let shared = state.inner().clone();
    let settings = read_settings(&shared.data_dir);
    let (status, status_mtime) = read_status(&shared.data_dir);
    let exclusions = read_json_file(&shared.data_dir.join("exclusions.json"))
        .unwrap_or_else(|| json!({ "paths": [], "processes": [], "extensions": [], "updatedAt": "" }));
    let latest = latest_window_entry(&shared);
    let window_count = window_files(&shared.data_dir).len();
    let now = now_millis();
    let start_ms = cpu_since_ms.unwrap_or_else(|| (now as i64) - 65 * 60 * 1000).max(0);
    let cpu = read_cpu_range(&shared.data_dir, start_ms, now as i64);
    let mut runtime = shared.runtime.lock().map_err(|e| e.to_string())?.clone();
    if runtime.phase == "starting" && status.is_some() && status_mtime >= runtime.started_at && runtime.error.is_none() {
        runtime.phase = "idle".into();
        if let Ok(mut saved) = shared.runtime.lock() {
            saved.phase = "idle".into();
        }
    }
    if runtime.phase == "stopping" && status.is_none() {
        runtime.phase = "idle".into();
        if let Ok(mut saved) = shared.runtime.lock() {
            saved.phase = "idle".into();
        }
    }
    Ok(json!({
        "dataDir": shared.data_dir.to_string_lossy(),
        "settings": settings,
        "status": status,
        "statusMtime": status_mtime,
        "collector": null,
        "runtime": {
            "phase": runtime.phase,
            "error": runtime.error,
            "startedAt": runtime.started_at
        },
        "exclusions": exclusions,
        "latestWindow": latest,
        "windowCount": window_count,
        "cpu": cpu,
        "cpuCount": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "now": now
    }))
}

#[tauri::command]
fn interval_data(state: State<'_, Arc<Shared>>, start_ms: i64, end_ms: i64) -> Result<Value, String> {
    if start_ms > end_ms {
        return Err("The interval start must be before its end".into());
    }
    let shared = state.inner().clone();
    let windows = interval_windows(&shared, start_ms, end_ms);
    let cpu = read_cpu_range(&shared.data_dir, start_ms, end_ms);
    Ok(json!({ "windows": windows, "cpu": cpu }))
}

#[tauri::command]
async fn start_collector(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let shared = state.inner().clone();
    {
        let runtime = shared.runtime.lock().map_err(|e| e.to_string())?.clone();
        if runtime.phase == "starting" {
            return Err("The collector is already starting. Answer the Windows UAC prompt.".into());
        }
    }
    let settings = read_settings(&shared.data_dir);
    if status_is_fresh(&shared.data_dir, &settings) {
        if let Some(status) = read_json_file(&shared.data_dir.join("status.json")) {
            let state_name = status.get("state").and_then(Value::as_str).unwrap_or("");
            if state_name == "recording" || state_name == "idle" {
                return Err("The collector is already running.".into());
            }
        }
    }
    let pwsh = resolve_pwsh()?;
    let bootstrap = prepare_collector(&shared, std::process::id())?;
    let _ = fs::remove_file(shared.data_dir.join("stop.request"));
    {
        let mut runtime = shared.runtime.lock().map_err(|e| e.to_string())?;
        runtime.phase = "starting".into();
        runtime.error = None;
        runtime.started_at = now_millis();
    }
    let shared_for_launch = shared.clone();
    let result = tauri::async_runtime::spawn_blocking(move || launch_elevated(&pwsh, &bootstrap))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = result {
        let mut runtime = shared_for_launch.runtime.lock().map_err(|e| e.to_string())?;
        runtime.phase = "idle".into();
        runtime.error = Some(error.clone());
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn stop_collector(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let shared = state.inner().clone();
    fs::write(shared.data_dir.join("stop.request"), b"").map_err(|e| e.to_string())?;
    if let Ok(mut runtime) = shared.runtime.lock() {
        runtime.phase = "stopping".into();
        runtime.error = None;
    }
    Ok(())
}

#[tauri::command]
fn record_now(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let shared = state.inner().clone();
    let path = shared.data_dir.join("status.json");
    if !path.exists() {
        return Err("The collector is not running. Start it first.".into());
    }
    let settings = read_settings(&shared.data_dir);
    if !status_is_fresh(&shared.data_dir, &settings) {
        return Err("The collector status is stale. Start the collector again.".into());
    }
    fs::write(shared.data_dir.join("record-now.request"), b"").map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(state: State<'_, Arc<Shared>>, settings: Settings) -> Result<Settings, String> {
    let normalized = settings.normalized();
    write_settings(&state.inner().data_dir, &normalized)?;
    Ok(normalized)
}

#[tauri::command]
fn notify_alert(title: String, body: String) -> Result<(), String> {
    notify(&title, &body)
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    copy_to_clipboard(&text)
}

#[tauri::command]
fn open_data_folder(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(&state.inner().data_dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn stop_collector_and_wait(shared: &Shared) {
    let settings = read_settings(&shared.data_dir);
    let _ = fs::write(shared.data_dir.join("stop.request"), b"");
    if status_is_fresh(&shared.data_dir, &settings) {
        let status = shared.data_dir.join("status.json");
        for _ in 0..12 {
            if !status.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

fn update_tray_tooltip(app: &tauri::AppHandle, data_dir: &Path) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if let Some(pct) = latest_cpu_percent(data_dir) {
        let text = format!("Defender Watch · MsMpEng {pct:.1}% of total CPU");
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(text.as_str()));
        }
    }
    std::thread::sleep(Duration::from_secs(if visible { 5 } else { 30 }));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .invoke_handler(tauri::generate_handler![
            dashboard_active,
            dashboard_state,
            interval_data,
            start_collector,
            stop_collector,
            record_now,
            save_settings,
            notify_alert,
            copy_text,
            open_data_folder
        ])
        .setup(|app| {
            let data_dir = resolve_data_dir()?;
            ensure_default_settings(&data_dir)?;
            let shared = Arc::new(Shared {
                data_dir,
                runtime: Mutex::new(RuntimeState { phase: "idle".into(), error: None, started_at: 0 }),
                windows: Mutex::new(HashMap::new()),
            });
            app.manage(shared.clone());
            let open = MenuItem::with_id(app, "open", "Open Defender Watch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (stops collector)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut rgba = vec![0u8; 32 * 32 * 4];
            for y in 0..32 {
                for x in 0..32 {
                    let pixel = (y * 32 + x) * 4;
                    let inside = (6..26).contains(&x) && (4..28).contains(&y);
                    let color = if inside { [131, 230, 188, 255] } else { [25, 34, 45, 255] };
                    rgba[pixel..pixel + 4].copy_from_slice(&color);
                }
            }
            let quit_shared = shared.clone();
            TrayIconBuilder::with_id("main")
                .icon(Image::new_owned(rgba, 32, 32))
                .tooltip("Defender Watch · waiting for CPU samples")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => {
                        stop_collector_and_wait(&quit_shared);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            let tooltip_app = app.handle().clone();
            let tooltip_dir = shared.data_dir.clone();
            std::thread::spawn(move || loop {
                update_tray_tooltip(&tooltip_app, &tooltip_dir);
            });
            if !std::env::args().any(|arg| arg == "--background") {
                show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not start Defender Watch");
}
