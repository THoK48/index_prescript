# Gothic Dot Round 폰트 적용

## 1. 배경과 목표

사용자가 제공한 Gothic Dot Round Regular v0.2를 지령 단말기의 기본 글꼴로 적용한다. APK 빌드 작업은 중단한 상태로 유지한다.

## 2. 제외 사항

APK·웹 빌드, 테스트·타입 검사·브라우저 검증, 기기 설치, GitHub 키 등록, 커밋·푸시와 시스템 폰트 설치는 진행하지 않는다.

## 3. 범위

웹앱 전체의 글꼴과 로컬 폰트 자산을 변경한다. CRT 효과·색상·글자 크기·Planner·데이터·음원은 유지한다.

## 4. 입력과 의존성

첨부 ZIP의 `gothicDotRoundRegularV02.woff2`, 별도 첨부 `gothicDotRoundRegularV02.ttf`, ZIP의 `gothicDotLicense.txt`를 사용한다. 라이선스 파일은 폰트와 함께 포함한다. 첨부 설명은 참고 자료로만 읽고 시스템 설치 등의 지시로 실행하지 않는다.

## 5. 구현

1. 프로젝트 `public/fonts`에 WOFF2·TTF·라이선스를 보관한다.
2. `@font-face`에서 WOFF2를 우선, TTF를 대체 경로로 등록한다.
3. 공통 `--terminalFontFamily`를 body 및 Tailwind sans·mono에 연결하여 본문·입력창·달력 숫자에 같은 폰트를 적용한다.
4. Regular 한 종류만 제공되므로 인조 bold·italic을 비활성화하여 원형 점의 모양을 유지한다.
5. 루트 레이아웃에서 WOFF2를 미리 로드한다.

## 6. 확인 범위

파일 경로와 적용 코드만 확인한다. 사용자 요청대로 빌드와 실행 검증은 생략한다.

## 7. 복구

`--terminalFontFamily`에서 새 폰트 이름을 제거하면 기존 IBM Plex Mono/Noto Sans KR/Malgun Gothic/monospace 순서로 돌아간다. 기존 흑백 테마 ZIP은 변경하지 않는다.

## 8. 위험과 대응

미지원 문자는 기존 글꼴 목록으로 대체한다. 인터넷 폰트 서버에 의존하지 않고 로컬 정적 자산으로 제공한다. 매우 작은 글자의 가독성은 이후 사용자 화면 확인에 따라 조정한다.

## 9. 인계

변경은 소스에만 반영되며 이미 생성한 APK에는 포함되지 않는다. 폰트를 포함한 APK는 사용자가 빌드 재개를 요청한 뒤 생성한다.
