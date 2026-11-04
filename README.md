# 정신건강사업 실적판

계획서 10종(주요업무계획, 구정성과, 부서별 성과관리, 예산의 성과지표, 행정사무감사, 지역보건의료계획, 센터 계획서, 아동정책계획, 청년정책계획, 인권계획)별 성과지표의 연간 목표와 날짜별 실적을 팀이 함께 입력하고 한눈에 보는 웹 화면입니다.

- Cloudflare Workers: 화면(정적 파일)과 `/api/*`
- Cloudflare D1: 지표·실적 저장 (`mental-health-db`)
- 팀 비밀번호 로그인: Worker 비밀값 `APP_PASSCODE` (설정하지 않으면 화면과 데이터를 아예 보여주지 않음)
- GitHub → Cloudflare Workers Builds: main에 push하면 자동 배포

데이터는 Cloudflare 계정의 D1에만 저장되며 Claude 서버에는 저장되지 않습니다.

## 처음 한 번만 설정

1. Cloudflare 대시보드 → Workers & Pages → Create → Import a repository(Workers Builds)에서 이 저장소를 연결합니다.
   - Worker 이름: `mental-health-performance` (`wrangler.jsonc`와 동일)
   - Build command: 비워 둠
   - Deploy command: `npx wrangler d1 migrations apply mental-health-db --remote && npx wrangler deploy`
2. Worker → Settings → Variables and Secrets → **Secret** 추가: 이름 `APP_PASSCODE`, 값은 8자 이상의 팀 비밀번호.
3. 배포된 `https://mental-health-performance.<계정>.workers.dev` 주소로 접속해 비밀번호로 로그인합니다.
4. (권장) 더 강하게 막으려면 Cloudflare Zero Trust → Access에서 이 주소를 팀 이메일만 허용하도록 보호합니다. 이 경우 `APP_PASSCODE`는 2차 잠금으로 남겨 두면 됩니다.

비밀번호는 소스 파일, GitHub, 대화 내용에 넣지 않습니다. 바꿀 때는 Secret 값을 새로 저장하면 기존 로그인은 모두 풀립니다.

## 로컬 실행·검증

```
npm install
npm test        # Worker 로직 테스트(Node 내장 SQLite) + 화면 스크립트 문법 검사
echo 'APP_PASSCODE=로컬용비밀번호' > .dev.vars   # .gitignore에 포함됨
npm run dev     # 로컬 D1로 http://localhost:8787
```

## 구조

- `worker/index.js` 로그인, 보안 헤더, API (`/api/data`, `/api/plans`, `/api/plans/copy`, `/api/records`)
- `public/` 화면 (`index.html`, `app.js`, `app.css`, 로그인용 `login.js`, `login.css`)
- `migrations/` D1 스키마
- `tests/` Worker 테스트

## 보안 메모

- 로그인 없이는 `/api/*`와 화면 모두 401/로그인 화면만 응답합니다(로그인용 CSS/JS 제외).
- 세션 쿠키는 HttpOnly·Secure·SameSite=Strict이며 14일 후 만료됩니다.
- 쓰기 요청은 같은 출처(Origin)만 허용하고, CSP·X-Frame-Options·noindex 헤더를 붙입니다.
- 실적 비고란에는 대상자 이름 등 개인정보를 적지 않는 것을 원칙으로 합니다.
- 비밀번호를 아는 사람은 누구나 모든 지표·실적을 보고 수정·삭제할 수 있습니다(개별 계정 없음). 입력자 이름은 자기 신고입니다.
