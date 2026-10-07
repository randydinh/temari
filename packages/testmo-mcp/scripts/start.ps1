param([switch]$EnableWrites, [switch]$VerifyConnection, [string]$NodePath = $env:TESTMO_MCP_NODE_PATH)
$ErrorActionPreference = 'Stop'
if (-not $VerifyConnection) { throw 'For MCP stdio, launch src/index.js directly with Node. Use this script with -VerifyConnection for the finite read check.' }
if (-not $NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
    else { $NodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Node runtime unavailable. Supply -NodePath or TESTMO_MCP_NODE_PATH.' }
$tokenPath = Join-Path $env:USERPROFILE '.temari\testmo-mcp\token.dpapi'
$tokenPtr = [IntPtr]::Zero
try {
    if (Test-Path -LiteralPath $tokenPath) {
        $secureToken = (Get-Content -Raw -LiteralPath $tokenPath).Trim() | ConvertTo-SecureString
        $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $env:TESTMO_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
    }
    $env:TESTMO_MCP_WRITE_ENABLED = if ($EnableWrites) { 'true' } else { 'false' }
    $serverFile = if ($VerifyConnection) { Join-Path $PSScriptRoot '..\src\smoke.js' } else { Join-Path $PSScriptRoot '..\src\index.js' }
    & $NodePath $serverFile
    exit $LASTEXITCODE
} finally {
    if ($tokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
    Remove-Item Env:\TESTMO_TOKEN -ErrorAction SilentlyContinue
}
