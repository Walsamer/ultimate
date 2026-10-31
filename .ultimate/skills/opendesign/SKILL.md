---
name: opendesign
description: Implement a design the user made in OpenDesign. Use when a task is about building or changing UI whose design lives in OpenDesign, when the user says "implement the design I made", or when a page must match an OpenDesign frame. Pull the design into designs/ first with the opendesign extension's design_pull tool, implement from those files and their tokens, then screenshot the result and compare it against the design before reporting.
---

# Implement a design from OpenDesign

OpenDesign is where the user designs; this repository is where the result is built. The `opendesign` extension (in
`.ultimate/extensions/opendesign/`) pulls a design into `designs/<slug>/` as a read-only snapshot. The design is the
source of truth for how it looks; the code is the source of truth for how it works.

## 1. Pull before you implement

- `design_pull { project? }` — pull the named project, or the one the user has open. `design_active` says what that is;
  `design_list` lists everything when nothing is open.
- When `design_active` says nothing is open, ask the user to click into the project in OpenDesign (the active project
  expires about five minutes after their last interaction) and pull by name from `design_list` in the meantime.
- When the pull answers that it cannot reach OpenDesign or that OpenDesign refused the token, report that sentence as it
  is — it names the setting or the secret to fix. Do not invent a design from a description instead.

Codemode can call the same thing: `ultimate.action('opendesign', 'pull', { project: 'Landing' })`.

## 2. Read the snapshot

- `designs/<slug>/design.json` is the manifest: project id and name, the source daemon, when it was fetched, the entry
  file, the frame PNG (when OpenDesign could render one), every file with its size and sha256, and anything skipped (a
  name that would escape the folder, a file too large). Read it before reading files.
- The answer to `design_pull` already says what changed since the pull before: `added`, `changed`, `removed` and
  `unchanged`. On a re-pull, read the changed files first; leave the rest alone.
- **Never edit `designs/`.** It is a snapshot the next pull overwrites. If the design is wrong, the change belongs in
  OpenDesign, and the user pulls again.

## 3. Build with the design's own tokens

The pulled CSS carries the design system's custom properties (`:root { --ink: …; --space-2: … }`), and
`design.json`'s `project.designSystemId` names the system it came from when one is bound. Use those tokens — the same
colour, spacing and type-scale variables, or their equivalents in the project's own token file — instead of hard-coding
values copied out of the snapshot. Where the project already has a token with that role, use the project's.

Match structure, not pixels: the same hierarchy, spacing scale, type scale, radii, states (hover, focus, disabled,
empty, loading) and breakpoints. If the design shows something the implementation has no place for, say so instead of
dropping it silently.

## 4. Compare before you report

This is the step that gets skipped. Do it every time:

1. Run the implementation and screenshot the page at the design's size. Use the `browser` and `screenshot` tools; on a
   preview, drive the page you are comparing.
2. Look at the design itself: open `designs/<slug>/frame.png` when the manifest lists one, otherwise render the pulled
   entry file (`designs/<slug>/<entry>`) — it is exactly what OpenDesign shows.
3. Compare the two deliberately: layout and alignment, spacing rhythm, type sizes and weights, colours, radii and
   borders, icon sizes, and each state the design shows.
4. Report the differences you found, with what you changed or why you left it. Never write "matches the design" unless
   you compared a screenshot of the running page against the design and found nothing to fix.
