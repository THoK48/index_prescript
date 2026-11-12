# Routine Timing and Notification Diagnostics

## 1. Context and goal

Real use exposed four usability gaps: overlapping routine windows are easy to save accidentally, every routine currently behaves like a hard time boundary, an overdue ACTIVE directive gives no compact in-place action, and native notification reservations are difficult to inspect.

This change keeps the single-ACTIVE invariant and deterministic Planner while making those states explicit and recoverable from the UI.

## 2. Scope

1. Warn before saving a routine whose weekly time window overlaps another routine, while allowing an intentional overlap after a second confirmation.
2. Persist `FIXED` and `FLEXIBLE` routine timing modes. Only FIXED starts constrain available time and trigger automatic foreground reevaluation.
3. Show elapsed expected-end time on the ACTIVE directive and provide `완료`, `실패`, and `계속 수행`. Continuing extends only the reminder deadline and never resolves the directive.
4. Add native notification diagnostics: pending count, next reservation, a ten-second test, exact-alarm state, and manual reservation resynchronization.
5. Reject identical start/end times and label an earlier end explicitly as next-day, including its total duration.

## 3. Compatibility

- Existing routines migrate to `FIXED` to preserve their current behavior.
- Existing tickets remain valid because reminder extension is optional.
- Background routine information remains scheduled for both timing modes; only automatic Planner boundaries are FIXED-only.
- Notification test reservations are preserved during ordinary state synchronization.

## 4. Implementation notes

- Compare weekly routine intervals with wrap-around support for overnight and Sunday-to-Monday windows.
- Treat `05:00~04:00` as an explicit 23-hour next-day window and reject `00:00~00:00` instead of silently treating it as 24 hours.
- Retain the existing same-start duplicate rejection even after overlap confirmation.
- Store `extendedUntil` on a ticket so a continue action does not rewrite its issue time or Task progress duration.
- Reuse the serialized native notification queue for explicit reservation refreshes.
- Keep notification inspection outside Planner inputs and AppState.

## 5. Validation

Automated tests, typecheck, build, browser validation, and device validation are intentionally skipped under the standing user instruction. Source-level regression cases are updated for the next requested validation run.

## 6. Rollback

Remove the optional timing mode and ticket extension fields, restore all routines as Planner boundaries, remove the overlap confirmation UI, and return the Settings notification panel to permission-only status. Older stored data remains readable because both added fields are backward-compatible.
