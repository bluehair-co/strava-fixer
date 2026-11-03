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
   - **Undo** and **Reset** take changes back.
3. **Download fixed file.** The new total distance is shown above the map.
   Before downloading, the app checks that nothing but GPS positions,
   distance and speed differs from the original (and that added points hold
   only a time and a position), and refuses if anything else changed. Then delete the old activity on Strava and upload the fixed one:
   after downloading, the app reminds you of the order and has a button that
   opens Strava's upload page.

## Merging a watch and a phone recording

If you recorded the same activity on two devices, say your phone (good GPS)
and your watch (heart rate, but GPS that started late or never came), the
**Merge or join recordings** tab (option *Same activity on two devices*)
turns them into one activity:

1. Export the original file of both activities from Strava.
2. Choose the phone's file as **recording 1** (only its GPS track is used) and
   the watch's file as **recording 2** (everything in it is kept: times, laps,
   heart rate, cadence, power, elevation).
3. Pick whether to use the phone's GPS for the whole activity, or only where
   the watch had none. The two are lined up by time.
4. **Download merged file**, delete both originals on Strava, and upload the
   merged file.

The same safety check applies: compared with the watch's file, only GPS
positions, distance and speed may differ. If the watch saved its samples with
no room for a position at all, the app adds empty latitude/longitude fields
to them first (this is the one case where the file grows).

## Joining recordings made one after the other

If one device ran out of battery and you carried on recording with another,
choose *One after the other* in the same tab and pick both files (two FIT
files or two GPX files; either order, the app sorts them by time). Every
sample of both files is kept as recorded; the gap between them shows up as a
pause. The only value that changes is the second part's running distance,
which carries on from where the first part stopped (plus the straight line
between where one ended and the other began). Then delete both originals on
Strava and upload the joined file.

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
- `src/lib/merge.ts` lines up two recordings by time and copies the GPS
  track from one into the other; `src/lib/join.ts` puts two recordings one
  after the other. `src/components/Merge.tsx` is the page for both.
- `src/components/Editor.tsx` is the page with the buttons;
  `src/components/MapView.tsx` draws the map using Leaflet.

## Hosting

The app is published on GitHub Pages by `.github/workflows/deploy.yml`.
Every change merged into `main` goes live a couple of minutes later; you can
follow it in the repo's **Actions** tab.

## License

[CC0 1.0](LICENSE): public domain.
