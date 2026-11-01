$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scripts = @(
    (Join-Path $root 'collector\collector.ps1'),
    (Join-Path $root 'scripts\build-portable.ps1'),
    (Join-Path $root 'scripts\verify.ps1')
)
foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        Write-Output ('PARSE FAILED: ' + $script)
        $errors | ForEach-Object { Write-Output $_.Message }
        exit 1
    }
    Write-Output ('PARSE OK: ' + $script)
}
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'collector\collector.ps1')).Hash.ToLowerInvariant()
Write-Output ('Collector SHA-256: ' + $hash)
Push-Location $root
try {
    & node --test tests/core.test.cjs tests/cpu-chart.test.cjs tests/collector-convert.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Node tests failed.' }
    Write-Output 'All Node tests passed.'
} finally {
    Pop-Location
}
