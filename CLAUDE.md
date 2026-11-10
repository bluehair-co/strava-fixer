# Working rules for Claude in this repo

These are David's standing preferences. Follow them in every session.

## Pull requests
- Merge your own pull requests yourself (squash merge) once GitHub's "Check"
  passes. Tell David with a link when you have.
- David is new to coding: explain changes in plain language, and walk through
  any step he has to do himself.

## The app's core rule
- Only GPS positions (latitude/longitude), and the distance and speed values
  calculated from them, may change in an activity file. Heart rate, cadence,
  power, temperature, elevation, timestamps and every other recorded field
  must stay exactly as recorded. Recalculating distance from the fixed track
  is wanted: fixing wrong distances is part of the point of the app. The
  download safety check (`verifyFit` / `verifyGpx`) enforces this; never
  weaken it beyond those fields.
- Points added on the map (David's request) become new samples holding only
  a timestamp, a position, and distance/speed. Their time is interpolated by
  distance along the way between the two recorded points around them;
  recorded timestamps never change. No heart rate, cadence, power,
  elevation etc. is ever made up for them. The safety check allows exactly
  these new samples and nothing more.

- Combining recordings (the "Combine recordings" tab, David's request): the
  user picks, per kind of data (GPS, elevation, heart rate, cadence, power,
  temperature), which file it comes from. Values are copied unchanged from
  that file's own sample at that moment (positions may be interpolated
  between GPS points); distance and speed are recalculated from the final
  track. When everything but GPS comes from one file, that file is copied
  byte for byte except positions (`verifyMergedFit` / `verifyGpx`); two
  files one after the other are joined (`verifyJoinedFit` / `verifyJoinedGpx`);
  otherwise a new file is written and `verifyCombined` reads it back and
  checks every value is one a loaded file recorded at that time. GPX is
  written whenever a value comes from a GPX file, so decimals aren't rounded.

- Cropping (David's request, both tabs): cutting off the start and/or end
  removes whole samples (FIT records, GPX track points) recorded before the
  new start or after the new end, and FIT laps lying wholly in the cut-off
  part. Kept samples stay exactly as recorded except their running
  distance, which counts from the new start. FIT lap/session start time,
  end time, elapsed/timer time, lap count, distance and speed are updated
  to describe the kept part (never other summary values like heart rate).
  Cropping runs on the finished file, after its own safety check, and
  `verifyCroppedFit` / `verifyCroppedGpx` (in `src/lib/crop.ts`) check the
  result against that file.

- Tidying up automatically (David's request, "Fix GPS points" tab):
  `src/lib/stops.ts` finds stops and idle time at the start/end from GPS
  positions and times only (staying within a radius for a minimum time,
  both tunable). It only ever uses the existing straighten and crop, so it
  changes nothing those don't, and the same safety checks apply.

- Activity library (the "Activity library" tab, David's request): indexes a
  folder of exports (Nike Run Club JSON, TomTom, Google Fit/Takeout TCX and
  session JSON, FIT, GPX, zips inside the folder), shows sensors per file,
  compares with a Strava export zip (exact and partial matches), lets David
  fix the sport, mark files as added to Strava (kept in localStorage, with a
  save/load file backup), and exports the selected ones as FIT files with
  the sport set. Exported files copy every recorded value unchanged; only a
  missing distance is worked out from the GPS track.

## Decisions so far
- Files only for now: no Strava API (creating an API app needs a paid Strava
  subscription since June 2026). Users export the original file from Strava,
  fix it here, then delete and re-upload on strava.com themselves.
- Stack: Next.js + TypeScript, Leaflet for the map, Vitest for tests.
- Hosting: GitHub Pages (David wants everything in GitHub, not Vercel).
  The app is a static export (`output: "export"`); it must keep working with
  no server. Live at https://bluehair-co.github.io/strava-fixer/
- The repo is public and licensed CC0; never commit secrets.

## Checks to run before pushing
`npm run lint`, `npm test`, `npm run build`
