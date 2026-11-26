# Roadmap

Done
- Detection core in JS (core/tailchaser_core.js), 28 synthetic checks (ripple, clicks, echo vs new sound, echo timing, Center)
- Design mockup v1.7 (docs/mockups/TailChaser_mockup_v1.7.html): waveform view like a DAW clip (default) with detected tails shaded like a selection, Auto-find tails button, playback keeps going while knobs move (30 ms crossfade), Echo time (Auto or set), Sync to tempo, Center (stereo-aware), octave onset detection, held-note guard

Next
- Real music tests (needs files from the user)
- Optional AI dereverb render mode: research open models with licences that fit AGPL first
- C++/JUCE port of the core with a parity test against the JS core
- Port the mockup window natively (same layout, looks, tooltips)
- Scan mode in the host: analyse while the track plays, then exact cuts
- Automation write (Write then Read, like fader riders): test in Bitwig and Studio One; host support is unverified
- Fallbacks: cut curve CSV, render cleaned WAV
- Live (lookahead) mode with reported latency
- Echo detection uses an 8-band sound fingerprint (v1.4); refine on real music
- Per-band detection filters
- Installers (Windows .exe, macOS .pkg, Linux Flatpak), manual, uninstallers

Known limits
- Tested on synthetic signals only, not yet on real music or by ear
- A ghost note of the same drum exactly on the delay time grid counts as an echo; set Echo time by hand or lower Echo
- In a full mix, delay echoes under busy drums are only partly cut: use it on the delay bus or the instrument track
- Very quiet low notes (under 500 Hz) hidden under a louder low tail are not seen as new notes and can lose a few dB

Latency note
- 1 band: no delay. Several bands: the core uses zero-phase crossovers (measured: no boost or dip when one band is cut). The plugin needs linear phase FIR crossovers that add a reported delay; the figure will be measured in the port.
