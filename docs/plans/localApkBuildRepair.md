# 로컬 APK 빌드 복구

## 1. 배경과 목표

Windows에서 `npm run android:apk`가 실제 APK를 생성하도록 복구한다. 현재 Java 21.0.10의 Gradle 시작 단계에서 `Unable to establish loopback connection`이 발생하며, 가장 안쪽 원인은 `UnixDomainSockets.connect0`의 `Invalid argument: connect`다. 앱 컴파일 이전의 Java NIO 내부 파이프 생성 실패다.

## 2. 제외 사항

앱 도메인과 UI 변경, Java 전역 환경 설정, 시스템 보안 설정 변경, Git 커밋·푸시, 기기 설치는 하지 않는다.

## 3. 범위

Windows Gradle wrapper, 관련 문서, 최신 소스의 로컬 debug APK 생성이 대상이다. Linux CI wrapper와 iOS 빌드는 변경하지 않는다.

## 4. 입력과 의존성

설치된 Java 21, Gradle 8.14.3, Android SDK 36, 현재 npm lockfile과 Capacitor 프로젝트를 사용한다. 이전 작업의 `nativeBridge.ts` 변경을 보존하고 새 APK에 포함한다.

## 5. 구현 단계

1. 기존 wrapper로 오류와 전체 원인 스택을 재현한다.
2. Windows wrapper의 로컬 환경에만 `jdk.net.unixdomain.tmpdir`을 설정한다. 소켓 파일을 생성할 수 없는 기존 `gradle.properties` 파일을 경로로 사용해 JDK의 TCP loopback 대체 경로를 선택한다.
3. `JAVA_TOOL_OPTIONS`로 launcher와 자식 build JVM에 같은 값을 전달하며, `SETLOCAL`로 호출자 환경은 보존한다.
4. 표준 `npm run android:apk`로 웹 빌드, Capacitor 동기화, 네이티브 빌드를 실행한다.
5. 새 APK의 생성 시각, 패키지·서명 정보를 확인하고 다운로드 경로로 전달한다.

## 6. 검증

- [x] 기존 설정의 실패와 Java 내부 원인 스택 재현.
- [x] 수정된 표준 APK 명령 성공.
- [x] `BUILD SUCCESSFUL` 및 신규 APK 확인.
- [x] APK 패키지·서명 확인.
- [x] 호출자의 `JAVA_TOOL_OPTIONS`가 변경되지 않음 확인.

이번 요청에 필요한 실제 빌드와 산출물 확인을 수행한다. 기존 검증 생략 방침에 따라 별도 앱 테스트·타입 검사·브라우저 검증은 추가하지 않는다.

## 7. 복구

wrapper의 추가 환경 설정과 Gradle 설정 주석을 되돌리면 기존 실행 방식으로 복구된다. 저장 데이터·시스템 Java 설정은 변경하지 않는다. 기존 전달 APK는 보존한다.

## 8. 위험과 대응

Gradle wrapper를 재생성하면 사용자 정의 Windows 설정이 사라질 수 있으므로 해당 동작을 모바일 빌드 문서에 기록한다. 옵션은 Windows wrapper로 실행한 Java 프로세스 트리에만 적용하며 Linux CI와 앱 런타임에는 포함하지 않는다. `org.gradle.daemon=false`만으로 단발성 build JVM 생성을 막을 수는 없다.

## 9. 인계

실행 명령은 프로젝트 루트의 `npm run android:apk`다. 성공 로그와 실제 산출물을 확인한 뒤 결과를 기록한다.

### 2026-10-15 결과

- 수정 전 동일한 wrapper에서 `PipeImpl → UnixDomainSockets.connect0 → Invalid argument: connect`를 재현했다.
- 수정 후 직접 Android 빌드가 `BUILD SUCCESSFUL in 34s`로 완료됐다.
- 표준 `npm run android:apk`가 웹 정적 빌드·내장 TypeScript 컴파일·Capacitor 동기화·Android 빌드를 모두 통과했다. 최종 Gradle 단계는 `BUILD SUCCESSFUL in 14s`다.
- `apksigner verify --verbose --print-certs` 통과. 패키지는 `com.directive.terminal`, minSdk 24, targetSdk 36이다.
- APK 내부 JavaScript에서 `suppressIssuedNotification` 옵션을 확인해 직전 전면 알림 수정의 포함을 확인했다. 지정 WAV와 캘린더 위젯 자산도 포함됐다.
- 전달 파일: `outputs/directive-terminal-2026-10-15-local-debug.apk`.
- SHA-256: `46e09c6dfa65795956b9f8e9d67aa9b0bd76aa34a47a419b6554c5984395d694`.
- 기존 `JAVA_TOOL_OPTIONS=-DdirectiveBuildProbe=true`를 가진 동일 cmd 세션에서 wrapper 실행 후 해당 값이 그대로 유지됨을 확인했다.
- 10월 14일 전달 APK의 서명 SHA-256은 `89a88331bd63f6410163d6dde68a92e45973af2d75e4791c3888cb4b374120ba`, 이번 로컬 APK는 `3ecf3515ec98277005128711c4c305b177982c7f20457056b55506dc3e8d83a2`로 다르다. 이전 APK가 설치되어 있으면 이 파일로 덮어쓰기 업데이트할 수 없다. 기존 앱·데이터·APK는 변경하지 않았으며, 앱을 교체할 경우 먼저 설정의 데이터 내보내기로 백업해야 한다.
- SDK XML 버전·flatDir 관련 경고는 남아 있지만 빌드 실패 원인은 아니며 이번 빌드는 성공했다.

### 10월 14일 설치본 업데이트 호환성 조사

- 사용자가 현재 설치한 파일을 `directive-terminal-2026-10-14-debug.apk`로 확인했다.
- 로컬 `.android/debug.keystore`는 10월 13일 APK 및 최신 로컬 APK의 `3ecf…` 인증서와 일치하며, 설치본의 `89a8…` 인증서와 다르다.
- 프로젝트·비교 프로젝트·Downloads의 키 파일과 소스/iOS ZIP의 키 백업을 조사했으나 설치본과 같은 개인 키를 찾지 못했다. 타 프로젝트의 키는 사용하지 않았다.
- 해당 GitHub 저장소의 Actions 산출물·캐시 목록을 읽기 전용으로 확인했다. 실행 `38548476925`의 산출물은 `directive-terminal-debug-apk` 한 개뿐이며 npm·Gradle 의존성 캐시만 있다. 당시 workflow는 APK만 업로드하며 키를 저장하지 않는다. setup-java v4의 Gradle 캐시는 `.gradle/caches`와 `.gradle/wrapper`만 포함하므로 `.android/debug.keystore`가 보관되지 않는다.
- 기존 개인 키 없이는 현재 설치본과 호환되는 업데이트 APK에 서명할 수 없다. 인증서나 APK에서 개인 키를 복원하는 방식으로 해결할 수는 없다.
- 기존 앱 삭제, 데이터 초기화, 다른 키로 강제 설치는 실행하지 않았다. 기존 키 백업을 제공받거나, 사용자가 명시적으로 1회 백업·복원 이전을 선택해야 다음 단계로 진행할 수 있다.
