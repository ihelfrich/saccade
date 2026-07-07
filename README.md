# Saccade

An RSVP speed reader with ORP highlighting, built for academic papers. Live at [ihelfrich.github.io/saccade](https://ihelfrich.github.io/saccade/).

Words arrive one at a time at a fixed point on screen, with the optimal recognition point letter marked in red, so your eyes stop making saccades between words. Pacing is adaptive rather than metronomic: long and rare words, numbers, acronyms, and equations stay up longer; the display breathes at commas, sentence ends, and paragraph breaks; a short warm-up ramp eases you back in every time you resume.

## What it handles

- **PDFs, entirely in the browser.** Two-column layout detection, running header and footer removal, hyphenation repair across line breaks, section heading detection (with a jump-to table of contents), and title extraction. Nothing is uploaded anywhere.
- **Academic clutter.** Inline citations such as "(Rayner, 1998)" or "[12]" collapse to a fast (ref) marker (or vanish, or stay, your choice). Runs of extracted equation fragments compress to a single token. The references section is skipped by default.
- **Plain text, markdown, and URLs.** Paste text, open .txt or .md files, or fetch a URL (including arXiv PDF links) through the Jina reader proxy.

## Designed around attention

- Nothing autoplays. Position is saved per document, so reopening the site resumes exactly where you stopped.
- Pause at any moment and the full current sentence appears with your word marked, so re-anchoring is instant. The left arrow restarts the sentence, then steps back one sentence at a time.
- Skim / Read / Study presets set speed, pause weights, and citation handling in one tap.
- Optional rest breaks on a timer, an interface that dims itself while you read, a focus mode that hides everything but the word, and a full-text view with bionic-style bolded word starts for skimming context.
- Words-read-today counter, progress percentage, and time remaining are always available.

## Keys

| Key | Action |
| --- | --- |
| space | play / pause |
| left / right | back / forward one sentence |
| shift + left / right | back / forward one paragraph |
| up / down | faster / slower |
| 0 | restart current sentence |
| f | focus mode |
| r | full text view |
| t / l / s | contents / library / settings |
| esc | close panels |

On touch devices: tap the word to play or pause, swipe for sentence jumps. The app installs to a phone or tablet home screen and works offline (PWA with a service worker; pdf.js is vendored).

## Local development

No build step. Serve the directory and open it:

```bash
python3 -m http.server 8123
```

## Privacy

Everything runs client-side. Documents, reading positions, settings, and stats live in your browser's localStorage. The only network call the app can make is the optional URL fetch, which goes through r.jina.ai.

MIT license.
