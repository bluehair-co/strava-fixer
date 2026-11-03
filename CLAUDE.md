# Working rules for Claude in this repo

These are David's standing preferences. Follow them in every session.

## Pull requests
- Merge your own pull requests yourself (squash merge) once GitHub's "Check"
  passes. Tell David with a link when you have.
- David is new to coding: explain changes in plain language, and walk through
  any step he has to do himself.

## The app's core rule
- Only GPS positions (latitude/longitude) may ever change in an activity file.
  Heart rate, cadence, power, temperature, elevation, timestamps, laps and
  every other recorded field must stay exactly as recorded. The download
  safety check (`verifyFit` / `verifyGpx`) enforces this; never weaken it.

## Decisions so far
- Files only for now: no Strava API (creating an API app needs a paid Strava
  subscription since June 2026). Users export the original file from Strava,
  fix it here, then delete and re-upload on strava.com themselves.
- Stack: Next.js + TypeScript, Leaflet for the map, Vitest for tests.
- The repo is public and licensed CC0; never commit secrets.

## Checks to run before pushing
`npm run lint`, `npm test`, `npm run build`
