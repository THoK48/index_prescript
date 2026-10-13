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

Windows Java 21의 NIO 내부 Unix-domain pipe 연결이 Invalid argument: connect로 실패하면, 해당 빌드 프로세스에만 jdk.net.unixdomain.tmpdir을 존재하지 않는 작업 전용 경로로 지정한다. JDK의 listener 생성 실패 후 TCP loopback 대체 경로를 사용하며 기기 앱이나 시스템 전역 Java 설정은 변경하지 않는다. 기존 APK가 존재하더라도 새로운 빌드 성공 전에는 완료로 표시하지 않는다.

## 복구·인계

이전 APK를 별도 파일로 보존하고 성공한 신규 APK를 날짜별 이름으로 제공한다. 원본 저장 데이터는 변경하지 않는다. iOS 프로젝트 ZIP에는 npm lockfile과 설치된 의존성의 경로 관계를 유지하는 전체 앱 소스를 포함하되 node_modules와 빌드 캐시는 제외한다. iOS IPA는 Mac/Xcode 환경에서 후속 빌드가 필요하다.

## 이번 빌드 결과

- 웹 정적 빌드 성공. 빌드에 포함된 TypeScript 컴파일도 완료되었다.
- Android 최종 assembleDebug 성공: BUILD SUCCESSFUL in 12s.
- 디버그 APK의 v2 서명 확인. 패키지는 com.directive.terminal, minSdk 24, targetSdk 36이다.
- APK에 지정 WAV, 캘린더 위젯 layout, Capacitor 설정 파일이 포함되었다.
- 전달 파일은 outputs/directive-terminal-2026-10-13-debug.apk이며 기존 APK는 별도 보존한다.
- iOS 프로젝트 생성과 웹 자산 동기화 완료. 지정 WAV를 Xcode Copy Bundle Resources에 포함했다.
- iOS 네이티브 컴파일·IPA 생성은 로컬에서 실행하지 못했다. Windows에 Xcode가 없는 환경 제약이며 Mac 또는 준비된 GitHub Actions에서 후속 빌드가 필요하다.
- 테스트·별도 typecheck·브라우저 검증은 기존 요청에 따라 생략했다.
