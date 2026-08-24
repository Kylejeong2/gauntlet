# Gauntlet end-to-end demonstration

This pull request is an intentionally unsafe fixture used to verify Gauntlet's
installed GitHub App flow. It must not be merged.

The fixture at `tests/fixtures/live/unsafe-download.ts` accepts an untrusted
path without proving that the resolved file remains inside the export
directory. The expected review is a verified path-traversal finding attached
to the unsafe line, along with the specialist comments and final readiness
summary.
