# Dashboard Talk verification

Local verification on October 3, 2026 (Pacific time; final browser checks used
October 4 UTC timestamps). This increment adds topic-based conversation storage,
an optional host-selected conversational transport, task links, task-intake
proposals, attention and a shared dashboard navigation bridge.

## Executed checks

| Check | Result | Scope |
| --- | --- | --- |
| `pnpm exec nx run runtime:task-typecheck` | Passed | Runtime/dependency declarations and combined dashboard/CLI test types; some dependency results used Nx cache. |
| `pnpm exec nx run runtime:dashboard-talk-test` | 65 passed | Store, coordinator, real HTTP/CLI integration and scheduler refusal boundaries. Model calls use explicit test transports. |
| `pnpm exec nx run runtime:dashboard-talk-ui-test` | 10 passed | Browser-script syntax and model-free VM/DOM fixtures for drafts, response races, proposal intake and omission notices. |
| `pnpm exec nx run runtime:reconciliation-test` | 11 passed | Existing reconciliation intent adapter, including four temporary real SHA-1 Git repositories. |
| Headed Chrome with actual local HTTP service | Passed | Two fictional topics, a real local fictional task link, attention acknowledgement, separate drafts, task navigation and reload behavior. |
| Desktop and narrow browser layout | Passed | Inspected 1440×1000 and 390×844 screenshots; narrow document width equals its viewport. Browser console reported no errors or warnings. |

The browser service omitted the model transport and native control configuration.
Send remained disabled, while topic organization, links and attention worked.
Task navigation retained the selected topic's draft. Switching topics retained
each draft separately and did not include the other topic's task link. Reload
retained topic records and discarded unsent page-memory drafts as documented.
Acknowledgement left the fictional task open with one creation event and no run
or acceptance.

## Review repairs and retained failures

Independent source review identified two issues: raw dot/parent storage segments
could be normalized before physical path admission, and topic detail combined
links/attention from separate conversation snapshots. The final source refuses
those segments before resolution, uses the admitted canonical task-store root
before initialization, and projects detail from one retained topic page.
Deterministic tests verify no source writes and interleaved snapshot consistency.

Earlier gate failures were preserved. A reconciliation test's explicit `.mts`
import was corrected to its module `.mjs` specifier. One focused test observed a
persisted reply before the asynchronous disposal `finally` completed; its final
test waits boundedly for actual disposal and still requires exactly one disposal
and one model call across replay. The final focused gate passed all 65 cases.

The real Git adapter now hashes the observed Git object identity into the
contract's canonical SHA-256 identity field. A clean repository refuses new
reconciliation scope preparation without inventing an affected path. An existing
dirty attempt becomes blocked when current source becomes clean. Confirmation
remains a nonterminal intent record.

## Limits

These checks do not establish a live model response, provider credentials,
simultaneous native model workers, general crash/cross-process exactly-once
execution, independent human consent, business completion or preservation of
every open chat. The separate local native schedule proof belongs to its pinned
older source and is not attributed to these Talk browser checks.

Talk proposal acceptance creates a durable open task. Engineering planning,
execution, evidence verification and task acceptance remain separate runtime
steps. Reconciliation browser controls and deployment into the user's existing
dashboard state require their own reviewed activation.
