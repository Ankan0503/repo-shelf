// Shelf — folders on the GitHub repositories tab.
//
// The folder definitions are NOT stored in this extension. They are read from
// a public file in the profile repo of whichever user you are looking at:
//
//   https://raw.githubusercontent.com/<user>/<user>/<branch>/shelf/shelf.config.json
//
// That is the whole point. Anyone who installs this sees the folder structure
// its owner published, because the structure travels with the profile rather
// than living in one browser.
//
// Edit mode layers a local draft over that published config and hands back the
// JSON to commit. Nothing is written to GitHub: publishing stays an explicit
// act, so the extension never needs a token or write access to anything.
//
// Repo names and their list elements come from the page, because the rendered
// list is what we are filtering. Topics do NOT: GitHub shows at most seven
// topic tags per repo on this page, so a folder tag can be missing from the
// markup while being set on the repo — measured on a repo carrying eleven
// topics, where the folder tag was one of the four left out. Topics are
// therefore read from the API and matched back by name, with the truncated
// DOM tags kept only as a fallback when the API is unreachable.

(() => {
  const CONFIG_PATHS = ["shelf/shelf.config.json", "shelf.config.json"];
  const BRANCHES = ["main", "master"];
  const CACHE_MS = 5 * 60 * 1000;

  // Labels the UI shows. Only LOOSE is a folder name that can reach the
  // exported config, so it is the one a profile can override, via
  // `looseLabel` in its config. The other two are chrome and never exported.
  const LOOSE_KEY = "__loose__";
  const UI = { all: "All repositories", unsorted: "Unsorted", loose: "Other projects" };
  const looseLabel = (cfg) => (cfg && cfg.looseLabel) || UI.loose;

  const SEL = {
    list: ["#user-repositories-list", "turbo-frame#repo-list"],
    items: [
      "#user-repositories-list ul > li",
      "turbo-frame#repo-list ul > li",
      'ul[data-view-component="true"] > li.public, ul[data-view-component="true"] > li.private'
    ],
    link: ['a[itemprop="name codeRepository"]', "h3 a", "h2 a"],
    topic: ["a.topic-tag", 'a[data-ga-click*="topic"]']
  };

  const pick = (sels, root = document) => {
    for (const s of sels) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const pickAll = (sels, root = document) => {
    for (const s of sels) {
      const els = root.querySelectorAll(s);
      if (els.length) return [...els];
    }
    return [];
  };
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------------------------------------------------ page ---

  // GitHub puts the signed-in account in a meta tag. Used only to decide
  // whether to offer the empty editor: on your own profile the panel appears
  // with nothing published yet, on a stranger's it stays out of the way.
  function signedInUser() {
    const m =
      document.querySelector('meta[name="user-login"]') ||
      document.querySelector('meta[name="octolytics-actor-login"]');
    return (m?.content || "").trim() || null;
  }

  function profileOwner() {
    const m = location.pathname.match(/^\/([^/]+)\/?$/);
    if (!m) return null;
    const tab = new URLSearchParams(location.search).get("tab");
    return tab === "repositories" ? decodeURIComponent(m[1]) : null;
  }

  function readRepos() {
    return pickAll(SEL.items)
      .map((li) => {
        const a = pick(SEL.link, li);
        if (!a) return null;
        const path = new URL(a.href, location.origin).pathname.replace(/^\//, "");
        const name = path.split("/")[1] || path;
        const text = li.textContent || "";
        return {
          name,
          lower: name.toLowerCase(),
          topics: pickAll(SEL.topic, li).map((t) => t.textContent.trim().toLowerCase()),
          isPrivate: li.classList.contains("private") || /\bPrivate\b/.test(text),
          isFork: /Forked from/i.test(text),
          el: li
        };
      })
      .filter(Boolean);
  }

  // ----------------------------------------------------------------- data ---

  async function loadConfig(owner) {
    const key = `shelf:cfg:${owner}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
    } catch {
      /* sessionStorage can throw in private windows; fall through and fetch */
    }
    for (const branch of BRANCHES) {
      for (const path of CONFIG_PATHS) {
        const url = `https://raw.githubusercontent.com/${owner}/${owner}/${branch}/${path}`;
        try {
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok) continue;
          const cfg = await res.json();
          if (!cfg || !Array.isArray(cfg.folders)) continue;
          try {
            sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), cfg }));
          } catch {
            /* not worth failing over */
          }
          return cfg;
        } catch {
          /* try the next candidate */
        }
      }
    }
    return null;
  }

  // Authoritative topics, because the page's tags are capped at seven per repo.
  async function loadTopics(owner) {
    const key = `shelf:topics:${owner}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
    } catch {
      /* private windows can throw; fetch instead */
    }
    const map = {};
    try {
      for (let page = 1; page <= 4; page++) {
        // `type=owner` deliberately, not `type=all`: `all` also returns repos
        // the user only collaborates on, which can share a name with one they
        // own — a fork and its upstream both appear as "HackHeritage" — and the
        // second entry would overwrite the first, silently losing the folder
        // topic. The repositories tab lists what they own, so that is what we
        // mirror, and the owner check keeps it true even if that changes.
        const res = await fetch(
          `https://api.github.com/users/${encodeURIComponent(owner)}/repos` +
            `?per_page=100&page=${page}&type=owner`,
          { headers: { Accept: "application/vnd.github+json" }, cache: "no-cache" }
        );
        if (!res.ok) return null; // rate limited or offline — caller falls back
        const batch = await res.json();
        if (!Array.isArray(batch)) return null;
        for (const r of batch) {
          if (String(r.owner?.login || "").toLowerCase() !== owner.toLowerCase()) continue;
          map[String(r.name).toLowerCase()] = (r.topics || []).map((t) =>
            String(t).toLowerCase()
          );
        }
        if (batch.length < 100) break;
      }
    } catch {
      return null;
    }
    try {
      sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), map }));
    } catch {
      /* not worth failing over */
    }
    return map;
  }

  // ---------------------------------------------------------------- draft ---
  // A draft is this browser's unpublished edits for one profile: folders you
  // made and repos you ticked. It is keyed by profile so looking at someone
  // else's page cannot disturb your own.

  const draftKey = (owner) => `shelf:draft:${owner.toLowerCase()}`;
  const emptyDraft = () => ({ folders: [], picks: {}, removed: [], drops: {}, excludes: {} });

  async function loadDraft(owner) {
    try {
      const got = await chrome.storage.local.get(draftKey(owner));
      const d = got[draftKey(owner)];
      return d && typeof d === "object" ? { ...emptyDraft(), ...d } : emptyDraft();
    } catch {
      return emptyDraft();
    }
  }

  async function saveDraft(owner, draft) {
    try {
      await chrome.storage.local.set({ [draftKey(owner)]: draft });
    } catch {
      /* storage can be unavailable; the session still works in memory */
    }
  }

  // Published folders plus drafted ones, with ticked repos appended to each
  // folder's explicit `repos` list. This is exactly what gets exported.
  function mergeConfig(cfg, draft) {
    const out = {
      owner: cfg?.owner,
      folders: (cfg?.folders || []).map((f) => ({ ...f, repos: [...(f.repos || [])] })),
      loose: [...(cfg?.loose || [])]
    };
    for (const f of draft.folders || []) {
      if (!out.folders.some((x) => x.name === f.name)) out.folders.push({ name: f.name, repos: [] });
    }
    // A deleted folder is dropped from the exported config. Repos it held by
    // topic keep their topics — removing those is a change to the repo itself.
    const gone = new Set((draft.removed || []).map((n) => n.toLowerCase()));
    out.folders = out.folders.filter((f) => !gone.has(String(f.name).toLowerCase()));
    for (const [key, names] of Object.entries(draft.picks || {})) {
      if (key === LOOSE_KEY) {
        for (const n of names) if (!out.loose.some((r) => r.toLowerCase() === n.toLowerCase())) out.loose.push(n);
        continue;
      }
      const target = out.folders.find((f) => f.name === key);
      if (!target) continue;
      for (const n of names) {
        if (!target.repos.some((r) => r.toLowerCase() === n.toLowerCase())) target.repos.push(n);
      }
    }
    // Unticking a repo that the published config lists by name removes it here.
    // The loose folder is not a real folder — it is rendered from `loose` — so a
    // drop there comes out of that list. It is keyed by LOOSE_KEY rather than by
    // its label, so renaming the label cannot orphan a draft.
    for (const [key, names] of Object.entries(draft.drops || {})) {
      const lower = names.map((n) => n.toLowerCase());
      if (key === LOOSE_KEY) {
        out.loose = out.loose.filter((r) => !lower.includes(r.toLowerCase()));
        continue;
      }
      const target = out.folders.find((f) => f.name === key);
      if (target) target.repos = (target.repos || []).filter((r) => !lower.includes(r.toLowerCase()));
    }
    for (const [key, names] of Object.entries(draft.excludes || {})) {
      const target = out.folders.find((f) => f.name === key);
      if (!target) continue;
      const have = (target.exclude || []).map((r) => r.toLowerCase());
      target.exclude = [
        ...(target.exclude || []),
        ...names.filter((n) => !have.includes(n.toLowerCase()))
      ];
    }
    out.folders.forEach((f) => {
      if (!f.repos.length) delete f.repos;
      if (f.exclude && !f.exclude.length) delete f.exclude;
    });
    if (!out.loose.length) delete out.loose;
    if (!out.owner) delete out.owner;
    return out;
  }

  // Folders in config order; a repo is claimed by the first folder that matches,
  // so a repo carrying two folder topics appears once rather than twice.
  function assign(cfg, repos) {
    const claimed = new Set();
    const folders = [];
    for (const f of cfg.folders || []) {
      const tags = (f.tags || []).map((t) => String(t).toLowerCase());
      const named = (f.repos || []).map((r) => String(r).toLowerCase());
      const excluded = (f.exclude || []).map((r) => String(r).toLowerCase());
      const members = repos.filter((r) => {
        if (claimed.has(r.lower) || excluded.includes(r.lower)) return false;
        return named.includes(r.lower) || r.topics.some((t) => tags.includes(t));
      });
      members.forEach((r) => claimed.add(r.lower));
      folders.push({
        key: f.name,
        name: f.name,
        blurb: f.blurb,
        tags,
        named,
        excluded,
        repos: members
      });
    }
    const loose = (cfg.loose || []).map((r) => String(r).toLowerCase());
    const other = repos.filter((r) => !claimed.has(r.lower) && loose.includes(r.lower));
    other.forEach((r) => claimed.add(r.lower));
    if (other.length)
      folders.push({ key: LOOSE_KEY, name: looseLabel(cfg), repos: other, tags: [], named: loose });
    return { folders, rest: repos.filter((r) => !claimed.has(r.lower)) };
  }

  // ------------------------------------------------------------------- ui ---

  let state = {
    owner: null,
    repos: [],
    cfg: null,
    draft: emptyDraft(),
    folders: [],
    rest: [],
    active: "all",
    editing: false,
    degraded: false,
    flash: ""
  };

  function recompute() {
    const merged = mergeConfig(state.cfg, state.draft);
    const { folders, rest } = assign(merged, state.repos);
    state.folders = folders;
    state.rest = rest;
    state.merged = merged;
  }

  function visible(id) {
    if (id === "all") return state.repos;
    if (id === "unsorted") return state.rest;
    return state.folders[Number(id)]?.repos || [];
  }

  // Which repos are on screen. Browsing a folder shows its members; editing one
  // shows everything, because the ticks live on the rows and a new folder has no
  // members — filtering to them would hide every row you need to tick.
  function onScreen() {
    return editingFolder() ? state.repos : visible(state.active);
  }

  function editingFolder() {
    return state.editing && state.active !== "all" && state.active !== "unsorted"
      ? state.folders[Number(state.active)]
      : null;
  }

  function applyFilter() {
    const keep = new Set(onScreen().map((r) => r.lower));
    const q = (state.search || "").trim().toLowerCase();
    state.repos.forEach((r) => {
      const show = keep.has(r.lower) && (!q || r.lower.includes(q));
      // setProperty with "important", not style.display: GitHub's rows carry
      // Primer's `d-flex` utility, which is `display:flex !important`, and a
      // plain inline display loses to it — the row stays visible and the
      // folder looks like it did nothing.
      if (show) r.el.style.removeProperty("display");
      else r.el.style.setProperty("display", "none", "important");
    });
    renderRowControls();
  }

  function shown() {
    const keep = new Set(onScreen().map((r) => r.lower));
    const q = (state.search || "").trim().toLowerCase();
    return state.repos.filter((r) => keep.has(r.lower) && (!q || r.lower.includes(q)));
  }

  // In edit mode every row gets a tick for the folder being edited, ticked when
  // that folder already holds the repo. The whole list is shown while editing,
  // not just the folder's members, because a folder you just made has none.
  function renderRowControls() {
    const folderBeingEdited = editingFolder();

    state.repos.forEach((r) => {
      r.el.querySelector(".shelf-tick")?.remove();
      if (!folderBeingEdited) return;
      const fld = folderBeingEdited;

      const folder = fld.key;
      const byTopic = r.topics.some((t) => (fld.tags || []).includes(t));
      const picked = (state.draft.picks[folder] || []).some((n) => n.toLowerCase() === r.lower);
      const dropped = (state.draft.drops[folder] || []).some((n) => n.toLowerCase() === r.lower);
      const inConfig = (fld.named || []).includes(r.lower);

      // Nothing is locked. Unticking a repo that a topic put here records an
      // exclusion rather than editing the repo's topics, which would need write
      // access this extension does not have. The topic stays on the repo; the
      // folder simply stops claiming it.
      const excluded = (fld.excluded || []).includes(r.lower);
      const checked = !excluded && !dropped && (byTopic || picked || inConfig);

      const label = document.createElement("label");
      label.className = "shelf-tick";
      label.title = checked
        ? byTopic
          ? `Remove ${r.name} from ${fld.name} — the repo keeps its topic`
          : `Remove ${r.name} from ${fld.name}`
        : `Add ${r.name} to ${fld.name}`;
      label.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}><span>${esc(fld.name)}</span>`;

      label.querySelector("input").addEventListener("change", async (e) => {
        const picks = state.draft.picks[folder] || [];
        const drops = state.draft.drops[folder] || [];
        const excl = state.draft.excludes[folder] || [];
        if (e.target.checked) {
          state.draft.drops[folder] = drops.filter((n) => n.toLowerCase() !== r.lower);
          state.draft.excludes[folder] = excl.filter((n) => n.toLowerCase() !== r.lower);
          if (!inConfig && !byTopic) state.draft.picks[folder] = [...picks, r.name];
        } else {
          state.draft.picks[folder] = picks.filter((n) => n.toLowerCase() !== r.lower);
          if (byTopic) state.draft.excludes[folder] = [...excl, r.name];
          else if (inConfig) state.draft.drops[folder] = [...drops, r.name];
        }
        for (const k of ["picks", "drops", "excludes"]) {
          if (!(state.draft[k][folder] || []).length) delete state.draft[k][folder];
        }
        await saveDraft(state.owner, state.draft);
        recompute();
        render();
        applyFilter();
      });

      (r.el.querySelector("h3")?.parentElement || r.el).appendChild(label);
    });
  }

  function draftCount() {
    return (
      (state.draft.folders || []).length +
      (state.draft.removed || []).length +
      Object.values(state.draft.picks || {}).reduce((n, v) => n + v.length, 0) +
      Object.values(state.draft.drops || {}).reduce((n, v) => n + v.length, 0) +
      Object.values(state.draft.excludes || {}).reduce((n, v) => n + v.length, 0)
    );
  }

  function render() {
    let side = document.getElementById("shelf-side");
    if (!side) {
      const anchor = pick(SEL.list);
      if (!anchor) return;
      side = document.createElement("aside");
      side.id = "shelf-side";
      anchor.parentElement.insertBefore(side, anchor);
    }

    const counts = (list) => {
      const p = list.filter((r) => r.isPrivate).length;
      return p ? `<i title="${p} private — these stay invisible to anyone else">${p}🔒</i>` : "";
    };

    const row = (id, label, list, blurb) => `
      <li>
        <button class="shelf-item${state.active === id ? " is-active" : ""}" data-id="${id}"
                ${blurb ? `title="${esc(blurb)}"` : ""}>
          <span>${esc(label)}</span>
          <em>${counts(list)}${list.length}</em>
        </button>
        ${
          state.editing && id !== "all" && id !== "unsorted"
            ? `<button class="shelf-x" data-del="${esc(label)}" title="Remove this folder from the config">×</button>`
            : ""
        }
      </li>`;

    const n = draftCount();

    side.innerHTML = `
      <div class="shelf-head">
        <span>Folders</span>
        <button class="shelf-mode" data-mode>${state.editing ? "done" : "edit"}</button>
      </div>
      <input class="shelf-search" type="search" placeholder="Search repositories…"
             value="${esc(state.search || "")}" aria-label="Search repositories">
      <ul class="shelf-list">
        ${row("all", UI.all, state.repos)}
        ${state.folders.map((f, i) => row(String(i), f.name, f.repos, f.blurb)).join("")}
        ${state.rest.length ? row("unsorted", UI.unsorted, state.rest) : ""}
      </ul>
      ${
        state.editing
          ? `<form class="shelf-new"><input placeholder="New folder…" maxlength="40"><button>Add</button></form>
             <div class="shelf-actions">
               <button data-copy ${n ? "" : "disabled"}>Copy config${n ? ` (${n})` : ""}</button>
               <button data-reset ${n ? "" : "disabled"}>Discard</button>
             </div>
             <p class="shelf-note">${
               editingFolder()
                 ? `Showing every repository — tick one to put it in <b>${esc(
                     editingFolder().name
                   )}</b>.${
                     n
                       ? " Copy the config into <code>shelf/shelf.config.json</code> in your profile repo to publish."
                       : ""
                   }`
                 : "Pick a folder above, then tick repositories in the list."
             }</p>`
          : `<p class="shelf-note">${
              state.degraded
                ? "GitHub's API did not answer, so folders use the tags shown on this page — which GitHub caps at seven per repo and may be incomplete."
                : "Counts cover the repositories on this page."
            }</p>`
      }
      ${
        !state.folders.length && !state.editing
          ? `<p class="shelf-empty">No folders yet. Click <b>edit</b> to make one.</p>`
          : ""
      }
      <p class="shelf-count"></p>
      ${state.flash ? `<p class="shelf-flash">${esc(state.flash)}</p>` : ""}`;

    side.querySelectorAll(".shelf-item").forEach((b) =>
      b.addEventListener("click", () => {
        state.active = b.dataset.id;
        render();
        applyFilter();
      })
    );

    const search = side.querySelector(".shelf-search");
    if (search) {
      search.addEventListener("input", (e) => {
        state.search = e.target.value;
        applyFilter();
        const n = shown().length;
        const note = side.querySelector(".shelf-count");
        if (note) note.textContent = state.search ? `${n} matching` : "";
      });
      if (state.refocusSearch) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
        state.refocusSearch = false;
      }
    }

    side.querySelector("[data-mode]")?.addEventListener("click", () => {
      state.editing = !state.editing;
      render();
      applyFilter();
    });

    side.querySelectorAll(".shelf-x").forEach((b) =>
      b.addEventListener("click", async () => {
        const name = b.dataset.del;
        const wasDrafted = (state.draft.folders || []).some((f) => f.name === name);
        state.draft.folders = (state.draft.folders || []).filter((f) => f.name !== name);
        delete state.draft.picks[name];
        if (!wasDrafted) {
          state.draft.removed = [...new Set([...(state.draft.removed || []), name])];
          state.flash = `"${name}" removed. Copy the config and commit it to publish that.`;
        }
        await saveDraft(state.owner, state.draft);
        state.active = "all";
        recompute();
        render();
        applyFilter();
      })
    );

    side.querySelector(".shelf-new")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("input");
      const name = input.value.trim();
      if (!name) return;
      if (
        state.folders.some((f) => f.name === name) ||
        (state.draft.folders || []).some((f) => f.name === name)
      ) {
        state.flash = "A folder with that name already exists.";
        render();
        return;
      }
      state.draft.folders = [...(state.draft.folders || []), { name }];
      await saveDraft(state.owner, state.draft);
      state.flash = "";
      recompute();
      render();
      applyFilter();
    });

    side.querySelector("[data-copy]")?.addEventListener("click", async () => {
      const json = JSON.stringify(state.merged, null, 2) + "\n";
      try {
        await navigator.clipboard.writeText(json);
        const priv = state.repos.filter((r) => r.isPrivate).length;
        state.flash =
          "Config copied. Commit it to shelf/shelf.config.json." +
          (priv ? ` ${priv} private repo${priv > 1 ? "s" : ""} will not render for anyone else.` : "");
      } catch {
        state.flash = "Clipboard blocked — open the console and copy from there.";
        console.log(json);
      }
      render();
    });

    side.querySelector("[data-reset]")?.addEventListener("click", async () => {
      state.draft = emptyDraft();
      await saveDraft(state.owner, state.draft);
      state.flash = "Draft discarded.";
      state.active = "all";
      recompute();
      render();
      applyFilter();
    });
  }

  // ----------------------------------------------------------------- boot ---

  let booting = false;

  async function boot() {
    const owner = profileOwner();
    if (!owner) {
      document.getElementById("shelf-side")?.remove();
      return;
    }
    if (booting) return;
    booting = true;
    try {
      const repos = readRepos();
      if (!repos.length) return;

      const [cfg, topicMap, draft] = await Promise.all([
        loadConfig(owner),
        loadTopics(owner),
        loadDraft(owner)
      ]);

      // Nothing published and nothing drafted. On your own profile the empty
      // editor is the starting point, so show it; on someone else's there is
      // nothing to offer, so leave their page exactly as GitHub rendered it.
      const hasDraft = (draft.folders || []).length > 0;
      const me = signedInUser();
      const ownProfile = !!me && me.toLowerCase() === owner.toLowerCase();
      if (!cfg && !hasDraft && !ownProfile) {
        document.getElementById("shelf-side")?.remove();
        return;
      }

      if (topicMap) {
        repos.forEach((r) => {
          if (topicMap[r.lower]) r.topics = topicMap[r.lower];
        });
      }

      const sameOwner = state.owner === owner;
      state = {
        ...state,
        owner,
        repos,
        cfg: cfg || { folders: [] },
        draft,
        degraded: !topicMap,
        editing: sameOwner ? state.editing : false,
        active: sameOwner ? state.active : "all",
        flash: ""
      };
      recompute();
      if (state.active !== "all" && !visible(state.active).length) state.active = "all";

      render();
      applyFilter();
    } finally {
      booting = false;
    }
  }

  // Starting a first config on a profile with none: the panel only appears once
  // something is drafted, so this opens it from the console.
  window.shelfStart = async () => {
    const owner = profileOwner();
    if (!owner) return "Open a repositories tab first.";
    const draft = await loadDraft(owner);
    draft.folders = [...(draft.folders || []), { name: `Folder ${(draft.folders || []).length + 1}` }];
    await saveDraft(owner, draft);
    await boot();
    return `Drafted a folder on ${owner}. Use edit mode in the panel.`;
  };

  // GitHub navigates with Turbo and swaps the list in place when you search or
  // paginate, so re-run on soft navigation and whenever the panel goes missing.
  document.addEventListener("turbo:load", boot);
  window.addEventListener("popstate", boot);
  new MutationObserver(() => {
    if (profileOwner() && !document.getElementById("shelf-side")) boot();
  }).observe(document.body, { childList: true, subtree: true });

  boot();
})();
