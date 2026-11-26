# Roadmap

Done
- Detection core in JS (core/tailchaser_core.js), 19 synthetic tests (incl. crossover ripple and click tests) (tests/test_core.js)
- Design mockup v1.2 (docs/mockups/TailChaser_mockup_v1.2.html): combined Cut lane, Bands view toggle, Smooth knob, pink and cut-start marker drawn from the real gain curve

Next
- C++/JUCE port of the core with a parity test against the JS core
- Port the mockup window natively (same layout, looks, tooltips)
- Scan mode in the host: analyse while the track plays, then exact cuts
- Automation write (Write then Read, like fader riders): test in Bitwig and Studio One; host support is unverified
- Fallbacks: cut curve CSV, render cleaned WAV
- Live (lookahead) mode with reported latency
- Spectral similarity for echo detection (today it is a level rule)
- Per-band detection filters
- Installers (Windows .exe, macOS .pkg, Linux Flatpak), manual, uninstallers

Known limits
- Tested on synthetic signals only, not yet on real music or by ear
- Ghost notes after a loud hit can count as echoes: lower Echo

Latency note
- 1 band: no delay. Several bands: the core uses zero-phase crossovers (measured: no boost or dip when one band is cut). The plugin needs linear phase FIR crossovers that add a reported delay; the figure will be measured in the port.
