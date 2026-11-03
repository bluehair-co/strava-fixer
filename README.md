# Strava Fixer

Fix the GPS points in an activity where the signal was lost or inaccurate,
using a map. Only latitude and longitude ever change: heart rate, cadence,
power, temperature, elevation, laps and every other recorded value are kept
exactly as they were.

## How it will work

1. On strava.com, open your activity, click the "..." menu and choose
   **Export Original** to download the original FIT or GPX file.
2. Open that file in Strava Fixer, then drag, straighten or remove the bad
   points on the map.
3. Download the fixed file, delete the old activity on Strava, and upload
   the fixed one.

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

`npm run lint` looks for common mistakes and `npm run build` makes sure the
app compiles. GitHub runs both on every pull request (see the "Checks" tab).

## License

[CC0 1.0](LICENSE): public domain.
