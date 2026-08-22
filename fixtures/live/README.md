# Live command-injection fixture

This pull request fixture is intentionally vulnerable and must not be merged.

The expected Gauntlet behavior is:

- The security or adversarial reviewer identifies that `name` reaches a shell.
- An independent challenge confirms the trigger with a concrete payload.
- The final review contains one verified inline comment on the changed line.
- Other reviewer results appear only in the compact scorecard.
