# Strava Fixer

Fix the GPS points in an activity where the signal was lost or inaccurate,
using a map. Only the GPS positions change, along with the distance and speed
worked out from them, so a glitch no longer inflates your distance or max
speed. Heart rate, cadence, power, temperature, elevation, timestamps and
every other recorded value are kept exactly as they were.

**Use it here: https://bluehair-co.github.io/strava-fixer/**

## How it works

1. On strava.com, open your activity, click the "..." menu and choose
   **Export Original** to download the original FIT or GPX file.
2. Open that file in Strava Fixer (it stays on your computer, nothing is
   uploaded). On the map:
   - **Drag** a point to move it.
   - **Click** a point to select it, then **shift-click** another to select
     everything in between, or hold **Shift** and **drag a box** on the map.
   - A side panel lists the selected points (number and time). **+ Point
     before / after** grows the selection by one point on that side.
   - **Straighten** lines the selected points up between the two ends,
     spaced by their recorded time.
   - **Remove GPS** (FIT files only) keeps the samples, with their heart rate
     and so on, but drops their position.
   - **Undo** and **Reset** take changes back.
3. **Download fixed file.** The new total distance is shown above the map.
   Before downloading, the app checks that nothing but GPS positions,
   distance and speed differs from the original, and refuses if anything
   else changed. Then delete the old activity on Strava and upload the fixed one.

Deleting an activity on Strava removes its kudos, comments, photos, title,
description and private notes, so copy anything you want to keep first.

## Running it on your computer

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install     # download the libraries the app uses (first time only)
npm run dev     # start the app
```

Then open http://localhost:3000 in your browser. Changes to the code show up
automatically.

## Checks

`npm run lint` looks for common mistakes, `npm test` runs the automated tests
(in `src/lib/*.test.ts`), and `npm run build` makes sure the app compiles.
GitHub runs all three on every pull request (see the "Checks" tab).

## How the code is organised

- `src/lib/fit.ts` and `src/lib/gpx.ts` read the files and write back only
  the position values (and, for FIT, the distance and speed fields), leaving
  every other byte untouched. Distance is adjusted only where you edited:
  untouched stretches keep the watch's own distance.
- `src/lib/track.ts` has the editing tools (move, straighten, remove GPS).
- `src/components/Editor.tsx` is the page with the buttons;
  `src/components/MapView.tsx` draws the map using Leaflet.

## Hosting

The app is published on GitHub Pages by `.github/workflows/deploy.yml`.
Every change merged into `main` goes live a couple of minutes later; you can
follow it in the repo's **Actions** tab.

## License

[CC0 1.0](LICENSE): public domain.
