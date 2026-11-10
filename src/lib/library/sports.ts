/**
 * Strava's sport types, and how each is written in a FIT file so that Strava
 * picks the right one when the file is uploaded.
 */

export interface SportType {
  /** Our key for it. */
  key: string;
  /** Strava's name, as shown on strava.com and in its export's activities.csv. */
  label: string;
  /** FIT `sport` and `sub_sport` values (names from the FIT profile). */
  fit: { sport: string; subSport?: string };
}

export const SPORTS: SportType[] = [
  { key: "run", label: "Run", fit: { sport: "running" } },
  { key: "trailrun", label: "Trail Run", fit: { sport: "running", subSport: "trail" } },
  { key: "treadmill", label: "Run (treadmill)", fit: { sport: "running", subSport: "treadmill" } },
  { key: "virtualrun", label: "Virtual Run", fit: { sport: "running", subSport: "virtualActivity" } },
  { key: "walk", label: "Walk", fit: { sport: "walking" } },
  { key: "hike", label: "Hike", fit: { sport: "hiking" } },
  { key: "ride", label: "Ride", fit: { sport: "cycling" } },
  { key: "mtb", label: "Mountain Bike Ride", fit: { sport: "cycling", subSport: "mountain" } },
  { key: "gravel", label: "Gravel Ride", fit: { sport: "cycling", subSport: "gravelCycling" } },
  { key: "ebike", label: "E-Bike Ride", fit: { sport: "eBiking" } },
  { key: "virtualride", label: "Virtual Ride", fit: { sport: "cycling", subSport: "virtualActivity" } },
  { key: "swim", label: "Swim", fit: { sport: "swimming" } },
  { key: "rowing", label: "Rowing", fit: { sport: "rowing" } },
  { key: "kayaking", label: "Kayaking", fit: { sport: "kayaking" } },
  { key: "canoeing", label: "Canoeing", fit: { sport: "canoeing" } },
  { key: "sup", label: "Stand Up Paddling", fit: { sport: "standUpPaddleboarding" } },
  { key: "surfing", label: "Surfing", fit: { sport: "surfing" } },
  { key: "alpineski", label: "Alpine Ski", fit: { sport: "alpineSkiing" } },
  { key: "backcountryski", label: "Backcountry Ski", fit: { sport: "alpineSkiing", subSport: "backcountry" } },
  { key: "nordicski", label: "Nordic Ski", fit: { sport: "crossCountrySkiing" } },
  { key: "snowboard", label: "Snowboard", fit: { sport: "snowboarding" } },
  { key: "snowshoe", label: "Snowshoe", fit: { sport: "snowshoeing" } },
  { key: "iceskate", label: "Ice Skate", fit: { sport: "iceSkating" } },
  { key: "inlineskate", label: "Inline Skate", fit: { sport: "inlineSkating" } },
  { key: "rockclimb", label: "Rock Climb", fit: { sport: "rockClimbing" } },
  { key: "elliptical", label: "Elliptical", fit: { sport: "fitnessEquipment", subSport: "elliptical" } },
  { key: "stairstepper", label: "Stair-Stepper", fit: { sport: "fitnessEquipment", subSport: "stairClimbing" } },
  { key: "weights", label: "Weight Training", fit: { sport: "training", subSport: "strengthTraining" } },
  { key: "yoga", label: "Yoga", fit: { sport: "training", subSport: "yoga" } },
  { key: "hiit", label: "HIIT", fit: { sport: "hiit" } },
  { key: "soccer", label: "Football (Soccer)", fit: { sport: "soccer" } },
  { key: "tennis", label: "Tennis", fit: { sport: "tennis" } },
  { key: "golf", label: "Golf", fit: { sport: "golf" } },
  { key: "workout", label: "Workout", fit: { sport: "generic" } },
];

const BY_KEY = new Map(SPORTS.map((s) => [s.key, s]));

export function sportByKey(key: string | null | undefined): SportType | null {
  return (key && BY_KEY.get(key)) || null;
}

export function sportLabel(key: string | null | undefined): string {
  return sportByKey(key)?.label ?? "Unknown";
}

/**
 * Turns the many ways apps name a sport ("Running", "biking.mountain",
 * "run", FIT "cycling"/"gravelCycling", Strava "Trail Run", ...) into one of
 * our keys, or null when it doesn't say (e.g. "Other", "generic").
 */
export function guessSport(raw: string | null | undefined, sub?: string | null): string | null {
  if (!raw) return null;
  const s = `${raw} ${sub ?? ""}`.toLowerCase().replace(/[_\s.-]+/g, " ");
  const rules: [RegExp, string][] = [
    [/virtual ?(activity)? ?ride|virtual activity.*cycl|cycl.*virtual/, "virtualride"],
    [/virtual ?run|run.*virtual/, "virtualrun"],
    [/e ?bik|ebik/, "ebike"],
    [/mountain(?!eer)|mtb/, "mtb"],
    [/gravel/, "gravel"],
    [/trail ?run|running trail|run.*trail/, "trailrun"],
    [/treadmill|indoor ?run/, "treadmill"],
    [/bik|cycl|ride|bicycl|spinning/, "ride"],
    [/run|jog/, "run"],
    [/soccer|football/, "soccer"],
    [/hik/, "hike"],
    [/walk|foot/, "walk"],
    [/swim/, "swim"],
    [/row/, "rowing"],
    [/kayak/, "kayaking"],
    [/canoe/, "canoeing"],
    [/stand ?up|paddleboard|sup\b/, "sup"],
    [/surf/, "surfing"],
    [/backcountry/, "backcountryski"],
    [/cross ?country ?ski|nordic|skating ski|skate ski/, "nordicski"],
    [/alpine|downhill|skiing|\bski\b/, "alpineski"],
    [/snowboard/, "snowboard"],
    [/snowshoe/, "snowshoe"],
    [/ice ?skat/, "iceskate"],
    [/inline|roller ?skat/, "inlineskate"],
    [/climb|boulder/, "rockclimb"],
    [/elliptical/, "elliptical"],
    [/stair/, "stairstepper"],
    [/strength|weight/, "weights"],
    [/yoga/, "yoga"],
    [/hiit|interval training/, "hiit"],
    [/tennis/, "tennis"],
    [/golf/, "golf"],
    [/workout|training|aerobic|calisthenics|crossfit/, "workout"],
  ];
  for (const [re, key] of rules) if (re.test(s)) return key;
  return null;
}

/** Strava's own sport names (activities.csv "Activity Type") to our keys. */
export function sportFromStrava(type: string | null | undefined): string | null {
  if (!type) return null;
  const exact = SPORTS.find((s) => s.label.toLowerCase() === type.trim().toLowerCase());
  return exact?.key ?? guessSport(type);
}
