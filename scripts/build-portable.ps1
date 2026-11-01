$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        throw 'cargo.exe was not found. Install the Rust MSVC toolchain first.'
    }
    if (-not (Test-Path (Join-Path $root 'node_modules\.bin\tauri.cmd'))) {
        throw 'node_modules is missing. Run npm install first.'
    }

    $vcvars = $null
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $vcvarsCandidates = @(
        'D:\VSBuildTools\VC\Auxiliary\Build\vcvars64.bat',
        (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'),
        (Join-Path $programFilesX86 'Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat')
    )
    foreach ($candidate in $vcvarsCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $vcvars = $candidate; break }
    }
    if (-not $vcvars) {
        $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere) {
            $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($found) {
                $candidate = Join-Path $found.Trim() 'VC\Auxiliary\Build\vcvars64.bat'
                if (Test-Path -LiteralPath $candidate) { $vcvars = $candidate }
            }
        }
    }
    if (-not $vcvars) {
        throw 'The Visual Studio C++ build tools (vcvars64.bat) were not found.'
    }

    $envName = 'dw-build-env-' + [Guid]::NewGuid().ToString('N')
    $envScript = Join-Path ([IO.Path]::GetTempPath()) ($envName + '.cmd')
    $envOutput = Join-Path ([IO.Path]::GetTempPath()) ($envName + '.out')
    $envLines = '@echo off' + [Environment]::NewLine + 'call "' + $vcvars + '" >nul' + [Environment]::NewLine + 'set'
    [IO.File]::WriteAllText($envScript, $envLines, [Text.UTF8Encoding]::new($false))
    try {
        $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $envScript) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $envOutput
        if ($process.ExitCode -ne 0) { throw 'Could not import the Visual Studio environment.' }
        $environmentLines = Get-Content -LiteralPath $envOutput -Encoding UTF8
        foreach ($line in $environmentLines) {
            if ($line -match '^([^=]+)=(.*)$') {
                [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
            }
        }
    } finally {
        Remove-Item -LiteralPath $envScript -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $envOutput -Force -ErrorAction SilentlyContinue
    }

    Write-Output 'Building the portable Defender Watch executable...'
    & (Join-Path $root 'node_modules\.bin\tauri.cmd') build --no-bundle --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed.' }

    $built = Join-Path $root 'src-tauri\target\x86_64-pc-windows-msvc\release\defender-watch.exe'
    if (-not (Test-Path -LiteralPath $built)) { throw 'The build finished without producing defender-watch.exe.' }
    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Copy-Item -LiteralPath $built -Destination (Join-Path $dist 'Defender Watch.exe') -Force
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $dist 'README.md') -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $built).Hash.ToLowerInvariant()
    Write-Output ('Portable executable: ' + (Join-Path $dist 'Defender Watch.exe'))
    Write-Output ('SHA-256: ' + $hash)
    Write-Output ('Collector SHA-256: ' + (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'collector\collector.ps1')).Hash.ToLowerInvariant())
} finally {
    Pop-Location
}
