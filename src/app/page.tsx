export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Strava Fixer</h1>
      <p>
        Fix the GPS points in an activity where the signal was lost or
        inaccurate. Only the positions on the map change. Heart rate, cadence,
        power and every other recorded value stay exactly as they were.
      </p>
      <p>Coming soon: open a FIT or GPX file and edit its track on a map.</p>
    </main>
  );
}
