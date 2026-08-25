# Contest UI Design QA

## Comparison setup

- Approved source: `C:\Users\Z\AppData\Local\Temp\codex-clipboard-8a050b8f-4fd9-4b44-9b30-1e4edc55b628.png` (1487 × 1058)
- Implementation capture: `C:\Users\Z\.codex\visualizations\2026\08\25\01a037bf-44fb-7cd2-9b52-51d98a6c0c10\contest-ui-implementation-target-viewport.png`
- Side-by-side comparison: `C:\Users\Z\.codex\visualizations\2026\08\25\01a037bf-44fb-7cd2-9b52-51d98a6c0c10\contest-ui-comparison-final.png`
- Browser CSS viewport: 1497 × 1058. The in-app browser capture surface was 1487 × 988, so the reference was cropped to the same visible frame for the final comparison.
- Verified route: `/contest/contests/:contestId/problems/:problemId`

## QA passes

### Pass 1

- P1 · Layout: the first implementation used a second navigation row and a detached problem metadata card, which weakened the approved single-row contest shell and split-workspace hierarchy.
  - Fix: moved contest navigation into the top row and placed the problem title and limits inside the statement pane.
- P1 · Layout: the generic panel selector forced the hidden “正式提交” heading to render below the action buttons.
  - Fix: increased selector specificity so the duplicate heading remains hidden.
- P2 · Behavior: run results, samples, and custom input were all present but did not behave as one tab set.
  - Fix: added semantic tab buttons and one visible panel at a time; run actions select their matching result panel.

### Pass 2

- Typography: hierarchy and dense Chinese system-font treatment match the approved tactical-board direction. No clipped headings or unreadable control labels were found.
- Spacing and layout: single-row header, status rail, 40/60 split, dark editor, console, and bottom action area align with the approved structure. Borders, radius, and elevation remain restrained.
- Colors and tokens: blue active state, green accepted/submit state, amber attempted state, graphite editor, and neutral data surfaces are consistent across contest pages.
- Assets and icons: no new image assets, custom SVGs, CSS illustrations, or placeholder avatars were introduced. Text controls are used where the existing project has no icon dependency.
- Copy and content: contest title and problem/status content come from existing APIs. Problem count and sample content intentionally reflect local seed data rather than the mock image.
- States and interactions: contest navigation, problem chips, console tabs, full-reading toggle, keyboard-adjustable statement divider, filters, pagination, and runtime drawer retain functional controls.
- Accessibility: semantic tabs, labelled regions, focus-visible styles, an ARIA separator with value bounds, reduced-motion handling, and explicit button labels are present.
- Viewport resilience: no body overflow at 1497 px, 900 px, or 390 px. The problem workspace stacks at the narrow breakpoint and the contest navigation becomes horizontally scrollable.
- Peripheral routes: problem list, submission list, and scoreboard rendered at the desktop viewport with body width equal to the viewport and no clipped tables.

## Accepted implementation constraints

- The approved mock shows populated editor syntax highlighting and passed sample rows. The repository currently uses its existing plain textarea and real runtime output; UI work did not add dependencies, replace the Web runtime, or fabricate result data.
- The tactical rail displays the number of problems returned by the active contest instead of hard-coding A–H.

## Verification

- `node --check server/public/js/contest/problem-detail.js`
- `node --test server/test/submission-status-ui.test.js server/test/client-device-ui.test.js`
- EJS render smoke for seven changed contest templates
- In-app browser route, interaction, responsive, and side-by-side visual checks
- `git diff --check`

final result: passed
