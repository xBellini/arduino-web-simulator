# What: Creates a timestamped sibling-folder backup of this repo with robocopy (excludes
# node_modules, dist, and .git), then prunes oldest `arduino-simulator-backup-*` snapshots
# when more than ten exist — local disaster recovery without GitHub.
# How-to: double-click `Backup.bat`, or from repo root in PowerShell run `.\backup-local.ps1`
# (execution policy may require `Set-ExecutionPolicy -Scope Process Bypass` once per session).
# Backups appear next to the repo as `..\arduino-simulator-backup-yyyy-MM-dd_HHmm\`. Change
# `$MaxSnapshots` or `$BackupNamePrefix` at the top to keep more copies or rename folders;
# robocopy excludes are in the `/XD` and `/XF` arguments on the robocopy line — extend those
# lists if you want to skip other heavy dirs.
#
# Changelog:
# - 05-10-2026 — Mention Backup.bat; always exit 0 on success (robocopy 0–7)
# - 17-09-2026 — Expanded What with practical how-to notes
# - 17-09-2026 — Changelog creation

$ErrorActionPreference = 'Stop'
$MaxSnapshots = 10
$BackupNamePrefix = 'arduino-simulator-backup-'

$src = $PSScriptRoot
$parent = Split-Path $src -Parent
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$dest = Join-Path $parent "$BackupNamePrefix$stamp"

New-Item -ItemType Directory -Path $dest -Force | Out-Null
robocopy $src $dest /E /XD node_modules dist .git /XF *.tsbuildinfo /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null

if ($LASTEXITCODE -gt 7) {
  throw "Backup failed (robocopy exit code $LASTEXITCODE)"
}

Write-Host "Backup saved to:"
Write-Host "  $dest"

$backups = Get-ChildItem -Path $parent -Directory -Filter "$BackupNamePrefix*" |
  Sort-Object Name

$extra = $backups.Count - $MaxSnapshots
if ($extra -le 0) {
  Write-Host "Snapshots kept: $($backups.Count) / $MaxSnapshots"
  exit 0
}

Write-Host "Pruning $extra old snapshot(s) (keeping $MaxSnapshots newest)..."
foreach ($old in ($backups | Select-Object -First $extra)) {
  Write-Host "  Removing $($old.Name)"
  Remove-Item -LiteralPath $old.FullName -Recurse -Force
}

$remaining = Get-ChildItem -Path $parent -Directory -Filter "$BackupNamePrefix*" |
  Sort-Object Name
Write-Host "Snapshots kept: $($remaining.Count) / $MaxSnapshots"
# Robocopy uses 0–7 as success; without an explicit exit, that code leaks as the process exit.
exit 0
