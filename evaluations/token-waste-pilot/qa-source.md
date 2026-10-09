SYNTHETIC FIXTURE — no real product or ticket.
Product expectation: approved requirement R-17 says a failed export shows an error and preserves selected filters. Retry timing has no approved requirement.
Observed by tester Mina, staging build 2.4.1, Firefox 131, fictional account demo-7: at 10:03 UTC force export HTTP 503; banner "Export unavailable" appeared and filters region=west/status=active remained selected. Evidence: synthetic log E1 (503), screenshot E2 (banner and filters).
Reported by developer Theo, not independently observed: automatic retry happens after 5 seconds.
Not run: successful export after recovery, duplicate click handling, Chrome, mobile, and keyboard focus.
Mina spent 6 minutes on the observed check. No production execution. Product owner Jules must decide retry timing. QA owner Mina can run recovery and duplicate-click checks after that decision. No release decision requested.
