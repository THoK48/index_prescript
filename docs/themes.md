# Visual themes

## Active: Limbus blue

The active interface uses the reference app's black-and-blue palette: `#000000`, `#2fbffc`, `#5cd0ff`, `#165b80`, and `#072233`.

## Active typefaces: pixel body and round-dot metadata

The body and Tailwind sans/mono utilities use the locally bundled GalmuriMono11 v2.40.4. Its unmodified upstream font and license come from [quiple/galmuri](https://github.com/quiple/galmuri/tree/v2.40.4/dist) and are stored as `public/fonts/galmuriMono11.woff2` and `galmuriLicense.txt`. Main directive text uses 24px/36px sizes with tighter line spacing.

The user-supplied Gothic Dot Round v0.2 remains on the execution counters and issue timestamp through `terminalDotMeta`; its original files and `gothicDotLicense.txt` are preserved. Synthetic bold/italic remain disabled. A 650ms text afterglow follows completed decryption once per line, respects reduced motion, and yields to the failure-red transition. The blue palette, CRT overlays, sounds, and Planner are unchanged. A later user request resumed APK builds: v1.0.2 includes these fonts and afterglow, with web/Android build success and packaged-asset checks recorded in `plans/mobileBuild.md`. Browser/device validation remains skipped.

## Preserved: monochrome

The complete black-and-white source state is stored as `directive-terminal-monochrome-theme.zip` beside the project distribution. Extract that archive into a separate folder to run or restore the earlier design without overwriting the active blue version.
