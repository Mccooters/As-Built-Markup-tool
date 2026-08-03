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
2. **Calibrate** the sheet — click two points a known distance apart and type the real distance (`25'`, `12'6"`, `7.6m`), or pick a preset scale (1/8", 1/4", 1"=20', 1:100 …). Per-page or all-pages.
3. **Draw pipe runs** (`P`) — click along the route, double-click to finish. Runs are **color-coded by pipe size**, labeled with size + length automatically, and snap to the ends of other runs so headers and branches connect cleanly. Ortho drawing is on by default (hold `Shift` for free angles).
4. **Drop symbols** — ball valves, shut-off/check valves, regulators, filter/lubricator/FRL sets, air drops, auto drains, quick couplers, unions, gauges, flow meters, compressors, receivers, dryers, elbows, tees, reducers — plus **AS-BUILT / INSTALLED / REMOVED / RELOCATED / FIELD VERIFY** stamps.
5. **Count** (`C`) — create count groups (drops, couplers, elbow fittings…) and click to place marks.
6. Add **clouds, callouts, text, arrows, highlights** for revision notes.
7. Check the **Takeoff** tab — total length per pipe size/material, fitting quantities, counts — and the **Markups List** at the bottom (sortable, filterable, click a row to jump to the markup).
8. **Export** — a flattened PDF with every markup burned in (print-ready, true page size), and/or a CSV containing the pipe takeoff, fitting schedule, counts, and the full markup log.

## Feature map (Bluebeam Revu → AirMark)

| Bluebeam | AirMark |
|---|---|
| Markup tools (line, arrow, box, ellipse, cloud, pen, highlighter, text, callout) | ✔ All included; revision clouds with adjustable scallops |
| Measurement tools (calibrate, length, polylength, area, count) | ✔ Included, with preset sheet scales and ft-in / decimal-ft / metric display |
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
| `Shift` | Free angle on pipes (ortho is default) · constrain lines to 45° |
| `R` | Rotate symbol (before or after placing) |
| `Esc` | Cancel / clear selection |
| `Del` | Delete selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+D` | Duplicate |
| `Ctrl+A` | Select all on page |
| `Ctrl+S` | Save project |
| Mouse wheel | Zoom at cursor · `+` / `−` / `0` zoom in/out/fit |
| `PgUp` / `PgDn` | Previous / next page |

## Files & saving

- **Autosave** — markups are saved in the browser per drawing (keyed to the PDF's fingerprint) about a second after every change. Re-open the same PDF and you'll be offered a restore.
- **`.airmark` project** — `Save` writes a single JSON file containing markups, calibration, count groups *and the PDF itself* (when under 50 MB), so a project can move between computers. `Load` (or drag-drop) opens it back up.
- **Flattened PDF** — `Export PDF` renders each sheet at high resolution with markups burned in, at the original page dimensions, so printed scale stays true.
- **CSV** — pipe takeoff by size/material, fittings & equipment quantities, counts, and the complete markup list.

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

Markup geometry is stored in PDF page units (points), so markups stay put at any zoom and export at exact scale. Touch input works for tablets (draw with a finger, two-finger pinch to zoom).

## Known limits / ideas for later

- Flattened export is rasterized (~200 DPI) rather than vector; crisp in print, but not text-searchable.
- One drawing open at a time; no markup layers/status workflow yet.
- Symbol library is fixed — a custom "tool chest" editor would be a natural next step.
- No cloud sync/collaboration — files and browser storage only, by design.
