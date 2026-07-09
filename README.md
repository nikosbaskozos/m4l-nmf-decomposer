# NMF Decomposer for Ableton Live — Manual by Claude

A Max for Live device that splits audio into spectral components using
FluCoMa's NMF. It builds the components as new tracks in your Set and/or
feeds a real-time NMF filter running on the track.

**Requires:** Ableton Live 12.0.5+, Max for Live with FluCoMa installed.
**Files:** the device (.amxd) and `nmf-device.js` in the same folder.
**Tip:** keep the Max Console open — the device narrates every step.
Analysis is mono: stereo sources use the left channel.

---

## 1. Three ways to give it audio

**A) Selected clip** — click any audio clip in Live, bang **decompose**.
New tracks appear directly below the clip's track; clips are placed in
the Arrangement at the clip's position, matching its warp/length.

**B) Manual file** — click **replace**, pick a file, select a target
track in Live, bang **start**. Tracks appear below the selected track,
clips at the playhead.

**C) Listen (real-time)** — flip the **listen** toggle ON while audio
plays through the track (a clip, or live input with monitoring on).
Flip OFF: the capture is analyzed automatically with the current
settings. Capture length: minimum 0.5 s, maximum 60 s (recording stops
at 60 s if you leave it on). Tracks/clips are placed where the playhead
was and which track was selected **when you switched listen ON** — so
for tight alignment: stop transport, place the playhead, toggle on,
then hit play.

In all cases: press **Cmd/Ctrl-G** afterwards to group the new tracks
(Live's API cannot create groups).

---

## 2. Controls

| Control | What it does |
|---|---|
| **decompose** (bang) | Analyze the clip selected in Live (mode A). |
| **replace** / **start** | Load a file / analyze it (mode B). |
| **listen** (toggle) | Record track audio; off = analyze (mode C). 0.5-60 s. |
| **components** (1-16) | How many layers to split into. |
| **fast 2-stage** (toggle) | Learn on a ~30 s excerpt instead of the whole file, then apply. Much faster on long files, same kind of output. |
| **descriptor mode** (toggle) | Output 2 layers instead of N: one chosen by ranking + "rest" (see §3). |
| **descriptor** (1-4) | Ranking rule: 1=centroid 2=flatness 3=pitch 4=amplitude. |
| **keep rank** (1-16) | Which ranked component to isolate. Rank 1 = highest value, last rank = lowest. |
| **learning slices** (1-32) | 1 = learn from one ~30 s mid-file block. 6-12 = learn from short slices spread evenly across the file (more representative). |
| **filter-only** (toggle) | No tracks, no files, no folder needed — the run only reloads the real-time filter. Fastest option. |
| **choose output folder** (bang) | Override where WAVs go (default: the Live Set's folder; unsaved Set = source file's folder or a one-time prompt). |
| **filter base** (number) | Which component the real-time filter passes. |
| **filter ON** (toggle) | Filtered vs dry signal on the track. |

---

## 3. Descriptor mode (chosen vs rest)

Normal mode gives N components in random order. Descriptor mode gives
exactly two: one picked by ranking, and everything else summed as
"rest". Ranks always run highest → lowest:

| Descriptor | rank 1 | last rank |
|---|---|---|
| 1 centroid | brightest | darkest |
| 2 flatness | noisiest | most tonal |
| 3 pitch | highest peak | lowest peak |
| 4 amplitude | loudest | quietest |

Example: 10 components, descriptor 4, keep rank 10 → isolate the
quietest layer. The console prints the full ranking with scores.
"Pitch" ranks by each component's strongest spectral peak (a proxy,
not true pitch tracking).

---

## 4. The real-time filter

Every analysis loads the learned spectral templates into a live NMF
filter on the track. Whatever plays through the track is split against
them in real time.

- **filter base** picks which template you hear.
- After a normal run: bases 1..N (max 8; runs with N>8 fill only 8).
- After a descriptor run: base 1 = chosen, base 2 = rest.
- The filter always follows the **last** analysis, whichever mode.
- Filter path is mono-summed, ~23 ms latency.
- Bases live in RAM: after reopening the Set, analyze again.

Performance loop with mode C: listen → play something → toggle off →
seconds later the filter is isolating a layer of what you just played,
applied to everything on the track from then on.

---

## 5. Good to know

- NMF starts from a random state: repeat runs give similar components
  in different order. Descriptor mode is how you target a layer reliably.
- Component WAVs are timestamped; nothing is ever overwritten.
- Excerpt learning (fast/descriptor) can miss sounds absent from the
  excerpt — raise **learning slices** to 8-12 on varied material.
- Captures (mode C) are short, so slices = 1 is fine there.
- The device needs these buffers in the patch: nmfsrc, nmfresyn,
  nmfmono, nmfbases, nmfbases2, nmfacts, nmftrain, nmfcap.

## 6. Troubleshooting

- **Nothing happens:** console must show `script v22 loaded OK`;
  otherwise `nmf-device.js` isn't next to the .amxd or is misnamed.
- **Tracks but empty clips:** Live must be 12.0.5+. Failed files are
  named in the console; the WAVs are still on disk.
- **Stuck mid-run:** send `reset` to the js. `status` prints settings
  and state. `(ignoring unexpected ...)` lines are harmless guards.
- **Capture ignored:** it was under 0.5 s.
- **Folder prompt:** the Set was never saved — save it, or pick a
  folder once (remembered for the session). Filter-only never asks.

## 7. Acknowledgements
- Built with FluCoMa (flucoma.org)
- Developed with assistance from Claude (Anthropic)
