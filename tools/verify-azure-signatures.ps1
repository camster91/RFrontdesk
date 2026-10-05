[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]] $Path,
    [Parameter(Mandatory = $true)][string] $Publisher
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Expected publisher is required.' }
foreach ($pattern in $Path) {
    $files = @(Resolve-Path -Path $pattern)
    if ($files.Count -eq 0) { throw "No files match $pattern" }
    foreach ($file in $files) {
        $signature = Get-AuthenticodeSignature -LiteralPath $file.Path
        if ($signature.Status -ne 'Valid') { throw "$($file.Path): signature is $($signature.Status)" }
        if (-not $signature.TimeStamperCertificate) { throw "$($file.Path): timestamp is missing" }
        $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($name -cne $Publisher) { throw "$($file.Path): expected publisher '$Publisher', found '$name'" }
        Write-Host "Valid timestamped signature: $($file.Path) ($name)"
    }
}
