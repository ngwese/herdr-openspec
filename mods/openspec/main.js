// OpenSpec panel: the repo's proposed changes and its specs. The top view is
// changes over specs with a draggable divider; open either to browse the files
// it carries and preview them like the Files panel does.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, v_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

// The same folder rule as the Files and Changes panels: the focused pane's
// folder, on its machine.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// Markdown artifacts (proposal/design/spec/tasks/…) render as prose instead of
// raw text; every other file keeps the read-only syntax-highlighted Editor.
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);

// Walks up from cwd to the nearest openspec/changes and prints its openspec
// folder; prints nothing when the repo has none.
async function findOpenSpec(cwd, on) {
  const script = `
    dir="$1"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
      [ -d "$dir/openspec/changes" ] && break
      dir=$(dirname "$dir")
    done
    [ -d "$dir/openspec/changes" ] && printf '%s' "$dir/openspec"
    exit 0`;
  const r = await exec("sh", ["-c", script, "openspec", cwd], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot find OpenSpec");
  return r.stdout.trim() || null;
}

// Subfolder names of a folder, NUL-separated, dotfolders skipped.
async function listDirs(dir, on) {
  const script = `
    [ -d "$1" ] || exit 0
    cd "$1" || exit 0
    for e in */; do
      n=\${e%/}
      [ -d "$n" ] || continue
      case "$n" in .*) continue;; esac
      printf '%s\\0' "$n"
    done`;
  const r = await exec("sh", ["-c", script, "openspec", dir], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  return r.stdout.split("\0").filter(Boolean);
}

// Every file under a folder, relative to it, dotfiles skipped (the
// .openspec.yaml bookkeeping). Newline-separated, sorted.
async function listFiles(dir, on) {
  const script = `
    [ -d "$1" ] || exit 0
    cd "$1" || exit 0
    find . -type f ! -name '.*' | sed 's|^\\./||' | LC_ALL=C sort`;
  const r = await exec("sh", ["-c", script, "openspec", dir], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  return r.stdout.split("\n").filter(Boolean);
}

// OpenSpec tasks are markdown checkboxes; a wrapped task still has one line
// with the box, so only those lines count.
const countTasks = (text) => {
  let done = 0, total = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s*\[([ xX])\]/.exec(line);
    if (m) { total++; if (m[1].toLowerCase() === "x") done++; }
  }
  return { done, total };
};

// tasks.md → per-section task groups: checkbox bullets belong to the last
// `##` (or deeper) heading, which is what the open section header collapses.
const parseTasks = (text) => {
  const sections = [];
  let current = null;
  for (const line of (text || "").split("\n")) {
    const h = /^#{2,}\s+(.*)$/.exec(line);
    const t = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
    if (h) { current = { title: h[1].trim(), tasks: [] }; sections.push(current); }
    else if (t && current) current.tasks.push({ done: t[1].toLowerCase() === "x", text: t[2] });
  }
  return sections;
};

// Relative paths to a folder/file tree, folder order kept.
function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

export default class OpenSpec extends View {
  init(_props, cx) {
    this.changes = []; this.specs = []; this.files = []; this.collapsed = new Set();
    this.context = null; this.openspec = null; this.root = null; this.on = null;
    this.open = null; this.base = null; this.file = null; this.code = null; this.markdown = null;
    this.error = null; this.fileError = null; this.loading = false; this.watched = null;
    this.schema = null; this.specFiles = []; this.taskGroups = []; this.taskCollapsed = new Set(); this.hadTasks = false;
    this.detailReady = false; this.detailSpinner = false;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // The project's configured schema name: the change's .openspec.yaml wins over
  // openspec/config.yaml (or config.yml), and spec-driven is the default — the
  // same order the OpenSpec CLI resolves it. Other dots in config are ignored.
  async schemaLine(file, context) {
    const text = await readTextFile(file, { on: this.on }).catch(() => null);
    if (!this.current(context) || text === null) return null;
    const m = /^schema:\s*["']?([^\s"']+)/m.exec(text);
    return m ? m[1] : null;
  }

  async projectSchema(on, context) {
    if (!this.openspec) return "spec-driven";
    for (const n of ["config.yaml", "config.yml"]) {
      const text = await readTextFile(`${this.openspec}/${n}`, { on }).catch(() => null);
      if (text === null || !this.current(context)) continue;
      const m = /^schema:\s*["']?([^\s"']+)/m.exec(text);
      if (m && m[1]) return m[1];
    }
    return "spec-driven";
  }

  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { while (this.context === context) { await watchFolder(dir); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) { return this.context === context && key() === context.key; }
  same(a, b) { return Boolean(a && b && a.kind === b.kind && a.name === b.name); }
  has(item) { return (item.kind === "spec" ? this.specs : this.changes).some((x) => x.name === item.name); }
  itemDir(item) { return item.kind === "spec" ? `${this.openspec}/specs/${item.name}` : `${this.openspec}/changes/${item.name}`; }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), next = key();
    this.on = on;
    if (next !== this.context?.key) {
      this.context = { key: next, cwd, on };
      this.changes = []; this.specs = []; this.files = []; this.collapsed = new Set();
      this.openspec = null; this.root = null; this.open = null; this.base = null; this.file = null;
      this.code?.release(); this.code = null; this.markdown = null;
      this.error = null; this.fileError = null; this.watched = null;
      this.schema = null; this.specFiles = []; this.taskGroups = []; this.taskCollapsed = new Set(); this.hadTasks = false;
      this.detailReady = false; this.detailSpinner = false;
      this.loading = false;
    }
    if (!cwd) return;
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const openspec = await findOpenSpec(cwd, on);
        if (!this.current(context)) return;
        this.openspec = openspec;
        this.root = openspec ? openspec.replace(/[/\\]openspec$/, "") : null;
        this.schema = openspec ? await this.projectSchema(on, context) : null;
        const changes = [], specs = [];
        if (openspec) {
          const names = (await listDirs(`${openspec}/changes`, on)).filter((n) => n !== "archive");
          for (const name of names) {
            if (!this.current(context)) return;
            const text = await readTextFile(`${openspec}/changes/${name}/tasks.md`, { on }).catch(() => null);
            changes.push({ name, ...(text ? countTasks(text) : { done: 0, total: 0 }) });
          }
          if (!this.current(context)) return;
          for (const name of await listDirs(`${openspec}/specs`, on)) specs.push({ name });
        }
        if (!this.current(context)) return;
        this.changes = changes; this.specs = specs; this.error = null;
        if (this.openspec) this.watch(this.openspec, cx);
        if (this.open && !this.has(this.open)) this.closeItem();
        if (this.open) await this.loadFiles(this.open, context);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  async loadFiles(item, context) {
    if (!this.openspec || !item) return;
    const base = this.itemDir(item);
    const files = await listFiles(base, this.on);
    if (!this.current(context) || !this.same(this.open, item)) return;
    this.base = base; this.files = files;
    // Structured change detail reads from the change's own files: the specs
    // tree (specs/<capability>/spec.md) and, for a change, the tasks.md groups
    // and any schema it declares per-change.
    this.specFiles = files.filter((f) => f.startsWith("specs/")).map((f) => f.slice("specs/".length));
    if (item.kind === "change") {
      const hadTasks = files.includes("tasks.md");
      const text = hadTasks ? await readTextFile(`${base}/tasks.md`, { on: this.on }).catch(() => null) : null;
      const meta = await this.schemaLine(`${base}/.openspec.yaml`, context);
      if (!this.current(context) || !this.same(this.open, item)) return;
      this.hadTasks = hadTasks; this.taskGroups = parseTasks(text);
      if (meta) this.schema = meta;
    }
  }

  openItem(kind, name, cx) {
    this.closeItem();
    if (!name) { cx.notify(); return; }
    const item = { kind, name };
    this.open = item;
    const context = this.context;
    // Suppress the empty-placeholder flash while the detail loads: nothing for
    // the first 100 ms, then a spinner, both gone the moment content is ready.
    this.detailReady = false; this.detailSpinner = false;
    cx.timer.after(100, (cx) => { if (this.open === item && !this.detailReady) { this.detailSpinner = true; cx.notify(); } });
    cx.spawn(async (cx) => {
      try { await this.loadFiles(item, context); }
      catch (e) { if (this.current(context) && this.same(this.open, item)) this.error = String(e); }
      finally { this.detailReady = true; cx.notify(); }
    });
    cx.notify();
  }

  closeItem() {
    this.open = null; this.base = null; this.files = []; this.file = null;
    this.code?.release(); this.code = null; this.markdown = null; this.fileError = null;
    this.collapsed = new Set(); this.specFiles = []; this.taskGroups = []; this.taskCollapsed = new Set(); this.hadTasks = false;
    this.detailReady = false; this.detailSpinner = false;
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.markdown = null; this.file = path; this.fileError = null;
    // Navigating back to the list/detail has no async read to drive the
    // repaint (every other show() ends in the read's `finally notify`);
    // without this the released editor stays blank on screen until the next
    // unrelated notify fires seconds later.
    if (!path) { cx?.notify(); return; }
    const context = this.context, base = this.base, on = this.on, item = this.open;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${base}/${path}`, { on });
        if (this.file !== path || !this.same(this.open, item) || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const truncated = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (isMarkdown(path)) { this.markdown = truncated; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: truncated,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.same(this.open, item) && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  badge(change, t) {
    const complete = change.total > 0 && change.done === change.total;
    return h_flex().flex_none().gap(6).items_center()
      .when(change.total > 0, (e) => e.child(div().w(40).h(4).flex_none().rounded(2).bg(t.raised)
        .child(div().h(4).rounded(2).bg(complete ? t.done : t.accent).w(Math.max(2, Math.round(40 * change.done / change.total))))))
      .child(div().text_size(11).text_color(complete ? t.done : t.muted).child(change.total ? `${change.done}/${change.total}` : "—"));
  }

  // `base` prefixes the path passed to show() without changing what is drawn,
  // so the specs tree can draw capabilities without a redundant specs/ wrapper
  // and still preview the real (specs/<path>) file.
  rows(node, prefix, depth, out, t, base = "") {
    for (const [name, child] of node.dirs) {
      const path = prefix ? `${prefix}/${name}` : name, collapsed = this.collapsed.has(path);
      out.push(h_flex().id(`os-dir-${path}`).h(28).flex_none().pl(8 + depth * 16).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (collapsed) this.collapsed.delete(path); else this.collapsed.add(path); cx.notify(); })
        .child(svg(`mods/openspec/chevron-${collapsed ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(svg("mods/openspec/folder.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(name)));
      if (!collapsed) this.rows(child, path, depth + 1, out, t, base);
    }
    for (const name of node.files) {
      const path = prefix ? `${prefix}/${name}` : name, real = base ? `${base}/${path}` : path;
      out.push(h_flex().id(`os-file-${path}`).h(28).flex_none().pl(8 + depth * 16).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.file === real, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.show(real, cx))
        .child(div().w(12).flex_none())
        .child(svg("mods/openspec/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(name)));
    }
    return out;
  }

  changeRow(change, t) {
    return h_flex().id(`os-change-${change.name}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openItem("change", change.name, cx))
      .child(svg("mods/openspec/chevron-right.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(change.name))
      .child(this.badge(change, t));
  }

  specRow(spec, t) {
    return h_flex().id(`os-spec-${spec.name}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openItem("spec", spec.name, cx))
      .child(svg("mods/openspec/chevron-right.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(spec.name));
  }

  section(id, label, count, empty, rows, t) {
    return v_flex().size_full().min_h(0)
      .child(h_flex().flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(12).text_color(t.muted).child(label))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(String(count))))
      .child(v_flex().id(`os-scroll-${id}`).flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(rows)
        .when(!rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(empty))));
  }

  listBody(t) {
    const noRepo = !this.openspec;
    return v_resizable("openspec-split").flex_1().w_full().min_h(0)
      .child(resizable_panel().size(300).size_range(80).child(
        this.section("changes", "Changes", this.changes.length,
          this.error || (this.loading ? "Loading changes…" : noRepo ? "No OpenSpec folder in this repo" : "No proposed changes"),
          this.changes.map((c) => this.changeRow(c, t)), t)))
      .child(resizable_panel().size_range(80).child(
        this.section("specs", "Specs", this.specs.length,
          this.loading ? "Loading specs…" : noRepo ? "" : "No specs",
          this.specs.map((s) => this.specRow(s, t)), t)));
  }

  artifactRow(name, t) {
    return h_flex().id(`os-artifact-${name}`).h(28).flex_none().pl(8).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(this.file === name, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.show(name, cx))
      .child(svg("mods/openspec/file.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(name));
  }

  taskGroup(group, i, t) {
    const done = group.tasks.filter((tk) => tk.done).length;
    const complete = group.tasks.length > 0 && done === group.tasks.length;
    const key = `${this.open.name}:${i}`, open = !this.taskCollapsed.has(key);
    return v_flex().flex_none()
      .child(h_flex().id(`os-task-${i}`).h(28).flex_none().pl(8).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (open) this.taskCollapsed.add(key); else this.taskCollapsed.delete(key); cx.notify(); })
        .child(svg(`mods/openspec/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(group.title))
        .child(div().text_size(11).text_color(complete ? t.done : t.dim).child(group.tasks.length ? `${done}/${group.tasks.length}` : "")))
      .when(open && group.tasks.length, (el) => el.child(v_flex().flex_none().children(group.tasks.map((tk, j) => this.taskLine(tk, j, t)))));
  }

  taskLine(task, i, t) {
    return h_flex().id(`os-taskline-${i}`).h(24).flex_none().pl(31).pr(8).gap(7).items_center()
      .child(div().w(12).flex_none().text_size(12).text_color(task.done ? t.done : t.muted).child(task.done ? "\u2713" : "\u25CB"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(task.done ? t.dim : t.foreground).child(task.text));
  }

  // The structured spec-driven change detail: the change's own documents as
  // two plain lines, then a Task and a Specs section each under a full-width
  // band exactly like the change-name strip at the top of the detail.
  detailSections(t) {
    const has = (f) => this.files.includes(f);
    const band = (label, right) => h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(label))
      .child(right || div().flex_none());
    const placeholder = (text) => div().px(8).py(2).text_size(12).text_color(t.dim).child(text);
    const out = [];
    // Proposal and Design: just the two document lines, no headers of their own.
    if (has("proposal.md")) out.push(this.artifactRow("proposal.md", t)); else out.push(placeholder("No proposal"));
    if (has("design.md")) out.push(this.artifactRow("design.md", t)); else out.push(placeholder("No design"));
    // Tasks: its own band (the change strip already carries the progress
    // badge, so the Tasks header itself stays label-only), then the groups.
    out.push(band("Tasks"));
    if (this.taskGroups.length) out.push(v_flex().flex_none().children(this.taskGroups.map((g, i) => this.taskGroup(g, i, t))));
    else out.push(placeholder(this.hadTasks ? "No tracked sections" : "No tasks"));
    // Specs: a similar full-width band, then the capabilities tree.
    out.push(band("Specs", div().text_size(11).text_color(t.dim).child(String(this.specFiles.length))));
    if (this.specFiles.length) out.push(v_flex().flex_none().children(this.rows(buildTree(this.specFiles), "", 0, [], t, "specs")));
    else out.push(placeholder("No specs"));
    return v_flex().children(out);
  }

  detailBody(t) {
    const item = this.open, change = item.kind === "change" ? this.changes.find((c) => c.name === item.name) : null;
    // The structured detail is the spec-driven view; other configured schemas
    // keep the plain files tree.
    const structured = item.kind === "change" && this.schema === "spec-driven";
    const tree = buildTree(this.files);
    const ready = this.detailReady;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(change), (el) => el.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(change.name))
        .child(this.badge(change, t))))
      .when(!ready, (el) => el.child(this.detailSpinner ? this.loadingDetail(t) : v_flex().flex_1()))
      .when(ready, (el) => el.child(v_flex().id("os-files").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(structured, (e2) => e2.child(this.detailSections(t)))
        .when(!structured, (e2) => e2.children(this.rows(tree, "", 0, [], t))
          .when(!this.files.length, (e3) => e3.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || "No files"))))));
  }

  // Shown only after the 100 ms grace (see openItem) so a fast load never
  // flashes a spinner. Native frames — no timer, no per-frame rerender.
  loadingDetail(t) {
    return v_flex().flex_1().items_center().justify_center().gap(10)
      .child(div().text_size(14).text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
      .child(div().text_size(12).text_color(t.dim).child("Loading…"));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const label = this.open ? (this.open.kind === "spec" ? `specs/${this.open.name}` : this.open.name) : null;
    const crumbs = [this.root ? this.root.split(/[/\\]/).pop() : null, label, this.file].filter(Boolean);
    const back = (cx) => { if (this.file) this.show(null, cx); else { this.closeItem(); cx.notify(); } };
    return v_flex().id("openspec").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file) || Boolean(this.open), (el) => el.child(div().id("openspec-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => back(cx)).child("←")))
        .child(div().font_semibold().child("OpenSpec"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(crumbs.join(" / "))))
      .when(Boolean(this.file), (el) => el.child(
        this.markdown !== null
          ? v_flex().id("os-markdown").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).text_color(t.foreground)
              .child(TextView.markdown(`os-md-${this.file}`, this.markdown).selectable(true))
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(!this.file && Boolean(this.open), (el) => el.child(this.detailBody(t)))
      .when(!this.file && !this.open, (el) => el.child(this.listBody(t)));
  }
}
