// Repo Shelf — folders on the GitHub repositories tab.
//
// Folders are yours and live in this browser (chrome.storage.local), one set
// per profile you look at. They start empty: nothing is fetched or invented.
// chrome.storage.local survives page reloads, extension reloads and updates;
// only uninstalling the extension clears it.
//
// A folder's name is a GitHub topic. Any repo carrying exactly that topic is
// filed automatically, and can be unticked to keep it out without touching the
// repo. Repos can also be ticked in by hand, and a repo can sit in as many
// folders as you like.
//
// Topics come from the API, not the page: GitHub shows at most seven topic
// tags per repo on this tab, so a matching topic can be missing from the
// markup. The page's tags are only a fallback when the API is unreachable.

(() => {
  const CACHE_MS = 60 * 1000;
  // GitHub's own topic format: lowercase letters and digits, single hyphens.
  const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const NAME_MAX = 50;

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

  function profileOwner() {
    const m = location.pathname.match(/^\/([^/]+)\/?$/);
    if (!m) return null;
    const tab = new URLSearchParams(location.search).get("tab");
    return tab === "repositories" ? decodeURIComponent(m[1]) : null;
  }

  function readRepos() {
    return pickAll(SEL.items)
      .map((li, idx) => {
        const a = pick(SEL.link, li);
        if (!a) return null;
        const path = new URL(a.href, location.origin).pathname.replace(/^\//, "");
        const name = path.split("/")[1] || path;
        const text = li.textContent || "";
        return {
          name,
          lower: name.toLowerCase(),
          idx,
          topics: pickAll(SEL.topic, li).map((t) => t.textContent.trim()),
          isPrivate: li.classList.contains("private") || /\bPrivate\b/.test(text),
          el: li
        };
      })
      .filter(Boolean);
  }

  // Authoritative topics, because the page's tags are capped at seven per repo.
  async function loadTopics(owner, fresh = false) {
    const key = `shelf:topics:${owner}`;
    if (!fresh) {
      try {
        const hit = JSON.parse(sessionStorage.getItem(key) || "null");
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
      } catch {
        /* private windows can throw; fetch instead */
      }
    }
    const map = {};
    try {
      for (let page = 1; page <= 4; page++) {
        // `type=owner`, not `type=all`: `all` adds repos the user only
        // collaborates on, and a fork shares its upstream's name, so the
        // second entry would overwrite the first and lose its topics.
        const res = await fetch(
          `https://api.github.com/users/${encodeURIComponent(owner)}/repos` +
            `?per_page=100&page=${page}&type=owner`,
          { headers: { Accept: "application/vnd.github+json" }, cache: "no-cache" }
        );
        if (!res.ok) return null;
        const batch = await res.json();
        if (!Array.isArray(batch)) return null;
        for (const r of batch) {
          if (String(r.owner?.login || "").toLowerCase() !== owner.toLowerCase()) continue;
          map[String(r.name).toLowerCase()] = (r.topics || []).map(String);
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

  // -------------------------------------------------------------- storage ---

  const storeKey = (owner) => `shelf:folders:${owner.toLowerCase()}`;

  const clean = (f) =>
    f && typeof f.name === "string"
      ? {
          name: f.name,
          add: Array.isArray(f.add) ? f.add.map(String) : [],
          exclude: Array.isArray(f.exclude) ? f.exclude.map(String) : []
        }
      : null;

  async function loadFolders(owner) {
    try {
      // Drafts from earlier versions are dropped so nothing old resurfaces.
      chrome.storage.local.remove(`shelf:draft:${owner.toLowerCase()}`).catch(() => {});
      const got = await chrome.storage.local.get(storeKey(owner));
      const v = got[storeKey(owner)];
      return Array.isArray(v) ? v.map(clean).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async function saveFolders() {
    try {
      await chrome.storage.local.set({ [storeKey(state.owner)]: state.folders });
    } catch {
      state.flash = "Couldn't save to extension storage. Your change will be lost on reload.";
    }
  }

  // ------------------------------------------------------------- folders ---

  function validateName(raw) {
    const name = raw.trim();
    if (!name) return { error: "" };
    if (name.length > NAME_MAX)
      return { error: `Keep it to ${NAME_MAX} characters — the same limit GitHub puts on topics.` };
    if (!NAME_RE.test(name)) {
      const suggestion = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return {
        error:
          "Use lowercase letters and numbers joined by single hyphens" +
          (suggestion && NAME_RE.test(suggestion) ? ` — try "${suggestion}"` : "") +
          ". The name is matched exactly against repo topics, which GitHub keeps lowercase."
      };
    }
    if (state.folders.some((f) => f.name === name)) return { error: `"${name}" already exists.` };
    return { name };
  }

  const byTopic = (f, r) => r.topics.includes(f.name);
  const listed = (list, r) => list.some((n) => n.toLowerCase() === r.lower);
  const isMember = (f, r) => !listed(f.exclude, r) && (byTopic(f, r) || listed(f.add, r));

  const members = (i) => state.repos.filter((r) => isMember(state.folders[i], r));
  const unsorted = () => state.repos.filter((r) => !state.folders.some((f) => isMember(f, r)));
  const isFolderId = (id) => /^\d+$/.test(id);

  function listFor(id) {
    if (id === "all") return state.repos;
    if (id === "unsorted") return unsorted();
    return members(Number(id));
  }

  function editingFolder() {
    return state.editing && isFolderId(state.active) ? state.folders[Number(state.active)] : null;
  }

  function exportConfig() {
    // Same shape generate_projects.py reads: the folder's name doubles as its tag.
    return {
      owner: state.owner,
      folders: state.folders.map((f) => {
        const o = { name: f.name, tags: [f.name] };
        if (f.add.length) o.repos = [...f.add];
        if (f.exclude.length) o.exclude = [...f.exclude];
        return o;
      })
    };
  }

  // Topics are read once and briefly cached, so a topic added on GitHub after
  // the page loaded isn't seen until they are fetched again. Sync does that.
  async function syncTopics() {
    const map = await loadTopics(state.owner, true);
    if (!map) {
      state.degraded = true;
      return false;
    }
    state.repos.forEach((r) => {
      r.topics = map[r.lower] || r.topics;
    });
    state.degraded = false;
    return true;
  }

  // ------------------------------------------------------------------- ui ---

  let state = {
    owner: null,
    repos: [],
    folders: [],
    active: "all",
    editing: false,
    search: "",
    newName: "",
    degraded: false,
    flash: "",
    error: "",
    syncing: false
  };

  // While a folder is being edited every repo is listed, because the ticks
  // live on the rows and a new folder has no members to show. Browsing shows
  // only the folder's members.
  function applyFilter(rearrange) {
    const f = editingFolder();
    const keep = new Set((f ? state.repos : listFor(state.active)).map((r) => r.lower));
    const q = state.search.trim().toLowerCase();
    state.repos.forEach((r) => {
      const show = keep.has(r.lower) && (!q || r.lower.includes(q));
      // An important inline rule: the rows carry Primer's d-flex, which is
      // `display:flex !important`, and a plain inline display loses to it.
      if (show) r.el.style.removeProperty("display");
      else r.el.style.setProperty("display", "none", "important");
    });
    if (rearrange) arrange(f);
    renderRowControls();
  }

  // Members of the folder being edited go to the top so they are quick to
  // untick. Done when a folder is opened rather than on every tick, so a row
  // never jumps away from under the pointer. Original order otherwise.
  function arrange(f) {
    const ul = state.repos[0]?.el.parentElement;
    if (!ul) return;
    const ordered = [...state.repos].sort((a, b) => a.idx - b.idx);
    const list = f
      ? [...ordered.filter((r) => isMember(f, r)), ...ordered.filter((r) => !isMember(f, r))]
      : ordered;
    list.forEach((r) => ul.appendChild(r.el));
  }

  function renderRowControls() {
    const f = editingFolder();
    state.repos.forEach((r) => {
      r.el.querySelector(".shelf-tick")?.remove();
      if (!f) return;

      const auto = byTopic(f, r);
      const checked = isMember(f, r);
      const label = document.createElement("label");
      label.className = "shelf-tick";
      label.title = checked
        ? auto
          ? `In ${f.name} because the repo has the "${f.name}" topic — untick to keep it out`
          : `Remove from ${f.name}`
        : auto
        ? `Put back into ${f.name}`
        : `Add to ${f.name}`;
      label.innerHTML =
        `<input type="checkbox"${checked ? " checked" : ""}><span>${esc(f.name)}</span>` +
        (auto ? `<em class="shelf-auto">topic</em>` : "");

      label.querySelector("input").addEventListener("change", async (e) => {
        const without = (list) => list.filter((n) => n.toLowerCase() !== r.lower);
        f.add = without(f.add);
        f.exclude = without(f.exclude);
        if (e.target.checked) {
          if (!auto) f.add.push(r.name);
        } else if (auto) {
          f.exclude.push(r.name);
        }
        await saveFolders();
        render();
        applyFilter(false);
      });

      (r.el.querySelector("h3")?.parentElement || r.el).appendChild(label);
    });
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

    const lock = (list) => {
      const p = list.filter((r) => r.isPrivate).length;
      return p ? `<i title="${p} private — invisible to anyone else">${p}🔒</i>` : "";
    };
    const row = (id, label, list, deletable) => `
      <li>
        <button class="shelf-item${state.active === id ? " is-active" : ""}" data-id="${id}">
          <span>${esc(label)}</span><em>${lock(list)}${list.length}</em>
        </button>
        ${
          deletable && state.editing
            ? `<button class="shelf-x" data-del="${id}" title="Delete this folder">×</button>`
            : ""
        }
      </li>`;

    const f = editingFolder();

    side.innerHTML = `
      <div class="shelf-head">
        <span>Folders</span>
        <span class="shelf-btns">
          <button class="shelf-mode" data-sync title="Fetch repo topics again, so newly added topics are matched"${
            state.syncing ? " disabled" : ""
          }>${state.syncing ? "syncing…" : "sync"}</button>
          <button class="shelf-mode" data-mode>${state.editing ? "done" : "edit"}</button>
        </span>
      </div>
      <input class="shelf-search" type="search" placeholder="Search repositories…"
             value="${esc(state.search)}" aria-label="Search repositories">
      <ul class="shelf-list">
        ${row("all", "All repositories", state.repos, false)}
        ${state.folders.map((fo, i) => row(String(i), fo.name, members(i), true)).join("")}
        ${row("unsorted", "Unsorted", unsorted(), false)}
      </ul>
      ${
        state.folders.length
          ? ""
          : `<p class="shelf-empty">No folders yet.${
              state.editing ? "" : " Click <b>edit</b> to make one."
            }</p>`
      }
      ${
        state.editing
          ? `<form class="shelf-new">
               <input placeholder="folder-name" maxlength="${NAME_MAX}" value="${esc(state.newName)}"
                      spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="New folder name">
               <button>Add</button>
             </form>
             ${state.error ? `<p class="shelf-err">${esc(state.error)}</p>` : ""}
             <p class="shelf-note">${
               f
                 ? `Every repository is listed, those in <b>${esc(f.name)}</b> first. ` +
                   `Repos tagged <code>${esc(f.name)}</code> join on their own — untick to keep one out.`
                 : "Names match repo topics exactly, so use lowercase and hyphens, " +
                   "like <code>sih-2026</code>. Pick a folder to tick repos into it."
             }</p>
             ${
               state.folders.length
                 ? `<div class="shelf-actions"><button data-copy>Copy config</button></div>`
                 : ""
             }`
          : state.degraded
          ? `<p class="shelf-note">GitHub's API didn't answer, so topic matching uses the tags on this page, which GitHub caps at seven per repo.</p>`
          : ""
      }
      ${state.flash ? `<p class="shelf-flash">${esc(state.flash)}</p>` : ""}`;

    side.querySelectorAll(".shelf-item").forEach((b) =>
      b.addEventListener("click", () => {
        state.active = b.dataset.id;
        state.flash = "";
        render();
        applyFilter(true);
      })
    );

    side.querySelector("[data-sync]").addEventListener("click", async () => {
      state.syncing = true;
      state.flash = "";
      render();
      const ok = await syncTopics();
      state.syncing = false;
      const matched = state.folders.reduce((n, _, i) => n + members(i).length, 0);
      state.flash = ok
        ? `Synced. ${matched} folder placement${matched === 1 ? "" : "s"} across ${state.folders.length} folder${
            state.folders.length === 1 ? "" : "s"
          }.`
        : "GitHub's API didn't answer — try again in a minute.";
      render();
      applyFilter(true);
    });

    side.querySelector("[data-mode]").addEventListener("click", () => {
      state.editing = !state.editing;
      state.error = "";
      state.flash = "";
      render();
      applyFilter(true);
    });

    side.querySelector(".shelf-search").addEventListener("input", (e) => {
      state.search = e.target.value;
      applyFilter(false);
    });

    side.querySelectorAll(".shelf-x").forEach((b) =>
      b.addEventListener("click", async () => {
        const i = Number(b.dataset.del);
        const name = state.folders[i]?.name;
        if (!name || !confirm(`Delete the folder "${name}"? Repos keep their topics.`)) return;
        state.folders.splice(i, 1);
        state.active = "all";
        await saveFolders();
        render();
        applyFilter(true);
      })
    );

    const form = side.querySelector(".shelf-new");
    if (form) {
      const input = form.querySelector("input");
      input.addEventListener("input", () => {
        state.newName = input.value;
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = validateName(input.value);
        if (!v.name) {
          state.error = v.error;
          state.newName = input.value;
          render();
          side.querySelector(".shelf-new input")?.focus();
          return;
        }
        state.folders.push({ name: v.name, add: [], exclude: [] });
        state.active = String(state.folders.length - 1);
        state.error = "";
        state.newName = "";
        await saveFolders();
        await syncTopics();
        render();
        applyFilter(true);
      });
    }

    side.querySelector("[data-copy]")?.addEventListener("click", async () => {
      const json = JSON.stringify(exportConfig(), null, 2) + "\n";
      try {
        await navigator.clipboard.writeText(json);
        state.flash = "Copied as shelf.config.json.";
      } catch {
        console.log(json);
        state.flash = "Clipboard blocked — the config is in the console.";
      }
      render();
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

      const [topicMap, folders] = await Promise.all([loadTopics(owner), loadFolders(owner)]);
      if (topicMap) {
        repos.forEach((r) => {
          if (topicMap[r.lower]) r.topics = topicMap[r.lower];
        });
      }

      const same = state.owner === owner;
      state = {
        ...state,
        owner,
        repos,
        folders,
        degraded: !topicMap,
        editing: same ? state.editing : false,
        active: same ? state.active : "all",
        search: same ? state.search : "",
        flash: "",
        error: ""
      };
      if (isFolderId(state.active) && !state.folders[Number(state.active)]) state.active = "all";

      render();
      applyFilter(true);
    } finally {
      booting = false;
    }
  }

  // Keep every open tab in step when folders change in one of them.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !state.owner) return;
      const c = changes[storeKey(state.owner)];
      if (!c) return;
      const next = (Array.isArray(c.newValue) ? c.newValue : []).map(clean).filter(Boolean);
      if (JSON.stringify(next) === JSON.stringify(state.folders)) return;
      state.folders = next;
      if (isFolderId(state.active) && !state.folders[Number(state.active)]) state.active = "all";
      render();
      applyFilter(true);
    });
  } catch {
    /* storage events unavailable; each tab still works on its own */
  }

  // GitHub navigates with Turbo and can swap the list in place, so re-run on
  // soft navigation, when the panel disappears, or when the rows go stale.
  document.addEventListener("turbo:load", boot);
  window.addEventListener("popstate", boot);
  new MutationObserver(() => {
    if (!profileOwner()) return;
    const stale = state.repos.length && !state.repos[0].el.isConnected;
    if (!document.getElementById("shelf-side") || stale) boot();
  }).observe(document.body, { childList: true, subtree: true });

  boot();
})();
