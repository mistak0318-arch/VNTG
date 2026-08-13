# 미니PC 단독 운영 전환 체크리스트

메인PC를 끄고 미니PC만 돌릴 때 필요한 것들. **코드는 git으로 넘어가지만 나머지는 안 넘어간다.**

---

## 1. git으로 안 넘어가는 것 — 직접 옮겨야 함

### 1-1. `server/.env`

`.gitignore`에 있으므로 `update.cmd`로는 절대 안 넘어간다. 항목 전체:

```
KIWOOM_APP_KEY=            KIWOOM_APP_SECRET=
DART_API_KEY=              NAVER_CLIENT_ID=          NAVER_CLIENT_SECRET=
ANTHROPIC_API_KEY=
NAVER_MAIL_USER=           NAVER_MAIL_PASS=          MAIL_TO=

TELEGRAM_BOT_TOKEN=        TELEGRAM_CHAT_ID=
TELEGRAM_CHAT_ID_REPORT=-5506807585
TELEGRAM_CHAT_ID_SIGNAL=-5416010172
TELEGRAM_CHAT_ID_LOG=-5304894219
TELEGRAM_CHAT_ID_CHANNEL=  ← 채널요약 방을 새로 만들면 여기

TELEGRAM_API_ID=           TELEGRAM_API_HASH=        TELEGRAM_SESSION=
```

### 1-2. `server/data/` — 쌓인 기록

**이게 진짜 자산이다.** 지금까지 만든 기능 중 시간이 쌓여야 의미가 생기는 것들:

| 파일 | 내용 | 잃으면 |
|---|---|---|
| `breadth.json` | 시장 폭 일별 누적 | **소급 불가.** 처음부터 다시 쌓아야 함 |
| `reports/*.json` | 발행된 AI 리포트 | 과거 리포트 복기 불가 |
| `notes.json` | 종목 메모 + 작성 시점 가격 | 수익률 추적 기록 소멸 |
| `watchlist.json`, `watchGroups.json` | 관심종목·그룹 | 재입력 필요 |
| `calendar.json` | 일정 | 재입력 필요 |
| `manualAccounts.json` | 수동 계좌 평단·수량 | 재입력 필요 |
| `signalConfig.json`, `alertConfig.json` | 신호등·시그널 기준 | 재설정 필요 |
| `telegramChannels.json` | 채널 on/off 선택 | 180개 다시 골라야 함 |
| `alertState.json`, `telegramOffsets.json` | 중복방지 상태 | 잃어도 무방 (하루치 중복만) |

**전환 절차**: 메인PC 서버를 끈 뒤 `server\data` 폴더를 통째로 미니PC의 같은 경로에 복사.
서버가 돌고 있는 중에 복사하면 쓰기 도중 파일이 깨질 수 있으므로 **반드시 끄고** 복사할 것.

> 두 PC를 병행하는 동안은 **양쪽 data가 갈라진다.** 특히 `breadth.json`은
> 켜져 있던 쪽에만 그날치가 남으므로, 최종적으로 미니PC를 기준으로 삼고
> 메인PC 것은 버리든지 날짜별로 합치든지 결정해야 한다.

---

## 2. 텔레그램 MTProto 세션 — 미니PC에서 로그인할 것

**세션은 한 대에서만 써야 한다.** 같은 세션 문자열로 두 대가 동시에 접속하면
`AUTH_KEY_DUPLICATED`가 나면서 세션이 무효화되고 다시 로그인해야 한다.

따라서 메인PC에서 로그인해서 세션을 미니PC로 복사하는 방식은 **하지 말 것.**
처음부터 미니PC에서 로그인한다.

```
# 미니PC에서
cd C:\vntg-hts\server
node scripts\telegram-login.mjs
```

전화번호 → 인증코드 → (2FA 있으면) 비밀번호 순으로 입력하면 세션 문자열이 나온다.
그걸 `.env`의 `TELEGRAM_SESSION`에 넣는다.

> ⚠ 세션 문자열 = 계정 전체 권한. 채팅창·커밋·메모장 어디에도 남기지 말 것.
> 유출됐다면 `my.telegram.org` → 활성 세션에서 즉시 종료.

이어서 구독 목록을 가져온다:

```
node scripts\telegram-dialogs.mjs
```

또는 웹 `설정 > 구독 채널 수집`에서 **구독 목록 새로고침**.
**처음 발견된 채널은 전부 꺼진 상태**로 들어오므로, 시황 얘기가 실제로 오가는 것만 켠다.

---

## 3. 전환 후 확인

```
curl.exe http://localhost:4000/api/health
```

`keysConfigured` 가 전부 true인지, `addresses` 에 Tailscale IP가 있는지 본다.

그다음 웹에서:

- `설정 > API 사용량` — 키움 호출이 성공하는지
- `설정 > 구독 채널 수집` — "세션 미설정" 안내가 사라졌는지
- `설정 > 관심종목 시그널` → **지금 검사(미리보기)** — 상태를 안 남기므로 안전하게 확인 가능
- `시황 대시보드 > 시장 폭 추이` — 누적 일수가 맞는지

작업 스케줄러(`VNTG HTS`, AtStartup, SYSTEM)가 살아 있는지도 재부팅 한 번으로 확인.

---

## 4. 메인PC 정리

미니PC가 정상 동작을 확인한 뒤에:

- 메인PC 서버 종료 (스케줄러 등록했다면 해제)
- 개발은 계속 메인PC에서 하되 **서버는 띄우지 않는다** — 특히 텔레그램 세션과
  리포트 스케줄러가 양쪽에서 돌면 알림이 두 번 가고 세션이 깨진다
- 코드 수정 → `push.cmd` → 미니PC에서 `update.cmd` 흐름은 그대로 유지

> 개발 중 로컬 서버가 필요하면 띄워도 되지만, `.env`에서
> **텔레그램 관련 키를 비워둔 개발용 .env**를 쓰는 게 안전하다.
> 그러면 발송·세션 충돌 없이 화면만 확인할 수 있다.
