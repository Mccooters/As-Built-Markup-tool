# AirMark audit against Bluebeam Revu

Audit date: 2026-11-03 (AirMark v2026.11.03b). Compared against the markup, measurement, review and document features of Bluebeam Revu (Standard/Core level), filtered through what matters for marking up compressed-air as-builts on an iPad on site.

Legend: ✔ have it · ★ added in this release · ◐ partial / different by design · ✗ left out on purpose · — not applicable to this app.

## 1. Markup tools

| Bluebeam | AirMark | Notes |
|---|---|---|
| Text box | ✔ | ★ Bold, border and white-background options |
| Typewriter | ◐ | Text tool with no border/background is the same thing |
| Note (sticky) | ◐ | Every markup has a Comment field shown in the list; no pin icon |
| Callout | ✔ | |
| Line, Arrow | ✔ | ★ Arrowheads at start, end or both ends |
| Polyline | ✔ | ★ Arrowheads, cloud outline |
| Arc | ✗ | No pipe use |
| Rectangle, Ellipse | ✔ | |
| Polygon | ★ | Closed polyline with fill; cloud outline; optional perimeter label |
| Cloud (rectangular) | ✔ | Scallop size adjustable |
| Polygon cloud | ★ | Polygon + *Cloud outline* |
| Cloud+ (cloud with callout) | ✗ | Cloud + Callout does it |
| Pen (freehand), Highlighter | ✔ | |
| Eraser | ✗ | Delete / undo cover it |
| Stamp | ✔ | AS-BUILT, INSTALLED, REMOVED, RELOCATED, FIELD VERIFY; custom stamps via Tool Chest |
| Image | ✔ | Photo tool: pin, resize, caption, flattens into the export |
| Hyperlink | ✗ | |
| Sequence (auto-number) | ★ | `N`: prefix, next number, digits; drops `D-01`, `D-02`… |
| Snapshot (copy region as image) | ✗ | |
| Dynamic Fill | ✗ | |
| Sketch tools (sketch to scale) | ◐ | Pipe runs draw at true OD width at sheet scale — the one sketch-to-scale that matters here |
| Hatch patterns | ✗ | Solid fill with opacity only (vector hatch export through pdf-lib would be a large piece of work for little gain on piping sheets) |
| Line styles | ✔ | Solid / dashed / dotted |
| Custom columns in markup data | ◐ | Fixed fields: subject, comment, status, layer, work day, pipe data |

## 2. Measurement

| Bluebeam | AirMark | Notes |
|---|---|---|
| Calibrate | ✔ | Two points, preset scales, ratio or paper = real entry, per page or all pages |
| Length, Polylength | ✔ | Live readout while drawing, touch loupe |
| Area | ✔ | |
| Perimeter | ★ | Area markups can label perimeter; polygons label perimeter |
| Count | ✔ | Count groups with shapes and colours |
| Diameter, Radius, Angle | ✗ | Not needed for piping takeoff |
| Volume | ✗ | |
| Cutout | ✗ | |
| Measurement totals for a selection | ✔ | Properties panel totals lengths, pipe by size, areas, counts |
| Viewports (several scales on one page) | ✗ | One scale per page |

## 3. Editing

| Bluebeam | AirMark | Notes |
|---|---|---|
| Undo / redo | ✔ | |
| Cut / copy / paste | ★ | `Ctrl+X/C/V`; nudged on the same page, in place on another page |
| Paste in place | ★ | Same coordinates on another page |
| Apply to all pages | ★ | *Copy to all pages* in the markup menu |
| Duplicate | ✔ | `Ctrl+D` |
| Group / ungroup | ★ | `Ctrl+G` / `Ctrl+Shift+G`; grouped markups select and move together; Tool Chest placements come in grouped |
| Lock | ★ | `Ctrl+L`; no move, resize, nudge or delete; padlock shown |
| Align (edges, centres) | ★ | Menu, two or more selected |
| Distribute | ✗ | |
| Bring to front / send to back | ★ | `Ctrl+]` / `Ctrl+[` |
| Flip | ✗ | |
| Rotate | ◐ | Symbols and stamps (`R` / Properties); other shapes no |
| Nudge | ✔ | Arrow keys |
| Set as default / format painter | ★ | *Set as tool defaults* from any markup |
| Right-click menu | ★ | Right-click, held finger on touch, or **More ▾** in Properties |

## 4. Review and organisation

| Bluebeam | AirMark | Notes |
|---|---|---|
| Markup status (Accepted / Rejected / Completed / Cancelled) | ★ | Properties and menu; list column, status filter, CSV, summary PDF |
| Custom statuses | ✗ | Fixed set |
| Reply / comment threads | ✗ | Single Comment field per markup |
| Layers | ★ | Free layer name; list groups by layer; hide a layer on the sheet; default layer per tool |
| Spaces | ✔ | Area zones, linked to AroFlo tasks — richer than Spaces |
| Markups List: sort, filter, columns | ✔ | Subject, label/comments, measurement, status, colour, author, date; filter by text, type, status, page |
| Markups List: hide / show | ✔ | Per group, per zone, per layer |
| Markup Summary (PDF / CSV) | ★ | CSV existed; **Markup summary PDF** added |
| Legend (auto table on the sheet) | ✗ | Takeoff tab and CSV/summary carry the schedules; a drawn legend is a later idea |
| Tool Chest (custom tools, recents) | ★ | Save any selection as a tool; place it anywhere; per device |
| Profiles | — | |
| Sets | ◐ | Drawings panel lists every sheet of the project with revisions |

## 5. Document

| Bluebeam | AirMark | Notes |
|---|---|---|
| Flatten | ✔ | Vector-quality export |
| Text search | ★ | `Ctrl+F` over the PDF's text layer, jump + highlight |
| Visual search | ✗ | |
| Bookmarks | ★ | Listed in the Find dialog |
| Page labels | ◐ | Page numbers only |
| Thumbnails | ✔ | |
| Compare documents / overlay pages | ✔ | Revision overlay (old in red under new in blue) |
| Split / combine / rotate pages | ✗ | Done in the drawing office |
| Form fields, digital signatures | ✗ | Delivery dockets have their own signed sign-off sheet |
| Studio (live collaboration) | ◐ | Team cloud: shared projects, per-drawing sync, last-save-wins with a warning; no live co-editing |

## 6. What AirMark has that Bluebeam doesn't

- Pipe runs at true OD width for the sheet scale, colour-coded by size, with a takeoff by size and material.
- Press-fitting palette with a running fittings schedule and AroFlo material codes.
- Penetration marks with a core-drill schedule.
- Work-day stamping, Day mode, and the daily report (PDF + materials CSV + AroFlo task note).
- Area zones linked to AroFlo tasks showing live status and materials used, with part logging from the drawing.
- Live AroFlo site stock, stocktakes, transfers, pick lists, delivery dockets.
- SharePoint drawing register per project; team cloud project list.
- Installable, offline, per-project home-screen icons.

## 7. Left out on purpose (and why)

- **Hatch fills** — vector hatch export needs clipped line patterns in pdf-lib; solid fills with opacity read fine on piping sheets.
- **Reply threads** — the Comment field plus status covers the review loop; threads need the team cloud to merge per-markup, which it doesn't do yet.
- **Legend on the sheet** — the schedules live in the Takeoff tab, CSV and summary PDF; a drawn legend that re-lays itself out is a later piece.
- **Angle / radius / diameter / volume** — no compressed-air use.
- **Page assembly (split, combine, rotate)** — belongs in the drawing office, not on site.
- **Tool Chest sync** — tools are per device for now; sharing them through the team cloud is the natural next step.
