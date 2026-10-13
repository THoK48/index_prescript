# GitHub Actions iOS 빌드

## 목적

Windows 호스트에서 직접 실행할 수 없는 Xcode 빌드를 GitHub Actions의 macOS 26 실행 환경에서 수행한다. Capacitor 8의 최소 요구사항인 Xcode 26 이상을 사용하며, 수동 실행 시 빌드 종류를 선택한다.

## 범위

- `simulator`: Apple 서명 정보 없이 iOS 시뮬레이터용 `.app`을 컴파일하고 ZIP으로 보관한다.
- `unsignedIpa`: 실제 iPhone용 아키텍처로 빌드한 미서명 `.ipa`를 만든다. 기기에 설치하려면 별도로 Apple 계정으로 서명해야 한다.
- `signedIpa`: Apple 인증서와 프로비저닝 프로파일을 GitHub Actions Secrets에서 임시 키체인에 설치하고 실제 기기 배포용 IPA를 내보낸다.
- Node.js 24에서 의존성 설치, Next.js 정적 빌드, Capacitor iOS 동기화를 수행한다.
- 빌드 산출물은 GitHub Actions Artifacts에 14일간 보관한다.

## 제외

GitHub 저장소 생성·업로드, Apple Developer 등록, 인증서·프로비저닝 프로파일 발급, App Store Connect 업로드는 자동화하지 않는다. 서명 없는 시뮬레이터 산출물은 실제 iPhone에 설치할 수 있는 IPA가 아니다. 미서명 기기용 IPA도 단독으로 설치되지 않는다.

## 무료 Apple 계정으로 본인 iPhone에 설치

`unsignedIpa`를 실행해 나온 Artifact를 내려받고 `.ipa`를 추출한다. Windows용 AltServer의 `Sideload .ipa…` 기능은 이 파일을 Apple 계정으로 서명하여 연결된 iPhone에 설치할 수 있다. iOS 16 이상에서는 기기의 개발자 모드가 필요하다. 무료 계정의 프로비저닝 프로파일은 7일 후 만료되므로 앱을 다시 서명·설치해야 한다. 이 방식은 본인 기기 시험용이며 다른 사람에게 바로 설치 가능한 IPA를 배포하는 방식은 아니다.

AltStore 공식 안내: https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows 및 https://faq.altstore.io/release-notes/altserver

## signedIpa 입력

Repository Secrets에 다음 값을 설정한다.

- `IOS_CERTIFICATE_BASE64`: 개인 키가 포함된 `.p12` 파일의 Base64 문자열
- `IOS_CERTIFICATE_PASSWORD`: `.p12` 내보내기 암호
- `IOS_PROVISIONING_PROFILE_BASE64`: `.mobileprovision` 파일의 Base64 문자열
- `IOS_KEYCHAIN_PASSWORD`: 빌드 중 생성할 임시 키체인 암호
- `IOS_TEAM_ID`: Apple Developer Team ID

실행할 때 프로파일 용도에 맞춰 `debugging`, `release-testing`, `app-store-connect` 중 하나를 선택한다. `debugging`은 Apple Development 인증서, 나머지는 Apple Distribution 인증서를 사용한다.

## 처리 흐름

1. 저장소 체크아웃과 Node.js 24 설정
2. `npm ci` 후 `npm run ios:sync`
3. Xcode 26 이상 여부 확인
4. `simulator`이면 서명 없이 generic iOS Simulator 대상으로 빌드
5. `unsignedIpa`이면 서명 없이 generic iOS 기기 대상으로 빌드하고 `Payload/App.app`을 IPA로 포장
6. `signedIpa`이면 Secrets 누락 여부 확인 후 임시 키체인과 프로파일 설치
7. 기기용 archive 생성 후 `xcodebuild -exportArchive`로 서명된 IPA 생성
8. 산출물 업로드 후 임시 키체인과 프로파일 제거

## 검증 경계

현재 Windows 환경에서는 워크플로 파일과 프로젝트 경로만 확인한다. 실제 macOS/Xcode 컴파일은 이 프로젝트를 GitHub 저장소에 올린 뒤 Actions에서 수동 실행해야 확인할 수 있다. 사용자의 기존 요청에 따라 로컬 테스트·타입 검사·추가 빌드는 실행하지 않는다.

## 보안

서명 파일 원문은 저장소에 추가하지 않는다. 워크플로는 GitHub가 주입한 Secrets를 실행 중 임시 파일로만 복원하고 `always()` 정리 단계에서 키체인, 인증서, 프로비저닝 프로파일을 삭제한다.
