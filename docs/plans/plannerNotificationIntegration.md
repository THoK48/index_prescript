# Planner-Centered Notification Integration

## 1. Context and goal

The app currently replaces every pending local notification whenever state changes. This makes routine reminders and ACTIVE directive reminders independent, duplicates notifications, and provides no durable "already announced" boundary.

This change makes Planner state transitions authoritative: a directive notification represents a newly created ACTIVE ticket, a routine notification is informational only, and an end confirmation asks for a result without resolving the ticket.

## 2. Non-goals

- Do not run the Planner continuously in the Android background.
- Do not replace an existing ACTIVE directive at a routine boundary.
- Do not auto-complete or auto-fail a directive.
- Do not add AI, a server, or a new database.
- Do not introduce FIXED/FLEXIBLE persistence until real usage requires that distinction; current enabled routines are treated as fixed boundaries.

## 3. Scope

### In scope

- Include the next enabled routine start in shared available-time calculation.
- Detect routine boundaries while the app is visible and reevaluate only when no ACTIVE exists.
- Pre-schedule informational routine reminders for background or terminated operation.
- Send one directive-issued notification for each new ACTIVE ticket.
- Suppress the immediate directive-issued system notification when the app was visible at the transition; the in-app directive and issuance sound remain unchanged.
- Schedule one expected-end confirmation for each ACTIVE ticket and cancel obsolete confirmations.
- Keep managed notification IDs stable and synchronize only this app feature's reservations.
- Expose notification and Android exact-alarm permission state in Settings.
- Reevaluate on a routine notification tap.

### Out of scope

- Native background Planner execution.
- Automatic interruption of an ACTIVE directive.
- iOS WidgetKit or server push notifications.

## 4. Inputs and dependencies

- `@capacitor/local-notifications` v8
- Current localStorage-backed `AppState`
- Existing custom WAV notification channel
- Existing deterministic Planner and ticket state machine

## 5. Implementation

1. Add calendar helpers for future routine occurrences and the next fixed routine boundary.
2. Extend `getAvailableWindow` so the earlier of the next schedule and next routine start limits work duration.
3. Split native notification construction and synchronization by kind: directive issued, routine start, and directive end confirmation.
4. Persist minimal notification delivery metadata outside `AppState` so state backups and Planner inputs remain unchanged.
5. Add foreground routine timers and notification-tap handling to `LocalStateProvider`; reject reevaluation when ACTIVE already exists.
6. Add notification permission status and exact-alarm settings access to the Settings page.
7. Add Android exact-alarm permission and update documentation/tests.
8. Mirror source changes to the comparison copy and refresh the downloadable source archive.
9. Capture document visibility before queued native synchronization and mark foreground-issued tickets as announced without posting a system notification.

## 6. Validation checklist

- [x] The same ACTIVE ticket is guarded by a persisted issue-notification receipt.
- [x] A foreground-issued ACTIVE ticket updates that receipt without displaying an immediate system notification.
- [x] An ACTIVE ticket has one end-confirmation identity and no automatic resolution path.
- [x] Resolving or replacing ACTIVE removes its pending end confirmation during synchronization.
- [x] A visible app creates a directive at a routine boundary only when no ACTIVE exists.
- [x] A visible app with an ACTIVE keeps it and emits only routine information.
- [x] A background app schedules routine information without creating ACTIVE state.
- [x] The earlier routine/schedule boundary limits Task and Routine duration with a five-minute transition buffer.
- [x] Notification permission and Android exact-alarm state can be inspected.
- [x] Existing UI and local state schema remain compatible by design.

Per the standing user instruction, automated test, typecheck, build, browser, and device validation are intentionally not executed for this change.

## 7. Rollback plan

Revert the notification coordinator, foreground boundary effect, Planner routine-boundary parameter, Settings permission panel, and manifest permission. Existing AppState remains readable because notification metadata uses a separate localStorage key.

## 8. Risks and mitigations

- Android can revoke exact-alarm access: expose status and keep Capacitor's inexact fallback available.
- Browser timers pause in background: schedule native routine information while hidden and reevaluate on foreground/tap.
- Concurrent sync calls can race: serialize notification synchronization and use stable IDs.
- Local notification delivery cannot atomically mutate web storage while terminated: mark a reminder as scheduled once so later sync cannot duplicate it.
- Native synchronization is serialized and may run after visibility changes: capture visibility when synchronization is requested, before queueing the work.

## 9. Handoff notes

Current routines are treated as fixed start boundaries. A later `RoutineTimingMode` migration can filter the same occurrence helper to `FIXED` without changing the Planner priority tiers or notification kinds.

Foreground suppression applies only to the immediate `directiveIssued` alert. Routine reservations and ACTIVE end confirmations retain their existing behavior, while the directive state transition, widget synchronization, and in-app audio/visual issuance sequence are unaffected.
