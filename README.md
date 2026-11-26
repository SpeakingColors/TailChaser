# Tail Chaser

A free, open source tail cleaner for mixes and tracks (VST3, Linux first). It scans the audio, finds the tails of reverbs, delays and room noise, and fades them out so the mix stays tight with more silence in between the hits. A Mix knob blends back the original, and each of up to four bands is handled on its own so a long bass note is not cut because the reverb above it is.

Status: design mockup v1 and a tested detection core. The plugin itself is not built yet. See ROADMAP.md.

Try the mockup: open `docs/mockup/index.html` in a browser (it plays demo sounds, or load your own file).

## What it does

- Finds hits and the tails that follow them, per band
- Echo guard removes delay repeats: it learns the delay time and only removes repeats that sound like the note and sit on that time grid
- Sync to tempo for Keep, Fade and Echo time; Center keeps the dry middle and clears the wide reverb
- Floor adds silence in anywhere below a level
- Keep, Fade, Depth and Curve shape how the tail is cut; the next hit is never cut
- Display shows the original level, the cleaned level and what was removed, per band
- Print: cut curve export (CSV) and cleaned audio; host automation write is planned, see ROADMAP.md
- Offline, no network, nothing collected

## Licence

AGPL-3.0-or-later. Fonts under the SIL Open Font License.

This repo does not take issues or pull requests. Support the work: https://ko-fi.com/studio87
