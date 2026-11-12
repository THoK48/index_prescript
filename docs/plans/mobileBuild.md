# 모바일 설치 파일 빌드

## 목적·범위

최신 단말기 화면, Android 캘린더 위젯, 지정 알림음을 포함한 디버그 APK를 생성한다. iOS는 Capacitor Swift Package Manager 프로젝트와 음원 번들을 준비한다.

## 제외

스토어 제출, 릴리스 키 생성·교체, Apple 계정·서명 설정, 실제 기기 설치, iOS 위젯 신규 구현은 포함하지 않는다. 기존 검증 생략 요청을 유지하며 요청된 빌드와 필수 빌드 진단만 실행한다.

## 입력·의존성

Node.js, Java 21, 설치된 Android SDK, Capacitor 8.5.3을 사용한다. iOS 플랫폼 패키지는 core와 같은 8.5.3이며 local notifications도 SwiftPM에 연결한다. Android 위젯 브리지는 iOS에서 호출하지 않는다. WAV는 iOS 앱의 Copy Bundle Resources에 별도 포함하여 설치 후 네트워크 없이 알림에 사용한다.

## 단계

1. 웹 정적 빌드.
2. Android Capacitor 동기화 및 assembleDebug.
3. iOS 프로젝트 생성, WAV 번들 연결, 웹 자산 동기화.
4. APK는 성공한 빌드 결과만 전달하고 iOS 결과는 소스 프로젝트와 IPA 여부를 구분한다.
5. 비교용 프로젝트, 전체 소스 ZIP 및 Mac 전달용 프로젝트 ZIP을 갱신한다.

## 빌드 확인·환경 경계

웹 빌드 성공 로그와 Android BUILD SUCCESSFUL을 확인한다. APK 파일·서명과 패키지 식별자는 결과 전달 과정에서 확인한다. 테스트와 별도 타입 검사·브라우저 검증은 요청하지 않았으므로 실행하지 않는다.

현재 실행 호스트는 Windows이며 Xcode가 없다. iOS 네이티브 빌드·서명·IPA export는 여기서 수행할 수 없다. Mac에서 직접 후속 빌드하거나 `.github/workflows/iosBuild.yml`을 GitHub Actions의 macOS 26 환경에서 실행한다. IPA 배포는 해당 Apple 개발·배포 서명 요건이 충족된 경우에만 가능하다.

## 위험·대응

Windows Java 21의 NIO 내부 Unix-domain pipe 연결이 `Invalid argument: connect`로 실패하는 환경을 위해 `android/gradlew.bat`가 빌드 프로세스에만 `jdk.net.unixdomain.tmpdir`을 설정한다. 이 값은 디렉터리가 아닌 기존 `gradle.properties` 파일을 가리켜 JDK의 listener 생성 실패 후 TCP loopback 대체 경로를 사용하게 한다. `JAVA_TOOL_OPTIONS`로 launcher와 단발성 Gradle JVM 모두에 전달하며 `SETLOCAL`로 호출자 환경을 보존한다. 시스템 전역 Java 설정과 앱 런타임에는 적용하지 않는다. wrapper 재생성 시 이 Windows 설정을 보존해야 한다. `org.gradle.daemon=false`만으로 단발성 build JVM 생성을 막을 수는 없다. 기존 APK가 존재하더라도 새로운 빌드 성공 전에는 완료로 표시하지 않는다. 재현과 복구 결과는 [로컬 APK 빌드 복구](localApkBuildRepair.md)에 기록한다.

## 복구·인계

이전 APK를 별도 파일로 보존하고 성공한 신규 APK를 날짜별 이름으로 제공한다. 원본 저장 데이터는 변경하지 않는다. iOS 프로젝트 ZIP에는 npm lockfile과 설치된 의존성의 경로 관계를 유지하는 전체 앱 소스를 포함하되 node_modules와 빌드 캐시는 제외한다. iOS IPA는 Mac/Xcode 환경에서 후속 빌드가 필요하다.

## 이번 빌드 결과

### 2026-10-15 Planner 보완 APK 빌드

사용자의 APK 빌드 요청에 따라 최신 User Context, 완료 원본 재발행 방지, 지난 마감 표시 보완, Task의 1~4분 잔여량 마무리, 상세 루틴의 회차별 누적 수행을 포함한다. versionCode 4 / versionName 1.0.3으로 올리고 기존 앱 ID와 고정 서명을 유지한다. 표준 `npm run android:apk`로 웹 빌드 → Capacitor 동기화 → Android debug 빌드를 실행한 뒤 이전 v1.0.2와 인증서를 비교한다. 기존 APK·데이터·키는 보존하고 새 APK를 별도 파일로 전달한다. 별도 테스트·브라우저 검증·기기 설치·커밋·푸시는 하지 않는다.

- 결과: 웹 빌드·내장 TypeScript 검사·Capacitor 동기화 성공, Android `BUILD SUCCESSFUL in 32s`.
- 전달 파일: `outputs/지령 단말기-v1.0.3.apk`, 7,693,265 bytes.
- SHA-256: `2d17f57c8419a363fab8b20a915577a88cc87d926b3eff75d33c86c5d8895047`.
- 패키지 `com.directive.terminal`, versionCode 4, versionName 1.0.3. 원본·전달 파일의 서명 검증 및 해시 일치를 확인했다.
- 인증서 `3ecf3515ec98277005128711c4c305b177982c7f20457056b55506dc3e8d83a2`는 기존 v1.0.2와 동일하다. 고정 키의 v1.0.1·v1.0.2에서 삭제 없이 업데이트할 수 있으며, 10월 14일 CI 설치본의 서명 차이 제한은 유지된다.
- APK 내부의 회차별 누적 진행과 Planner 보류 코드, WAV 5개·폰트 3개 포함을 확인했다. 개인 키 파일은 포함되지 않는다. 이전 APK와 사용자 저장 데이터는 변경하지 않았다.

### 2026-10-15 픽셀 글꼴 적용 재빌드

사용자의 APK 빌드 재개 요청에 따라 현재 픽셀 글꼴, 작은 원형 도트 표시, 복호화 잔광, 백업 복원 개선을 포함한다. versionCode 3 / versionName 1.0.2로 올리고 기존 고정 키를 유지한다. 웹 빌드 → Capacitor 동기화 → Android debug 빌드 → 서명·버전·폰트 포함 확인을 수행한다. 기존 APK는 보존하며 새 파일로 전달한다. 테스트·별도 타입 검사·브라우저 검증, 기기 설치, GitHub 키 등록, 커밋·푸시는 이번 요청에 포함하지 않는다.

- 결과: 표준 `npm run android:apk` 전체 성공. 웹 빌드의 TypeScript 컴파일을 통과했으며 Android는 `BUILD SUCCESSFUL in 30s`로 완료했다.
- 전달 파일: `outputs/directiveTerminal-2026-10-15-v1.0.2.apk`, 7,677,473 bytes.
- APK SHA-256: `f449a54dc91c1e6f9557a7da5efffea2ff8d70bd70a12a226de922e9320a895e`.
- 패키지 `com.directive.terminal`, versionCode 3, versionName 1.0.2. v2 서명 검증을 통과했으며 인증서가 이전 v1.0.1과 동일하다.
- GalmuriMono11·Gothic Dot Round와 각 라이선스, 잔광 CSS가 APK에 포함됐다. 개인 서명 키는 APK에 포함되지 않는다.
- v1.0.1 등 같은 고정 키의 로컬 버전에서 업데이트할 수 있다. 분실한 CI 키로 서명된 10월 14일 설치본은 여전히 1회 백업·복원 이전이 필요하다.
- 이전 APK·서명 키·휴대폰 데이터는 변경하지 않았다. 테스트·별도 타입 검사·브라우저·실기기 설치는 수행하지 않았다.

### 이전 빌드 기록

2026-10-15 로컬 Windows 빌드를 복구했으며, 표준 `npm run android:apk`가 전체 성공했다. 이후 고정 키를 지정한 v1.0.1을 빌드했으며 최신 전달 파일은 `outputs/directiveTerminal-2026-10-15-v1.0.1.apk`다. 서명과 1회 데이터 이전 안내는 [Android 서명 고정](stableAndroidSigning.md), 최초 빌드 복구 결과는 [로컬 APK 빌드 복구](localApkBuildRepair.md)를 따른다. GitHub 키 등록은 별도 승인 대기 중이며 원격 workflow 변경은 아직 푸시하지 않았다. 아래 내용은 2026-10-13 빌드 기록으로 보존한다.

- 웹 정적 빌드 성공. 빌드에 포함된 TypeScript 컴파일도 완료되었다.
- Android 최종 assembleDebug 성공: BUILD SUCCESSFUL in 12s.
- 디버그 APK의 v2 서명 확인. 패키지는 com.directive.terminal, minSdk 24, targetSdk 36이다.
- APK에 지정 WAV, 캘린더 위젯 layout, Capacitor 설정 파일이 포함되었다.
- 전달 파일은 outputs/directive-terminal-2026-10-13-debug.apk이며 기존 APK는 별도 보존한다.
- iOS 프로젝트 생성과 웹 자산 동기화 완료. 지정 WAV를 Xcode Copy Bundle Resources에 포함했다.
- iOS 네이티브 컴파일·IPA 생성은 로컬에서 실행하지 못했다. Windows에 Xcode가 없는 환경 제약이며 Mac 또는 준비된 GitHub Actions에서 후속 빌드가 필요하다.
- 테스트·별도 typecheck·브라우저 검증은 기존 요청에 따라 생략했다.
