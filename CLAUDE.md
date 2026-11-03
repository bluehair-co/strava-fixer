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
