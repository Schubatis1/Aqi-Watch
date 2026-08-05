# Versioning

The app displays its version number at the bottom of the sidebar menu, and
a Version History list in Settings, both driven by `VERSION_HISTORY` /
`CURRENT_VERSION` near the top of the second `<script>` block in
`open_haus1.html`. The first time a returning visitor loads the app on a
newer `CURRENT_VERSION` than the one stored in their browser
(`lastSeenVersion` in localStorage), a "What's New" popup shows them the
notes for every version they skipped.

**Every time changes are pushed to this repo, bump that version number.**

Current version: **1.5.0**

## How to bump

1. Add a new entry to the top of `VERSION_HISTORY` in `open_haus1.html`,
   with the new version, today's date, and one bullet per user-facing
   change — this also becomes `CURRENT_VERSION` (the array's first entry)
   and drives both the sidebar badge and the "What's New" popup.
2. Update "Current version" above to match.
3. Use your judgement on patch (`1.3.1` → `1.3.2`) vs. minor (`1.3.1` → `1.4.0`)
   vs. major (`1.3.1` → `2.0.0`) based on the size/impact of the change —
   small fixes bump patch, new features bump minor, breaking/major
   redesigns bump major.
