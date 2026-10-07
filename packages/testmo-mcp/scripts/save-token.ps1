$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$credentialDir = Join-Path $env:USERPROFILE '.temari\testmo-mcp'
New-Item -ItemType Directory -Force -Path $credentialDir | Out-Null
$secureToken = Read-Host 'Paste your Testmo API token (hidden input)' -AsSecureString
if ($secureToken.Length -eq 0) { throw 'Token cannot be empty' }
# Windows DPAPI protects this value for the current Windows user on this machine.
$secureToken | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $credentialDir 'token.dpapi')
Write-Host 'Token saved with Windows user encryption. Restart the Testmo MCP connection.'
