# Read the same version that the host embeds in its executable.
[CmdletBinding()]
param(
    [string] $HostSource = ''
)

$ErrorActionPreference = 'Stop'
if (-not $HostSource) { $HostSource = Join-Path $PSScriptRoot '../host/FrontDesk.cs' }
$source = Get-Content -LiteralPath $HostSource -Raw
$versions = [regex]::Matches($source, 'public\s+const\s+string\s+Version\s*=\s*"([^"]+)"\s*;')
if ($versions.Count -ne 1) { throw 'Expected exactly one host version constant.' }
$version = $versions[0].Groups[1].Value
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid release version '$version'." }
$version
