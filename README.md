# Repo Shelf

**Your own folders on the GitHub repositories tab.**

GitHub has no folders for repositories. Repo Shelf adds a folder panel above
the list on any `github.com/<user>?tab=repositories` page. You make the
folders; nothing comes preinstalled.

## How it works

- **A folder's name is a topic.** Name a folder `sih-2026` and every repo with
  the `sih-2026` topic files itself into it. Matching is exact.
- **Tick anything in, untick anything out.** Ticking adds a repo by hand.
  Unticking a repo that a topic brought in keeps it out of the folder without
  touching the repo — its topic stays.
- **A repo can be in as many folders as you like.**
- **While you edit a folder, every repository is listed**, with the folder's
  members first so they're quick to untick.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked**, select this folder — the one with `manifest.json` in it.
4. Open `github.com/<you>?tab=repositories`.

## Using it

1. Click **edit**.
2. Type a folder name and **Add**. The new folder opens straight away.
3. Tick repositories into it. Repos already carrying that topic are ticked for
   you, marked **topic**.
4. Click **done**. Clicking a folder now shows just its repositories.

**×** next to a folder deletes it. **Search** narrows whatever is listed.

### Folder names

Lowercase letters and numbers joined by single hyphens, up to 50 characters:
`sih-2026`, `hhgoa`, `hf2026`. That is GitHub's own topic format, and it's
required because a folder matches topics exactly — a folder called `SIH 2026`
could never match anything. The panel suggests a valid form when a name is
rejected.

## Where your folders live

In this browser, in the extension's own storage, one set per profile. They
survive page reloads, extension reloads and updates. Only uninstalling the
extension clears them — or loading it from a different folder, since Chrome
derives an unpacked extension's identity from its path.

Nothing is sent anywhere. The one network call is to GitHub's public API, to
read each repo's topics.

### Copy config

**Copy config** puts your folders on the clipboard as JSON, in the
`shelf.config.json` shape: each folder's name as its tag, plus any repos you
ticked in (`repos`) or out (`exclude`). Use it to back your folders up, or to
feed a profile README generator.

## Two things the page can't be trusted for

Both were found by testing against a real profile, and both made the panel look
right while doing the wrong thing.

**GitHub shows at most seven topic tags per repo on this tab.** A repo with more
can have the matching topic missing from the page entirely, so topics are read
from the API. If the API doesn't answer — 60 anonymous requests an hour, cached
for five minutes per profile — the panel falls back to the page's tags and says
so.

**The repo rows are `display:flex !important`** through Primer's `d-flex`
class, so hiding a row with a plain inline `display:none` silently does nothing.
Rows are hidden with an important inline rule instead.

## Limits

- Folders are visible to you only. Someone else sees GitHub's ordinary list.
- Counts cover the repositories GitHub has rendered on the current page.
- Private repos' topics need a signed-in API call, so a private repo can be
  ticked in by hand but won't be matched by topic.

## Licence

MIT
