# VNTG HTS — 미니PC 설치 가이드 (Windows 11 Pro)

전제: 미니PC는 지금 PC와 **같은 공유기**에 물려 있음.

> **구조가 바뀌었습니다.** 개발 중에는 서버(4000) + Vite(5173) 두 개를 띄웠지만,
> 미니PC에서는 **서버 하나가 웹 화면까지 같이 서빙**합니다.
> 포트 하나(4000), 프로세스 하나 → 자동 시작·방화벽 설정이 훨씬 단순해집니다.

---

## STEP 1. 미니PC에 Node.js 설치

https://nodejs.org 에서 **LTS 버전** 다운로드 → 설치 (기본값 그대로).

설치 확인 (PowerShell):
```powershell
node -v
```

## STEP 2. 프로젝트 복사

지금 PC의 `260810_클로드작업` 폴더를 통째로 미니PC로 복사합니다.
USB든 네트워크 공유든 상관없습니다.

**단, 아래 폴더는 복사하지 마세요** (용량만 크고 재설치하면 됨):
```
server\node_modules
web\node_modules
web\dist
```

복사 위치 예: `C:\vntg-hts`

## STEP 3. API 키 준비 (.env)

`C:\vntg-hts\server\.env` 파일이 같이 복사됐는지 확인합니다. 없으면 새로 만듭니다:

```
KIWOOM_APP_KEY=여기에_앱키
KIWOOM_APP_SECRET=여기에_시크릿키
DART_API_KEY=여기에_다트키
NAVER_CLIENT_ID=여기에_네이버_키ID
NAVER_CLIENT_SECRET=여기에_네이버_키
PORT=4000
```

> 변수 이름을 정확히 지켜야 합니다. 특히 시크릿은 `KIWOOM_APP_SECRET`입니다.

> ⚠ **키움 앱키는 이번에 재발급하세요.** 초기 설정 때 대화창에 한 번 노출된 적이 있습니다.
> 키움 Open API 홈페이지에서 재발급 후 위 파일에만 넣으면 됩니다.
> `.env`는 gitignore에 있어서 외부로 나가지 않습니다.

## STEP 4. 설치 & 빌드

PowerShell을 열고:

```powershell
cd C:\vntg-hts\server; npm install; npm run build
```

```powershell
cd C:\vntg-hts\web; npm install; npm run build
```

`web\dist` 폴더가 생기면 성공입니다.

## STEP 5. 실행 테스트

```powershell
cd C:\vntg-hts; .\start-prod.cmd
```

콘솔에 이렇게 나오면 정상입니다:
```
web/dist 서빙: C:\vntg-hts\web\dist
VNTG HTS server listening on port 4000
  http://192.168.x.x:4000
```

미니PC 브라우저에서 `http://localhost:4000` 접속해서 화면이 뜨는지 확인합니다.

## STEP 6. 방화벽 열기

다른 기기에서 접속하려면 인바운드 규칙이 필요합니다.
**관리자 권한** PowerShell에서:

```powershell
New-NetFirewallRule -DisplayName "VNTG HTS" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
```

이제 지금 PC나 폰에서 `http://<미니PC_IP>:4000` 으로 들어가집니다.
미니PC IP 확인:
```powershell
ipconfig | Select-String IPv4
```

## STEP 7. 자동 시작 등록 (작업 스케줄러)

> pm2는 리눅스용이라 Windows에서 부팅 자동시작이 불안정합니다.
> **Windows 기본 작업 스케줄러가 가장 확실합니다.**

관리자 권한 PowerShell에서 한 번에 등록:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\vntg-hts\start-prod.cmd"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "VNTG HTS" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

- `-AtStartup` — 로그인 안 해도 부팅되면 뜸
- `-RestartCount 3` — 죽으면 1분 간격으로 3번까지 자동 재시작
- `-ExecutionTimeLimit 0` — 시간 제한 없이 계속 실행

바로 시작해보기:
```powershell
Start-ScheduledTask -TaskName "VNTG HTS"
```

상태 확인:
```powershell
Get-ScheduledTask -TaskName "VNTG HTS" | Get-ScheduledTaskInfo
```

## STEP 8. 미니PC가 잠들지 않게

절전으로 들어가면 폰에서 접속이 끊깁니다. 관리자 PowerShell:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

(모니터만 10분 뒤 꺼지고, 시스템은 안 잠듦)

## STEP 9. Tailscale (외부에서 접속)

1. 미니PC에 https://tailscale.com/download 설치
2. 지금 쓰는 **같은 계정**으로 로그인
3. 미니PC의 Tailscale IP 확인:
```powershell
tailscale ip -4
```
4. 폰에서 `http://<타elscale_IP>:4000` 접속

> 폰 Tailscale은 이미 설정돼 있으니 앱만 켜져 있으면 LTE/5G에서도 됩니다.

**IP를 외우기 싫으면** Tailscale 관리 콘솔에서 MagicDNS를 켜고
머신 이름을 `hts` 같은 걸로 바꾸면 `http://hts:4000` 으로 접속됩니다.

## STEP 10. 확인

```powershell
curl.exe http://localhost:4000/api/health
```

이런 응답이 나오면 완료입니다:
```json
{
  "ok": true,
  "uptimeSec": 42,
  "addresses": ["192.168.x.x", "100.x.x.x"],
  "keysConfigured": { "kiwoom": true, "dart": true, "naver": true }
}
```

`keysConfigured`가 전부 `true`인지 꼭 보세요. `false`면 `.env`를 다시 확인합니다.
`addresses`에는 현재 IP가 다 나오므로, **공유기가 IP를 바꿔도 여기서 새 주소를 알 수 있습니다.**

---

## 앞으로 코드를 고쳤을 때

지금 PC에서 작업 → 미니PC로 파일 복사 → 미니PC에서:

```powershell
cd C:\vntg-hts\server; npm run build
```
```powershell
cd C:\vntg-hts\web; npm run build
```
```powershell
Stop-ScheduledTask -TaskName "VNTG HTS"; Start-ScheduledTask -TaskName "VNTG HTS"
```

> 나중에 편해지려면 이 폴더를 git 저장소로 만들어서 `git pull` 하는 게 낫습니다.
> (`.gitignore`에 `.env`가 이미 들어 있어서 키는 안 올라갑니다)

---

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| 화면은 뜨는데 데이터가 없음 | `/api/health`의 `keysConfigured` → `.env` 확인 |
| 다른 기기에서 접속 안 됨 | STEP 6 방화벽 규칙 |
| 부팅 후 자동으로 안 뜸 | `Get-ScheduledTaskInfo`의 `LastTaskResult` 확인 |
| 폰에서만 안 됨 | 폰 Tailscale 앱이 켜져 있는지 |
| 밤에 끊김 | STEP 8 절전 설정 |
| 키움 429 에러 | 정상. TR당 초당 5회 제한이라 자동 재시도함 |
