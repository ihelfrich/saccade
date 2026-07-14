# Saccade

An RSVP speed reader with ORP highlighting, built for academic papers and for actually retaining them. Live at [ihelfrich.github.io/saccade](https://ihelfrich.github.io/saccade/).

Words arrive one at a time at a fixed point on screen, with the optimal recognition point letter marked in red, so your eyes stop making saccades between words. Pacing is adaptive rather than metronomic: long, rare, and complex words, numbers, acronyms, and equations stay up longer; the display breathes at commas, sentence ends, and paragraph breaks; a short warm-up ramp eases you back in every time you resume. An optional auto mode adjusts speed for you: rewinds slow it down, cruising nudges it up.

## Figures, tables, and equations

RSVP can't stream a regression table or an event-study figure; those are 2D, and the finding usually lives in them. So the word stream stops on them. On a PDF, Saccade detects figure and table captions, lifts the actual image out of the page (rendered client-side with pdf.js, never uploaded), and shows it as a still card your eyes can rest and move over. Display equations show as their own card too. Tap or press space to continue; press g to jump straight to the next figure or table. Save an exhibit to notes like any sentence.

## Thinking, not just remembering

Retention tests recall of single sentences. The connection drill (press c) does the other half: it pairs two of your saved notes from *different* papers that share some ground but aren't near-duplicates, and asks you to write the link in your own words. The app never writes it for you; the point is that you generate it. What you write becomes a Synthesis note that itself comes back on the spaced schedule.

## Built for getting started and getting back

- **One section**: a bounded first step that reads to the end of the current section and stops. Lower the activation cost, then decide to keep going.
- **Where was I**: reopen a document after a real gap and a card reinstates the section, the last sentence, and your last note before anything moves.
- Start from any section in the contents panel; you don't have to read front to back.

## Retention, not just speed

- **Highlights.** Press h (or hold the word on touch) to save the current sentence to notes, tagged with its section. Jump back to any saved sentence, copy everything as markdown, or replay just your highlights as a fast review pass. Finishing a document shows a recap with one tap into that replay.
- **Section map.** A segmented bar shows every section of the document and your position inside it; tap a segment to jump. Section transitions display as brief title cards ("section 4 of 9"), and the contents panel lists per-section reading times.
- **First-pass mode.** One tap reads only headings plus the first sentence of each paragraph: the skeleton of the argument before the full read.
- **Structure for attention.** Nothing autoplays, positions persist per document, Skim/Read/Study presets bundle the fiddly decisions, rest breaks arrive on a timer, a daily goal and streak live behind the words-today counter, and the interface dims itself while you read.

## What it handles

- **PDFs, entirely in the browser.** Two-column layout detection, running header and footer removal, hyphenation repair, heading detection, title extraction. Nothing is uploaded anywhere.
- **Academic clutter.** Inline citations such as "(Rayner, 1998)" or "[12]" collapse to a fast (ref) marker; equation fragments compress to a single token; the references section is skipped by default. All adjustable.
- **Plain text, markdown, and URLs**, including arXiv PDF links, fetched through the Jina reader proxy.
- **Search** inside the document from the contents panel.

## Sync between devices

Optional. Saccade can keep your library, positions, notes, and stats in a **private GitHub Gist** so a Mac and an iPad stay in step. Paste a GitHub token with only the gist scope into settings on each device. The token lives in that device's localStorage and is never written into the synced payload or this repository. Merging is per-document last-write-wins, with highlights unioned, so nothing you saved disappears.

## Keys

| Key | Action |
| --- | --- |
| space | play / pause |
| left / right | back / forward one sentence |
| shift + left / right | back / forward one paragraph |
| up / down | faster / slower |
| 0 | restart current sentence |
| h | save current sentence to notes |
| b | back 30 words |
| f | focus mode |
| r | full text view |
| / | search in document |
| t / l / n / s | contents / library / notes / settings |
| esc | close panels |

On touch: tap the center to play or pause, tap the left or right edge for sentence jumps, hold the word to save it to notes, swipe for sentence jumps.

## iPad

Open the site in Safari, tap Share, then Add to Home Screen. It runs full screen and works offline (service worker; pdf.js and the Atkinson Hyperlegible font are vendored). Load papers from the Files app or by URL, and turn on sync to continue exactly where you left off on the Mac.

## Local development

No build step. Serve the directory and open it:

```bash
python3 -m http.server 8123
```

## Privacy

Everything runs client-side. Documents, positions, notes, settings, and stats live in your browser's localStorage. The only network calls are the optional URL fetch (r.jina.ai) and, if you enable it, sync to your own private GitHub Gist.

Atkinson Hyperlegible font by the Braille Institute (see fonts/LICENSE). App is MIT.
