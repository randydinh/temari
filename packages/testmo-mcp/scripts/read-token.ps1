param([Parameter(Mandatory=$true)][string]$TokenPath)
# Internal helper: its stdout must be privately captured by credential.js.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$secureToken = (Get-Content -Raw -LiteralPath $TokenPath).Trim() | ConvertTo-SecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
