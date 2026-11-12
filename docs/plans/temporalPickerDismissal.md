# Temporal Picker Outside-Dismissal

## Context and goal

Native date/time controls and the routine time popover can remain visible after the user continues elsewhere. All date-related controls should close when an outside area is pressed, without changing their selected value.

## Scope

- Blur focused `date`, `datetime-local`, `time`, `month`, and `week` inputs on an outside pointer press.
- Keep interaction with the active input or its label unchanged.
- Close the routine time popover during capture-phase outside pointer/focus events and Escape.
- Preserve existing modal, Planner, storage, and navigation behavior.

## Implementation

1. Mount one client-only dismissal controller in the root layout.
2. Strengthen `TerminalTimePicker` outside interaction and keyboard handling.
3. Keep the column picker while adding direct `H:mm`, `HH:mm`, and compact `HHmm` keyboard entry with inline validation.
4. Mirror the source changes and refresh downloadable archives.

## Validation

Automated test, typecheck, build, and browser validation are skipped under the user's standing instruction.

## Rollback

Remove the root dismissal controller and restore the routine picker's previous pointer listener.
