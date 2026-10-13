<#
.SYNOPSIS
Installs or upgrades Joint Bob on Windows, inside a WSL 2 distribution.

.DESCRIPTION
Joint Bob runs as a Linux user service. On Windows it lives in WSL 2, and this
script does the Windows side: it installs WSL and Ubuntu when they are missing,
turns on systemd, runs the normal Linux installer in the distribution, and
registers a logon task that keeps the distribution running after its last
terminal closes.

Run it as your own Windows user, not as administrator. Installing WSL asks for
administrator approval through the Windows prompt, and a restart may be needed:

  irm https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install-windows.ps1 | iex

With options:

  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install-windows.ps1))) -Distro Ubuntu -Port 9000

.PARAMETER Distro
WSL distribution to install into. Defaults to the default distribution, or Ubuntu when WSL is installed fresh.

.PARAMETER Port
Port for a new installation. An upgrade keeps the port in ~/.joint-bob/env.

.PARAMETER Force
Answer yes to the prompts: installing WSL and Ubuntu, and turning on systemd (which restarts the distribution).

.PARAMETER KeepAliveOnly
Only register the logon task; do not install or upgrade.

.PARAMETER NoKeepAlive
Install or upgrade without registering the logon task.

.PARAMETER SkipWslInstall
Stop instead of installing WSL and Ubuntu when no distribution is present.
#>
param(
  [string]$Distro = "",
  [int]$Port = 8787,
  [switch]$Force,
  [switch]$KeepAliveOnly,
  [switch]$NoKeepAlive,
  [switch]$SkipWslInstall
)

function Install-JointBobWsl {
  param([string]$Distro, [int]$Port, [switch]$Force, [switch]$KeepAliveOnly, [switch]$NoKeepAlive, [switch]$SkipWslInstall)

  # Failures throw instead of exiting: this usually runs through iex in the user's own window.
  $ErrorActionPreference = "Stop"
  $scriptsUrl = "https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts"
  $guide = "https://github.com/iliagerman/joint-bob#install-on-windows"

  if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }
  # wsl.exe prints UTF-16 unless told otherwise; Invoke-Wsl also strips NULs for builds that ignore this.
  $env:WSL_UTF8 = "1"

  # Runs a command in WSL and captures it. A script goes through standard input, so nothing
  # depends on how PowerShell quotes arguments for a native program.
  function Invoke-Wsl {
    param([string[]]$Arguments, [string]$Script)
    # Captured native stderr must not turn into a terminating PowerShell error.
    $ErrorActionPreference = "Continue"
    if ($Script) { $output = (($Script -replace "`r", "") + "`n#") | & wsl.exe @Arguments 2>&1 }
    else { $output = & wsl.exe @Arguments 2>&1 }
    $lines = @($output | ForEach-Object { ("$_" -replace "`0", "").Trim() } | Where-Object { $_ })
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines; First = [string]($lines | Select-Object -First 1) }
  }

  # Registered distributions, without Docker Desktop's internal one. Empty when WSL is missing.
  function Get-WslDistributions {
    $list = Invoke-Wsl -Arguments @("--list", "--quiet")
    if ($list.ExitCode -ne 0) { return @() }
    return @($list.Lines | Where-Object { $_ -match '^[A-Za-z0-9._-]+$' -and $_ -notlike "docker-desktop*" })
  }

  function Test-Elevated {
    try {
      $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
      return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
  }

  # Installs WSL and a distribution. Windows asks for administrator approval through UAC.
  function Install-WslDistribution {
    param([string]$Name)
    $build = try { [int](Get-CimInstance -ClassName Win32_OperatingSystem).BuildNumber } catch { 0 }
    if ($build -gt 0 -and $build -lt 19041) {
      throw "WSL 2 needs Windows 10 version 2004 (build 19041) or later; this is build $build. Update Windows, then run this again. Guide: $guide"
    }
    $cpu = try { Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 } catch { $null }
    if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
      Write-Warning "Virtualization may be off in this computer's firmware. WSL 2 needs Intel VT-x or AMD-V; turn it on in the BIOS/UEFI settings if the installation fails."
    }
    if (-not $Force) {
      $answer = Read-Host "WSL is not set up. Install WSL and '$Name' now? Windows will ask for administrator approval, and a restart may be needed. [y/N]"
      if ($answer -notmatch '^[Yy]') { throw "Stopped. Install WSL yourself with 'wsl --install -d $Name', then run this again. Guide: $guide" }
    }
    Write-Host "==> Installing WSL and '$Name' (approve the Windows administrator prompt if it appears)"
    # --no-launch registers the distribution without opening its first-run setup; New-JointBobLinuxUser does that part.
    $wslArguments = @("--install", "-d", $Name, "--no-launch")
    if (Test-Elevated) {
      & wsl.exe @wslArguments
      $code = $LASTEXITCODE
    } else {
      try { $process = Start-Process -FilePath "wsl.exe" -ArgumentList $wslArguments -Verb RunAs -Wait -PassThru }
      catch { throw "Administrator approval is needed to install WSL, and it was not given. Run this again and approve the Windows prompt. Guide: $guide" }
      $code = $process.ExitCode
    }
    if ($code -ne 0) { throw "WSL installation did not finish (exit code $code). Run 'wsl --install -d $Name' in an administrator PowerShell to see the error. Guide: $guide" }
  }

  # Creates the Linux account that runs Joint Bob, named after the Windows user, and makes it the default.
  # It runs as root, so the distribution's own first-run user prompt never appears. No password is set.
  function New-JointBobLinuxUser {
    param([string]$Name)
    $linuxUser = ([string]$env:USERNAME).ToLowerInvariant() -replace '[^a-z0-9_-]', ''
    if ($linuxUser -notmatch '^[a-z_][a-z0-9_-]{0,31}$') { $linuxUser = "bob" }
    # The first start of a new distribution finishes its setup, so this waits for it.
    $start = Invoke-Wsl -Arguments @("-d", $Name, "-u", "root", "--", "true")
    if ($start.ExitCode -ne 0) { throw "'$Name' did not start: $($start.Lines -join ' ')" }
    $userScript = @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar xz-utils perl >/dev/null
id -u __USER__ >/dev/null 2>&1 || useradd --create-home --shell /bin/bash __USER__
usermod -aG sudo __USER__ 2>/dev/null || true
conf=/etc/wsl.conf
touch "$conf"
if grep -q '^\[user\]' "$conf"; then
  sed -i -e '/^\[user\]/,/^\[/{/^[[:space:]]*default[[:space:]]*=/d}' -e '/^\[user\]/a default=__USER__' "$conf"
else
  printf '\n[user]\ndefault=__USER__\n' >> "$conf"
fi
exit 0
'@
    $userScript = $userScript -replace '__USER__', $linuxUser
    Write-Host "==> Setting up '$Name' and creating the Linux user '$linuxUser'"
    $created = Invoke-Wsl -Arguments @("-d", $Name, "-u", "root", "--", "bash", "-s") -Script $userScript
    if ($created.ExitCode -ne 0) { throw "Could not create the Linux user '$linuxUser' in '$Name': $($created.Lines -join ' ')" }
    Invoke-Wsl -Arguments @("--set-default", $Name) | Out-Null
    # The default user in /etc/wsl.conf applies from the next start of the distribution.
    Invoke-Wsl -Arguments @("--terminate", $Name) | Out-Null
    Write-Host "==> Created '$linuxUser' with no password. Run 'passwd' inside '$Name' to allow sudo."
  }

  $wslPresent = [bool](Get-Command wsl.exe -ErrorAction SilentlyContinue)
  $registered = if ($wslPresent) { @(Get-WslDistributions) } else { @() }
  if ($registered.Count -eq 0) {
    $name = if ($Distro) { $Distro } else { "Ubuntu" }
    if ($name -notmatch '^[A-Za-z0-9._-]+$') { throw "Unexpected WSL distribution name: $name" }
    if ($SkipWslInstall) { throw "No WSL distribution is installed. In an administrator PowerShell run 'wsl --install -d $name', then run this again. Guide: $guide" }
    Install-WslDistribution -Name $name
    if (@(Get-WslDistributions) -notcontains $name) {
      throw "WSL is installed, but '$name' is not ready yet. This usually means Windows must restart to finish installing WSL. Restart Windows, then run this same command again. Guide: $guide"
    }
    New-JointBobLinuxUser -Name $name
    $Distro = $name
  } elseif ($Distro -and $registered -notcontains $Distro) {
    throw "WSL distribution '$Distro' is not installed. Installed: $($registered -join ', '). Pass one of those with -Distro, or install it with 'wsl --install -d $Distro'."
  }

  if (-not $Distro) {
    $default = Invoke-Wsl -Arguments @("printenv", "WSL_DISTRO_NAME")
    if ($default.ExitCode -ne 0 -or -not $default.First) {
      throw "No WSL distribution is installed. Run 'wsl --install -d Ubuntu', create the Linux user it asks for, then run this again. Guide: $guide"
    }
    $Distro = $default.First
  }
  if ($Distro -notmatch '^[A-Za-z0-9._-]+$') { throw "Unexpected WSL distribution name: $Distro" }
  if ($Distro -like "docker-desktop*") {
    throw "The default WSL distribution belongs to Docker Desktop. Install one for Joint Bob with 'wsl --install -d Ubuntu', then pass -Distro Ubuntu."
  }
  $inDistro = @("-d", $Distro, "--")
  Write-Host "==> Using WSL distribution '$Distro'"

  $kernel = Invoke-Wsl -Arguments ($inDistro + @("uname", "-r"))
  if ($kernel.ExitCode -ne 0) { throw "Could not start WSL distribution '$Distro': $($kernel.Lines -join ' ')" }
  if ($kernel.First -notmatch 'microsoft-standard|WSL2') {
    throw "'$Distro' runs under WSL 1. Convert it with 'wsl --set-version $Distro 2', then run this again."
  }
  $userId = (Invoke-Wsl -Arguments ($inDistro + @("id", "-u"))).First
  $userName = (Invoke-Wsl -Arguments ($inDistro + @("id", "-un"))).First
  if ($userId -eq "0") {
    throw "The default user of '$Distro' is root. Joint Bob must run as a normal user: create one and make it the default (https://aka.ms/wslusers), then run this again."
  }
  if ($userName -notmatch '^[a-z_][a-z0-9_-]*$') { throw "Unexpected Linux user name in '$Distro': $userName" }

  if (-not $KeepAliveOnly) {
    $missing = (Invoke-Wsl -Arguments ($inDistro + @("bash", "-s")) -Script @'
missing=""
for tool in curl tar perl xz; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
echo "missing:$missing"
exit 0
'@).Lines | Where-Object { $_ -like "missing:*" } | Select-Object -First 1
    $missing = ("$missing" -replace '^missing:', '').Trim()
    if ($missing) {
      throw "'$Distro' is missing: $missing. Install them inside the distribution (on Ubuntu: sudo apt-get update && sudo apt-get install -y curl tar perl xz-utils), then run this again."
    }

    $systemdCheck = $inDistro + @("systemctl", "--user", "show-environment")
    if ((Invoke-Wsl -Arguments $systemdCheck).ExitCode -ne 0) {
      Write-Host "==> systemd is off in '$Distro'. Joint Bob needs it for its services."
      if (-not $Force) {
        $answer = Read-Host "Turn it on in /etc/wsl.conf and restart '$Distro'? This stops everything running in it. [y/N]"
        if ($answer -notmatch '^[Yy]') { throw "Stopped. Enable systemd yourself (see $guide), then run this again." }
      }
      $enabled = Invoke-Wsl -Arguments @("-d", $Distro, "-u", "root", "--", "bash", "-s") -Script @'
set -e
conf=/etc/wsl.conf
touch "$conf"
cp "$conf" "$conf.joint-bob-backup"
if grep -q '^\[boot\]' "$conf"; then
  sed -i -e '/^[[:space:]]*systemd[[:space:]]*=/d' -e '/^\[boot\]/a systemd=true' "$conf"
else
  printf '\n[boot]\nsystemd=true\n' >> "$conf"
fi
exit 0
'@
      if ($enabled.ExitCode -ne 0) { throw "Could not edit /etc/wsl.conf in '$Distro': $($enabled.Lines -join ' ')" }
      Invoke-Wsl -Arguments @("--terminate", $Distro) | Out-Null
      # WSL needs a few seconds to stop a distribution before wsl.conf is read again.
      Start-Sleep -Seconds 8
      $ready = $false
      for ($attempt = 0; $attempt -lt 15 -and -not $ready; $attempt++) {
        if ((Invoke-Wsl -Arguments $systemdCheck).ExitCode -eq 0) { $ready = $true } else { Start-Sleep -Seconds 2 }
      }
      if (-not $ready) {
        throw "systemd did not start in '$Distro'. Run 'wsl --update' and 'wsl --shutdown', check 'systemctl --user show-environment' inside the distribution, then run this again. Guide: $guide"
      }
    }

    # Lets the user services start with the distribution instead of with the first terminal.
    $linger = Invoke-Wsl -Arguments @("-d", $Distro, "-u", "root", "--", "loginctl", "enable-linger", $userName)
    if ($linger.ExitCode -ne 0) { Write-Warning "Could not enable lingering for '$userName'; run 'sudo loginctl enable-linger $userName' inside '$Distro'." }

    Write-Host "==> Installing Joint Bob in '$Distro' as '$userName'"
    $install = "set -eo pipefail`ncd `"`$HOME`"`ncurl -fsSL $scriptsUrl/install.sh </dev/null | PORT=$Port bash`nexit 0`n#"
    # Not captured: the installer's progress goes straight to this window.
    $install | & wsl.exe @inDistro bash -s
    if ($LASTEXITCODE -ne 0) { throw "The Joint Bob installer failed inside '$Distro' (exit code $LASTEXITCODE). Its output is above." }
  }

  if (-not $NoKeepAlive) {
    $taskName = "Joint Bob WSL ($Distro)"
    try {
      $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      # conhost --headless keeps the task from opening a console window.
      $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\conhost.exe") -Argument "--headless wsl.exe -d $Distro --exec /bin/sleep infinity"
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
      $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Keeps the WSL distribution that runs Joint Bob started while you are signed in to Windows." -Force | Out-Null
      Start-ScheduledTask -TaskName $taskName
      Write-Host "==> Registered the logon task '$taskName'; Joint Bob now starts when you sign in to Windows."
    } catch {
      Write-Warning "Could not register the logon task '$taskName': $($_.Exception.Message)"
      Write-Warning "Until it exists, Joint Bob stops when the last '$Distro' terminal closes. Guide: $guide"
    }
  }
  if ($KeepAliveOnly) { return }

  $savedPort = (Invoke-Wsl -Arguments ($inDistro + @("bash", "-s")) -Script @'
[ ! -f "$HOME/.joint-bob/env" ] || . "$HOME/.joint-bob/env"
echo "port:${PORT:-8787}"
exit 0
'@).Lines | Where-Object { $_ -match '^port:\d+$' } | Select-Object -First 1
  if ($savedPort) { $Port = [int]("$savedPort" -replace '^port:', '') }

  $healthy = $false
  for ($attempt = 0; $attempt -lt 12 -and -not $healthy; $attempt++) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$Port/api/health" | Out-Null; $healthy = $true }
    catch { Start-Sleep -Seconds 5 }
  }
  Write-Host ""
  if ($healthy) {
    Write-Host "Joint Bob is running. Open http://127.0.0.1:$Port/ and create the administrator."
  } else {
    Write-Warning "Joint Bob is installed, but Windows could not reach http://127.0.0.1:$Port/api/health."
    Write-Warning "Check it inside '$Distro' with: curl -fsS http://127.0.0.1:$Port/api/health"
    Write-Warning "If that works, WSL localhost forwarding is off; see $guide"
  }
  Write-Host "Sign in to Pi and Claude inside '$Distro' (wsl -d $Distro), and keep projects in the Linux filesystem, not under /mnt/c."
}

Install-JointBobWsl -Distro $Distro -Port $Port -Force:$Force -KeepAliveOnly:$KeepAliveOnly -NoKeepAlive:$NoKeepAlive -SkipWslInstall:$SkipWslInstall
