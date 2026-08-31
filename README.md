# AirMark — As-Built Markup Tool for Compressed Air Piping

A Bluebeam-style PDF markup and measurement tool built for one job: **marking up site drawings for compressed air pipe work** — routing, sizing, takeoffs, and as-built records — right in the browser.

![AirMark screenshot](docs/screenshot.png)

Everything runs client-side. Drawings never leave your computer — there is no server, no upload, no account.

## Quick start

- **Easiest:** open `index.html` in any modern browser (Chrome, Edge, Firefox). It works straight off the disk.
- **Or serve it** (recommended for regular use):

  ```bash
  cd As-Built-Markup-tool
  python3 -m http.server 8080
  # → http://localhost:8080
  ```

- **Or host it on GitHub Pages** (Settings → Pages → deploy from branch) — it's a fully static site.

Then drop a PDF drawing onto the window, or click **Sample** to load a built-in plant floor plan (pre-calibrated at 1/4" = 1'-0") and try everything immediately.

## The field workflow

1. **Open** the drawing (PDF, any page size, multi-page sets supported).
2. **Set the scale** — click the Scale button in the status bar and type the sheet's stated scale directly: a standard preset (1/8", 1/4", 1"=20', 1:100 …), any **custom ratio** (`1 : 75`), or a custom pairing (`1 in = 15 ft`, `1 mm = 50 mm`) — no reference dimension needed. If the sheet has a trustworthy dimension (or was replotted at an odd size), **calibrate** instead: click two points a known distance apart and type the real distance (`25'`, `12'6"`, `7.6m`). Per-page or all-pages.
3. **Draw pipe runs** (`P`) — click along the route, double-click to finish. Runs are **color-coded by pipe size**, drawn at their **true OD line width at the sheet scale** (a 2" header is visibly twice as wide as a 1" branch — IPS ODs for steel, +1/8" for copper, tube OD for aluminum) with a **Width ×** multiplier (0.5–6) to boost visibility on small-scale sheets while keeping every size proportional, labeled with size + length automatically, and snap to the ends of other runs so headers and branches connect cleanly. Route at **any angle** — hold `Shift` to snap to 45°, or turn on "Snap to 45° angles" in the pipe properties to make ortho the default (Shift then frees it). The snap grid is **relative to the previous leg**: start a run 30° off the building axis and the next legs still snap straight-on / 45° / square off that run, not off the sheet's horizontal. Connecting to another run's endpoint always wins over angle snapping. Sizes come in three families: **imperial NPS** (1/4"–6"), **metric tube** (15–160 mm, designation = OD — covers Transair/AIRnet-style aluminum and EN 1057 copper sizes like 35/54/108 mm), and **metric steel DN15–DN150** (EN 10255 ODs).
4. **Drop symbols** — ball valves, shut-off/check valves, regulators, filter/lubricator/FRL sets, air drops, auto drains, quick couplers, unions, gauges, flow meters, compressors, receivers, dryers, elbows, tees, reducers — plus **AS-BUILT / INSTALLED / REMOVED / RELOCATED / FIELD VERIFY** stamps.
5. **Mark penetrations** — click where pipe passes through a wall/floor to place a core-drill mark labeled with its required hole size (`Ø2-1/2"`), what it passes through (wall / floor / roof / ceiling / beam) and a fire-rated flag. One click sets the hole Ø to the **current pipe's actual OD** — for jobs where the fire-rating clearance isn't decided yet. The Takeoff tab totals them into a **penetration schedule** (qty per size/type), exported in the CSV.
6. **Pin site photos** — pick an image or just drag one onto the sheet to place it where the work is; resize by the corners, add a caption, double-click to view full size. Photos are downscaled for storage, saved in the project file, and **flatten into the exported PDF**.
7. **Count** (`C`) — create count groups (drops, couplers, elbow fittings…) and click to place marks.
8. Add **clouds, callouts, text, arrows, highlights** for revision notes.
9. **Track the day's work** — everything you add is stamped with the active work day; Day mode grays earlier days so the day's progress reads at a glance, and the **Report** button exports the daily handover (PDF + materials CSV + clipboard summary for AroFlo).
10. Check the **Takeoff** tab — total length per pipe size/material, fitting quantities, counts — and the **Markups List** at the bottom (sortable, filterable, click a row to jump to the markup).
11. **Export** — a flattened PDF with every markup burned in (print-ready, true page size), and/or a CSV containing the pipe takeoff, fitting schedule, counts, and the full markup log.

## Feature map (Bluebeam Revu → AirMark)

| Bluebeam | AirMark |
|---|---|
| Markup tools (line, arrow, box, ellipse, cloud, pen, highlighter, text, callout) | ✔ All included; revision clouds with adjustable scallops |
| Measurement tools (calibrate, length, polylength, area, count) | ✔ Included, with preset sheet scales, direct ratio entry (1:n / custom pairs) and ft-in / decimal-ft / metric display |
| — | ✔ Pipe runs render at their **actual OD width** for the sheet scale (toggleable per run) |
| Tool Chest custom symbols | ✔ Built-in compressed-air symbol library + stamps |
| Markups List panel | ✔ Sortable/filterable list with subject, comments, measurement, author, date; CSV export |
| Quantity takeoff | ✔ Live pipe takeoff by size & material + fitting/count schedules |
| Flatten & export | ✔ One-click flattened PDF export |
| Save markups separately from the PDF | ✔ `.airmark` project files (PDF embedded up to 50 MB) + per-drawing browser autosave |
| Undo/redo, duplicate, nudge, multi-select, marquee | ✔ |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `V` / `H` | Select / Pan (or hold `Space`, or middle-mouse drag) |
| `P` | Pipe run |
| `L` / `Shift+L` | Length / Polylength measurement |
| `A` | Area measurement |
| `C` | Count |
| `T` / `Q` | Text / Callout |
| `Enter` or double-click | Finish pipe / polyline |
| `Backspace` | Remove last point while drawing |
| `Shift` | Snap to 45° while drawing (free-angle is the default; inverted if 45°-snap is enabled in pipe properties) |
| `R` | Rotate symbol (before or after placing) |
| `Esc` | Cancel / clear selection |
| `Del` | Delete selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+D` | Duplicate |
| `Ctrl+A` | Select all on page |
| `Ctrl+S` | Save project |
| Arrow keys | Pan the view — including mid pipe run (`Shift` = faster) · nudge the selection when on Select |
| Mouse wheel | Zoom at cursor · `+` / `−` / `0` zoom in/out/fit |
| `PgUp` / `PgDn` | Previous / next page |

## Daily reports & work-day tracking

Every markup is stamped with the active **work day** (the date picker in the toolbar). Turn on **Day mode** (calendar button) and earlier days' work renders **grayed out** while the active day stays full color — step the date back and forth to review progress day by day (future days are hidden). Each markup's day is editable in Properties.

The **Report** button generates the day's handover in one go:

- a **day-highlighted PDF** — earlier work grayed, the day's work in color, stamped with a `DAILY REPORT — date — job ref` banner
- a **materials CSV** for the day — pipe lengths, IBEX Impress fittings (`IMPRESS-E90-54MM` style codes) and core-drill counts, ready to attach or import into AroFlo
- a formatted **work summary copied to the clipboard**, ready to paste straight into the AroFlo task note

The AroFlo task / job ref is remembered per project and printed on everything. The Takeoff tab and the CSV schedule export can also be scoped to the active day only.

## Press fittings (IBEX Impress)

The **Fittings** tab holds a press-fitting palette — elbows 90°/45°, bends, equal/reducing tees, couplings, slip couplings, reducers, unions, BSP adaptors, end caps, press ball valves, flange adaptors, wall plate elbows — at any pipe size (press sizes 15–108 mm included). Tap a fitting, then tap the drawing where it goes; the tool **stays armed** so you can tap-tap-tap through an install, and each palette button shows today's running count. Fittings appear as small coded badges (`E90`, `TEE`…) colored by size, total into a fittings schedule in the Takeoff tab, and export with material codes in the CSV and daily report.

## Files & saving

- **Autosave** — markups are saved in the browser per drawing (keyed to the PDF's fingerprint) about a second after every change. Re-open the same PDF and you'll be offered a restore.
- **`.airmark` project** — `Save` writes a single JSON file containing markups, calibration, count groups *and the PDF itself* (when under 50 MB), so a project can move between computers. `Load` (or drag-drop) opens it back up.
- **Flattened PDF** — `Export PDF` keeps the **original pages untouched** (vector linework and text stay at full quality, still searchable) and draws the markups on top as **native PDF vector geometry** — pipes, shapes, clouds, labels and penetration marks are as crisp as the drawing at any zoom. Photos embed at their stored resolution; only symbol glyphs rasterize, as tiny ~600 DPI stamps. Rotated pages are handled, exports are small, and any markup the vector renderer can't reproduce falls back to its own high-res stamp so nothing goes missing. Only if the source PDF can't be reloaded (e.g. encrypted) does it fall back to rasterizing pages.
- **CSV** — the export dialog lets you tick exactly what goes in the schedule: whole sections (pipe takeoff, fittings, penetration schedule, counts, markup list) or individual rows, with totals recalculated over what's included, plus a note printed in the header (e.g. "Penetration Ø = pipe OD — fire-rating clearance TBC"). Selections persist with the project.

## Tech notes

Plain HTML/CSS/JS — no build step, no framework. Two vendored libraries:

- [PDF.js](https://mozilla.github.io/pdf.js/) `3.11.174` — rendering (`vendor/pdf.min.js` + worker)
- [pdf-lib](https://pdf-lib.js.org/) `1.17.1` — flattened-PDF export & the sample drawing generator

```
index.html          app shell
css/app.css         dark drafting UI
js/geometry.js      math: snapping, clouds, areas, hit tests
js/units.js         scales, ft-in/metric parsing & formatting
js/symbols.js       compressed-air symbol library, stamps, pipe presets
js/state.js         app state, events, undo/redo
js/viewer.js        PDF.js viewing: pages, zoom, pan, thumbnails
js/render.js        SVG rendering of every markup type
js/tools.js         pointer state machine for all tools
js/props.js         right panel: properties / symbols / takeoff
js/markuplist.js    markups list + takeoff computation + CSV
js/project.js       .airmark save/load, autosave
js/export.js        flattened PDF export, sample floor plan
js/app.js           toolbar, shortcuts, modals, wiring
```

Markup geometry is stored in PDF page units (points), so markups stay put at any zoom and export at exact scale.

**Tablet / iPad:** one finger drags a selected markup (or pans when over empty sheet / in a tap-style tool), taps place points and symbols — tap the last vertex again to finish a pipe run — double-tap edits text or opens a photo, and **two fingers pinch-zoom and pan** anywhere, even mid-run. A second finger cleanly cancels whatever the first finger started, so gestures never leave stray marks.

## Known limits / ideas for later

- One drawing open at a time; no markup layers/status workflow yet.
- Symbol library is fixed — a custom "tool chest" editor would be a natural next step.
- No cloud sync/collaboration — files and browser storage only, by design.
