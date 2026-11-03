import { expect, it } from "vitest";
import { activityIdFromLink } from "./strava";

it("finds the activity id in a Strava link", () => {
  expect(activityIdFromLink("https://www.strava.com/activities/12345678901")).toBe("12345678901");
  expect(activityIdFromLink("strava.com/activities/987654?share=1")).toBe("987654");
  expect(activityIdFromLink(" 12345678 ")).toBe("12345678");
  expect(activityIdFromLink("https://www.strava.com/athletes/42")).toBeNull();
  expect(activityIdFromLink("")).toBeNull();
});
