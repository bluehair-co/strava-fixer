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
   - **Add points**: turn it on, then click the map to add a new point to the
     nearest stretch of track, e.g. to follow the road where the GPS cut a
     corner. Drag it to fine-tune. A new point gets a time from how far along
     the stretch it is: a third of the way between two recorded points means
     a third of the time between them. Recorded times never change, and the
     time is worked out again whenever you move it or add another point next
     to it. It's saved as a new sample with only a time and a position (plus
     distance and speed): no heart rate, cadence, power or elevation is made
     up for it. Times are whole seconds, as that's all FIT files store.
     **Delete added point** in the side panel removes it again.
   - **Lock recorded points** freezes the points from your recording, so you
     can't move them by mistake (you can still click to select them). Points
     you added can still be dragged, and **Straighten** only lines up added
     points. Click it again to unlock.
   - **Crop**: drag the Start and End sliders above the map (or select a
     point and click **✂ Start here** / **✂ End here**) to cut off the
     beginning or end, e.g. if you forgot to stop recording. The cut-off
     part turns grey on the map, and the distance overview shows how much
     each end removed. Cropping removes whole samples; the ones kept stay
     as recorded, with distance counted from the new start. **Don't crop**
     undoes it.
   - **Undo** and **Reset** take changes back.
3. **Download fixed file.** The new total distance is shown above the map.
   Before downloading, the app checks that nothing but GPS positions,
   distance and speed differs from the original (and that added points hold
   only a time and a position), and refuses if anything else changed. Then delete the old activity on Strava and upload the fixed one:
   after downloading, the app reminds you of the order and has a button that
   opens Strava's upload page.

## Combining recordings

The **Combine recordings** tab puts several recordings into one activity,
for example the same ride recorded on your watch (heart rate, but late or no
GPS) and your phone (good GPS), or a recording that stopped when a battery
died and a second one that carried on.

1. Export the original file of each activity from Strava and add them all
   (FIT or GPX, as many as you like).
2. Every file's track is drawn on the map in its own colour, and coloured
   bars show when each file was recording. The combined result is drawn
   underneath in wide orange. Untick a file to hide it.
3. In the table, pick which file to keep each kind of data from (GPS track,
   elevation, heart rate, cadence, power, temperature), or **None** to leave
   it out. With "use the other files" ticked, moments the chosen file didn't
   record are filled in from the others.
4. Optionally **crop** the result with the Start and End sliders to cut
   off the beginning or end.
5. **Download combined file**, delete the originals on Strava, and upload
   the new one.

Values are never changed, only copied from the file you chose; distance and
speed are recalculated from the final track. When everything except the GPS
track comes from one file, that file is kept exactly as it is (laps and all)
and only its positions change. Otherwise a new file is built, and laps and
device details from the originals aren't carried over. Either way a safety
check reads the result back and refuses the download if any value isn't
exactly what one of your files recorded at that moment.

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
- `src/lib/sources.ts` reads FIT and GPX files for combining;
  `src/lib/combine.ts` picks each kind of data from the chosen file and writes
  the result, using `src/lib/merge.ts` (GPS into one file) or
  `src/lib/join.ts` (one after the other) when they fit.
  `src/components/Merge.tsx` and `TracksMap.tsx` are the page.
- `src/components/Editor.tsx` is the page with the buttons;
  `src/components/MapView.tsx` draws the map using Leaflet.

## Hosting

The app is published on GitHub Pages by `.github/workflows/deploy.yml`.
Every change merged into `main` goes live a couple of minutes later; you can
follow it in the repo's **Actions** tab.

## License

[CC0 1.0](LICENSE): public domain.
