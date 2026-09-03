<#
  메인 PC 전용 — 커밋 · 푸시 · 미니PC 배포 · 완료 확인을 **한 번에** (2026-09-02).

  벤티지: "커밋되고 서버 도는 거 체크하는 로직이 너무 길던데" / "서버는 돌아간 지
  한참인데 넌 계속 체크 중이더라고"

  전에는 tool 호출 서너 번에 나눠 하고, 대기도 「자물쇠가 생겼다 사라지는」 두 단계를
  10초 간격으로 봤다. 이제:
    · 이 스크립트 하나가 add → commit → push → 깃발 → 대기까지 한다
    · 대기는 `deploy.status` 에 **방금 푸시한 커밋 해시**가 찍히는 순간 끝난다.
      status 는 배포의 맨 마지막(health 확인 뒤)에 쓰이므로 이것 하나면 충분하다
    · 3초마다 본다. 미니PC 감시도 5초마다 보게 바꿨으니 보통 1분 안에 끝난다

  쓰는 법 (메시지는 먼저 .git/vntg-msg.txt 에 UTF-8 로 써 둔다):
    powershell -File push-deploy.ps1            # 커밋·푸시·배포·대기
    powershell -File push-deploy.ps1 -NoDeploy  # 커밋·푸시만 (문서만 바뀐 경우)
    powershell -File push-deploy.ps1 -DeployOnly # 이미 푸시한 HEAD 를 배포만

  타입체크는 여기서 안 한다 — 통과한 뒤에 부르는 것이 규칙이다.
#>
param(
  [switch]$NoDeploy,
  [switch]$DeployOnly,
  [int]$TimeoutSec = 360
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$drop = "\\100.88.182.35\vntg-deploy"

if (-not $DeployOnly) {
  # 정보 탭의 변경 이력을 굽는다 (2026-09-04). 이번 커밋은 아직 없으니 한 박자 늦게 들어간다.
  node scripts/build-changelog.mjs
  if ($LASTEXITCODE -ne 0) { throw "changelog 생성 실패" }
  git add -A
  if ($LASTEXITCODE -ne 0) { throw "git add failed" }
  git commit -F .git/vntg-msg.txt -q
  if ($LASTEXITCODE -ne 0) { throw "git commit failed (nothing to commit?)" }
  git push -q
  if ($LASTEXITCODE -ne 0) { throw "git push failed" }
}

$hash = (git rev-parse --short HEAD).Trim()
"commit  $hash  " + (git log -1 --pretty=%s)

if ($NoDeploy) { "deploy  skipped"; exit 0 }

$t0 = Get-Date
New-Item "$drop\deploy.flag" -ItemType File -Force | Out-Null
"flag    " + $t0.ToString("HH:mm:ss")

$deadline = $t0.AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $st = Get-Content "$drop\deploy.status" -ErrorAction SilentlyContinue
  if (($st -join " ") -match [regex]::Escape($hash)) { break }
  Start-Sleep -Seconds 3
}

$elapsed = [int]((Get-Date) - $t0).TotalSeconds
$st = Get-Content "$drop\deploy.status" -ErrorAction SilentlyContinue
if (-not (($st -join " ") -match [regex]::Escape($hash))) {
  "TIMEOUT after ${elapsed}s - status: $($st -join ' ')"
  exit 2
}

"status  " + ($st -join " ") + "  (${elapsed}s)"
$health = Get-Content "$drop\deploy.log" -ErrorAction SilentlyContinue | Select-String -Pattern '"ok"' | Select-Object -Last 1
if ($health) { "health  " + $health.Line }

# 배포 중에 감시 스크립트 자신이 갱신되면 자물쇠가 남을 수 있다 — 끝났는데 남아 있으면 치운다
Start-Sleep -Seconds 3
if (Test-Path "$drop\deploy.lock") {
  Remove-Item "$drop\deploy.lock" -Force
  "lock    stale lock removed"
}
if (($st -join " ") -match "^FAIL") { exit 1 }
exit 0
