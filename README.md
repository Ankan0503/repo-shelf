# Repo Shelf

**Folders on the GitHub repositories tab — read from the profile you're looking at.**

GitHub has no folders for repositories. Extensions that add them keep the
structure in your own browser, so they organise *your* view of everyone's
profile and nobody else ever sees yours.

Shelf works the other way round. The folders are **published by the profile
owner** in a public file in their profile repo, so anyone who installs this
sees the structure that person intended — for their own profile and for
everybody else's.

```
github.com/<user>?tab=repositories
        │
        ├── reads  raw.githubusercontent.com/<user>/<user>/main/shelf/shelf.config.json
        ├── reads  api.github.com/users/<user>/repos        (for topics)
        └── renders a folder sidebar and filters the list
```

No server, no account, no sign-in, nothing stored about you.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked**, select this folder.
4. Visit any `github.com/<user>?tab=repositories`.

If that user hasn't published a config, the page is left exactly as GitHub
rendered it. Nothing is injected and nothing breaks.

## Making your own folders

Click **edit** in the panel.

- **Add a folder** with the name box, **×** removes one.
- **Search** narrows the list inside whichever folder is selected.
- **Pick a folder** in the list, then tick repositories in the page to put them in it.
- **Copy config** puts the whole thing on your clipboard as JSON.
- Paste it into `shelf/shelf.config.json` in your profile repo and commit.

Your edits live in this browser until you publish them, so nothing is written
to GitHub and the extension never needs write access or a token.

A repo already filed by a **topic** shows ticked and disabled: unfiling it
means removing that topic from the repo, which is a change to the repo itself.
Use `gh repo edit <repo> --remove-topic <tag>` for that.

Private repositories and forks can be ticked like any other. A private repo
will render for **you** and for nobody else — they cannot see the repository at
all — so the copy-config message tells you how many are in the config and will
be invisible to visitors.

On **your own** profile the panel appears even with nothing published yet, so
a fresh install has somewhere to start. On someone else's profile with no
config it stays hidden — there is nothing to show.

There are no folders out of the box. Shelf does not invent a structure for
you; every folder is one you made or one the profile owner published.

## Publishing your folders

Add `shelf/shelf.config.json` to your profile repo — the one named after your
account, the same repo whose README shows on your profile:

```json
{
  "owner": "your-username",
  "folders": [
    {
      "name": "SIH 2026",
      "blurb": "Smart India Hackathon.",
      "tags": ["sih"]
    },
    {
      "name": "Hacktoberfest 2026",
      "tags": ["hf2026"]
    }
  ],
  "loose": ["some-repo-with-no-topic"]
}
```

| Key | Meaning |
| --- | --- |
| `folders[].name` | Folder label |
| `folders[].blurb` | Tooltip text, optional |
| `folders[].tags` | Repo **topics** that file a repo into this folder |
| `folders[].repos` | Repo names, for anything you'd rather not tag |
| `loose` | Repos shown in the catch-all folder with no folder of their own |
| `looseLabel` | Renames that catch-all folder. Defaults to "Other projects" |

Adding a repo to a folder is then one command — no config edit:

```bash
gh repo edit <user>/<repo> --add-topic hf2026
```

Folders are matched in order and a repo is claimed by the first one that fits,
so a repo carrying two folder topics appears once rather than twice.

## Two things that are easy to get wrong

Both of these were found by testing against a real profile, and both would have
produced a sidebar that looked fine while quietly filing repos into the wrong
folder.

**GitHub renders at most seven topic tags per repo on the repositories tab.**
Scraping topics out of the page therefore misses them on any repo with more
than seven — on the profile this was built against, a repo with eleven topics
had its folder tag among the four GitHub left out. Shelf reads repo names and
their list elements from the page, but takes topics from the API.

**`type=all` returns duplicate names.** The user-repos endpoint with
`type=all` also returns repos the user merely collaborates on, and a fork and
its upstream share a name. The second entry overwrites the first in a
name-keyed map, losing the topics of the one you wanted. Shelf asks for
`type=owner` and additionally checks `owner.login`, which is what the
repositories tab shows anyway.

## Limits

- **The viewer has to install it.** Someone without the extension sees GitHub's
  ordinary flat list. This is a nicer view for people who opt in, not a way to
  restructure your profile for everyone — publish a grouped index in your
  profile README for that.
- Filtering applies to the repositories GitHub has rendered on the current
  page, so counts are per page.
- The API is called unauthenticated, which allows 60 requests an hour per
  address. Responses are cached per profile for five minutes. If the limit is
  hit, Shelf falls back to the page's truncated tags and says so in the panel
  rather than showing numbers it cannot stand behind.
- Chrome and Chromium browsers. The manifest is MV3; a Firefox port needs a
  `browser_specific_settings` block.

## Licence

MIT
