# Versioning

The app displays its version number at the bottom of the sidebar menu in
`open_haus1.html` (`<div class="sidebar-version" id="sidebarVersion">`).

**Every time changes are pushed to this repo, bump that version number.**

Current version: **1.4.0**

## How to bump

1. Edit the text inside `#sidebarVersion` (`v1.3.1`) in `open_haus1.html`.
2. Update "Current version" above to match.
3. Use your judgement on patch (`1.3.1` → `1.3.2`) vs. minor (`1.3.1` → `1.4.0`)
   vs. major (`1.3.1` → `2.0.0`) based on the size/impact of the change —
   small fixes bump patch, new features bump minor, breaking/major
   redesigns bump major.
