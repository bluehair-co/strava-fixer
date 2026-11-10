"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allItems, buildTree, loadActivity, readItems, type Folder, type Item } from "@/lib/library/catalog";
import { buildStravaFit, exportFileName } from "@/lib/library/export";
import { scanFolder, type FolderScan } from "@/lib/library/files";
import { FORMAT_LABELS, type Activity } from "@/lib/library/formats";
import { describe, findMatches, type Match } from "@/lib/library/match";
import { EMPTY_MARKS, loadMarks, mergeMarks, normaliseMarks, saveMarks, type Marks } from "@/lib/library/marks";
import { SPORTS, sportFromStrava, sportLabel } from "@/lib/library/sports";
import { openStravaExport, type StravaActivity } from "@/lib/library/strava";
import { writeZip } from "@/lib/zip";
import type { Channel } from "@/lib/sources";
import type { MapTrack } from "./TracksMap";
import styles from "./Library.module.css";

const TracksMap = dynamic(() => import("./TracksMap"), { ssr: false });

type Status = "new" | "partial" | "instrava" | "added" | "unknown";
type Filter = "all" | Status;

const STATUS_LABELS: Record<Status, string> = {
  new: "Not in Strava",
  partial: "Partial match",
  instrava: "In Strava",
  added: "Marked as added",
  unknown: "Not compared",
};

const CHANNEL_SHORT: Record<Channel, string> = { gps: "GPS", elevation: "Elev", heartRate: "HR", cadence: "Cad", power: "Pwr", temperature: "Temp" };
const CHANNEL_LONG: Record<Channel, string> = { gps: "GPS", elevation: "elevation", heartRate: "heart rate", cadence: "cadence", power: "power", temperature: "temperature" };
const DEVICE_SENSORS: Channel[] = ["heartRate", "cadence", "power", "temperature"];

const LOCAL_COLOR = "#fc4c02";
const OTHER_COLORS = ["#1a73e8", "#9334e6", "#188038", "#d01884", "#007b83"];

/** Strava's bulk uploader takes up to 25 files at a time. */
const BATCH = 25;

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const fmtKm = (m: number | null) => (m == null ? "–" : `${(m / 1000).toFixed(2)} km`);
function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "GPS only", "GPS + heart rate, cadence", "No GPS: heart rate", "Summary only". */
export function sensorSummary(channels: Channel[] | null): string {
  if (!channels || !channels.length) return "Summary only (no track or sensor data)";
  const sensors = DEVICE_SENSORS.filter((c) => channels.includes(c)).map((c) => CHANNEL_LONG[c]);
  if (channels.includes("gps")) return sensors.length ? `GPS + ${sensors.join(", ")}` : "GPS only";
  return sensors.length ? `No GPS, ${sensors.join(", ")}` : "No GPS or sensor data";
}

function download(name: string, data: Uint8Array, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface StravaState {
  name: string;
  activities: StravaActivity[];
  reading: { done: number; total: number } | null;
}

export default function Library({ onSendToFixer }: { onSendToFixer?: (fileName: string, data: Uint8Array) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [foundExports, setFoundExports] = useState<FolderScan["stravaExports"]>([]);
  const [strava, setStrava] = useState<StravaState | null>(null);
  const [stravaVersion, setStravaVersion] = useState(0);
  const [marks, setMarksState] = useState<Marks>(EMPTY_MARKS);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState<{ key: string; activity: Activity } | null>(null);
  const [hiddenOnMap, setHiddenOnMap] = useState<Set<string>>(new Set());
  const scanId = useRef(0);
  const stravaJob = useRef<{ cancelled: boolean } | null>(null);

  // Marks live in this browser; read them once the page is running.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only available in the browser
    setMarksState(loadMarks());
  }, []);
  /** Changes the marks and saves them in this browser. */
  const setMarks = useCallback((change: (m: Marks) => Marks) => {
    setMarksState((m) => {
      const next = change(m);
      if (!saveMarks(next)) setTimeout(() => setMessage({ kind: "error", text: "This browser won't let the page save your marks. Use “Save marks to a file” to keep them." }));
      return next;
    });
  }, []);

  const activities = useMemo(() => items.filter((i) => i.kind === "activity"), [items]);
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const sportOf = useCallback((i: Item) => marks.sports[i.key] ?? i.sport, [marks.sports]);

  /* ---------- Loading a folder ---------- */

  const loadFolder = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const id = ++scanId.current;
    const files = Array.from(list);
    const root = ((files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || "").split("/")[0] || "Files";
    setFolderName(root);
    setItems([]);
    setChecked(new Set());
    setSelected(null);
    setMessage(null);
    setScan({ done: 0, total: files.length });
    let found: FolderScan;
    try {
      found = await scanFolder(files);
    } catch (e) {
      setScan(null);
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      return;
    }
    setFoundExports(found.stravaExports);
    const queue = [...found.files];
    const total = queue.length;
    const out: Item[] = [];
    let done = 0;
    const worker = async () => {
      while (queue.length && scanId.current === id) {
        const f = queue.shift()!;
        out.push(...(await readItems(f)));
        done++;
        if (done % 25 === 0) {
          setScan({ done, total });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (scanId.current !== id) return;
    // Keys must be unique: the same file copied into two folders gets the path added.
    const seen = new Map<string, number>();
    for (const i of out) seen.set(i.key, (seen.get(i.key) ?? 0) + 1);
    for (const i of out) if ((seen.get(i.key) ?? 0) > 1 && i.kind === "activity") i.key = `${i.key}|${i.path}`;
    setItems(out);
    setScan(null);
    const tree = buildTree(out);
    // Open every folder when there are only a few, otherwise the first two levels.
    const folders: string[] = [];
    const walk = (f: Folder, depth: number) => f.folders.forEach((x) => (folders.push(x.path), walk(x, depth + 1)));
    walk(tree, 0);
    setOpen(new Set(folders.length <= 30 ? folders : [tree, ...tree.folders].flatMap((f) => f.folders.map((x) => x.path))));
    const n = out.filter((i) => i.kind === "activity").length;
    setMessage({ kind: "info", text: `Found ${n.toLocaleString()} ${n === 1 ? "activity" : "activities"} in ${total.toLocaleString()} files.` });
  };

  /* ---------- Loading the Strava export ---------- */

  const loadStrava = async (file: File | Blob, name: string) => {
    if (stravaJob.current) stravaJob.current.cancelled = true;
    const job = { cancelled: false };
    stravaJob.current = job;
    setMessage({ kind: "info", text: `Opening ${name}…` });
    try {
      const ex = await openStravaExport(file);
      setStrava({ name, activities: ex.activities, reading: { done: 0, total: ex.activities.length } });
      setStravaVersion((v) => v + 1);
      setMessage({ kind: "info", text: `${ex.activities.length.toLocaleString()} Strava activities found. Reading their files to compare tracks…` });
      await ex.readFiles((done, total) => {
        if (!job.cancelled) setStrava((s) => (s ? { ...s, reading: { done, total } } : s));
      }, job);
      if (job.cancelled) return;
      setStrava((s) => (s ? { ...s, reading: null } : s));
      setStravaVersion((v) => v + 1);
      setMessage({ kind: "info", text: `Compared with ${ex.activities.length.toLocaleString()} Strava activities.` });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  /* ---------- Matching ---------- */

  const stravaMatches = useMemo(() => {
    void stravaVersion; // re-match once the Strava files have been read
    return strava ? findMatches(activities, strava.activities) : new Map<Item, { other: StravaActivity; match: Match }[]>();
  }, [activities, strava, stravaVersion]);

  const folderMatches = useMemo(() => findMatches(activities, activities, (a, b) => a === b), [activities]);

  const statusOf = useCallback(
    (i: Item): Status => {
      if (marks.added[i.key]) return "added";
      if (!strava) return "unknown";
      const m = stravaMatches.get(i);
      if (!m) return "new";
      return m[0].match.kind === "exact" ? "instrava" : "partial";
    },
    [marks.added, strava, stravaMatches],
  );

  const counts = useMemo(() => {
    const c: Record<Status, number> = { new: 0, partial: 0, instrava: 0, added: 0, unknown: 0 };
    for (const i of activities) c[statusOf(i)]++;
    return c;
  }, [activities, statusOf]);

  /* ---------- Filtering and the tree ---------- */

  const filtering = filter !== "all" || search.trim() !== "";
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (i.kind !== "activity") return showOther && !filtering;
      if (filter !== "all" && statusOf(i) !== filter) return false;
      if (q && !`${i.path} ${i.title ?? ""} ${sportLabel(sportOf(i))} ${fmtDate(i.start)}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filter, search, showOther, filtering, statusOf, sportOf]);
  const tree = useMemo(() => buildTree(visible), [visible]);
  const otherCount = items.length - activities.length;

  const sel = selected ? (byKey.get(selected) ?? null) : null;

  // Read the selected activity's full track for the map.
  useEffect(() => {
    if (!sel || sel.kind !== "activity") return;
    let alive = true;
    loadActivity(sel)
      .then((activity) => alive && setFull({ key: sel.key, activity }))
      .catch(() => alive && setFull(null));
    return () => {
      alive = false;
    };
  }, [sel]);

  /* ---------- Changing marks ---------- */

  const setSport = (keys: string[], sport: string | null) =>
    setMarks((m) => {
      const sports = { ...m.sports };
      for (const k of keys) {
        const item = byKey.get(k);
        if (sport === null || sport === item?.sport) delete sports[k];
        else sports[k] = sport;
      }
      return { ...m, sports };
    });

  const setAdded = (keys: string[], added: boolean) =>
    setMarks((m) => {
      const next = { ...m.added };
      const now = new Date().toISOString();
      for (const k of keys) {
        if (added) next[k] = next[k] ?? now;
        else delete next[k];
      }
      return { ...m, added: next };
    });

  const saveMarksFile = () => download("activity-library-marks.json", new TextEncoder().encode(JSON.stringify(marks, null, 2)), "application/json");
  const loadMarksFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const incoming = normaliseMarks(JSON.parse(await file.text()));
      setMarks((m) => mergeMarks(m, incoming));
      setMessage({ kind: "info", text: `Loaded marks: ${Object.keys(incoming.added).length} marked as added, ${Object.keys(incoming.sports).length} sports.` });
    } catch {
      setMessage({ kind: "error", text: "That file isn't a marks file saved by this page." });
    }
  };

  /* ---------- Exporting ---------- */

  const exportItems = async (list: Item[]) => {
    const missing = list.filter((i) => !sportOf(i));
    if (missing.length) {
      setMessage({
        kind: "error",
        text: `${missing.length === 1 ? "1 activity has" : `${missing.length} activities have`} no sport yet (${missing
          .slice(0, 3)
          .map((i) => i.file.name)
          .join(", ")}${missing.length > 3 ? ", …" : ""}). Choose one with “Set sport” first, so Strava gets it right.`,
      });
      return;
    }
    setBusy(true);
    try {
      const used = new Set<string>();
      const files: { name: string; data: Uint8Array }[] = [];
      for (const i of list) {
        const a = await loadActivity(i);
        files.push({ name: exportFileName(a, sportOf(i), used), data: buildStravaFit(a, sportOf(i)) });
      }
      if (files.length === 1) download(files[0].name, files[0].data);
      else {
        const batches = Math.ceil(files.length / BATCH);
        const named = files.map((f, n) => ({
          name: batches > 1 ? `upload-${String(Math.floor(n / BATCH) + 1).padStart(2, "0")}/${f.name}` : f.name,
          data: f.data,
        }));
        download("activities-for-strava.zip", writeZip(named), "application/zip");
      }
      const now = new Date().toISOString();
      setMarks((m) => ({ ...m, exported: { ...m.exported, ...Object.fromEntries(list.map((i) => [i.key, now])) } }));
      setMessage({
        kind: "info",
        text:
          files.length === 1
            ? `Downloaded ${files[0].name}. Upload it at strava.com/upload/select, then tick “Added to Strava” here.`
            : `Downloaded ${files.length} files in activities-for-strava.zip${files.length > BATCH ? `, in folders of ${BATCH} (Strava takes ${BATCH} files per upload)` : ""}. Unzip it, upload them at strava.com/upload/select, then mark them as added here.`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const sendToFixer = async (i: Item) => {
    if (!onSendToFixer) return;
    const a = await loadActivity(i);
    const used = new Set<string>();
    onSendToFixer(exportFileName(a, sportOf(i), used), buildStravaFit(a, sportOf(i)));
  };

  /* ---------- Selection ---------- */

  const toggle = (keys: string[], on: boolean) =>
    setChecked((c) => {
      const next = new Set(c);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const checkedItems = useMemo(() => [...checked].map((k) => byKey.get(k)).filter((i): i is Item => !!i && i.kind === "activity"), [checked, byKey]);

  /* ---------- Map ---------- */

  const selMatches = useMemo(() => (sel ? (stravaMatches.get(sel) ?? []) : []), [sel, stravaMatches]);
  const selDupes = useMemo(() => (sel ? (folderMatches.get(sel) ?? []) : []), [sel, folderMatches]);
  const tracks = useMemo<MapTrack[]>(() => {
    if (!sel) return [];
    const t: MapTrack[] = [];
    selMatches.forEach(({ other }, n) => {
      if (other.preview && !hiddenOnMap.has(`s:${other.id}`))
        t.push({ parts: [other.preview.points.map(([lat, lon]) => [lat, lon])], color: OTHER_COLORS[n % OTHER_COLORS.length], weight: 6, opacity: 0.55, label: `Strava: ${other.name}` });
    });
    selDupes.forEach(({ other }, n) => {
      if (other.preview && !hiddenOnMap.has(`f:${other.key}`))
        t.push({ parts: [other.preview.points.map(([lat, lon]) => [lat, lon])], color: OTHER_COLORS[(n + selMatches.length) % OTHER_COLORS.length], weight: 6, opacity: 0.55, label: other.path });
    });
    const pts =
      full?.key === sel.key
        ? full.activity.samples.filter((s) => s.lat !== undefined && s.lon !== undefined).map((s) => [s.lat!, s.lon!] as [number, number])
        : (sel.preview?.points.map(([lat, lon]) => [lat, lon] as [number, number]) ?? []);
    if (pts.length) t.push({ parts: [pts], color: LOCAL_COLOR, weight: 3, label: sel.file.name });
    return t;
  }, [sel, selMatches, selDupes, full, hiddenOnMap]);

  /* ---------- Rendering ---------- */

  const renderItem = (i: Item) => {
    const name = i.count > 1 ? `${i.file.name} (#${i.index + 1})` : i.file.name;
    if (i.kind !== "activity")
      return (
        <li key={i.key} className={styles.otherRow} title={i.message}>
          <span className={styles.rowName}>{name}</span>
          <span className={styles.muted}>{i.kind === "error" ? `Couldn't read: ${i.message}` : i.message}</span>
        </li>
      );
    const status = statusOf(i);
    const sport = sportOf(i);
    return (
      <li key={i.key} className={`${styles.row} ${selected === i.key ? styles.rowSelected : ""}`} onClick={() => setSelected(i.key)}>
        <input type="checkbox" checked={checked.has(i.key)} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle([i.key], e.target.checked)} aria-label={`Select ${name}`} />
        <span className={styles.rowMain}>
          <span className={styles.rowName}>{name}</span>
          <span className={styles.rowInfo}>
            {fmtDate(i.start)} {fmtTime(i.start)} · {fmtDuration(i.end - i.start)} · {fmtKm(i.distance)} ·{" "}
            <span className={sport ? undefined : styles.missing}>{sport ? sportLabel(sport) : "Sport?"}</span>
          </span>
        </span>
        <span className={styles.badges} title={sensorSummary(i.channels)}>
          {i.channels && i.channels.length ? (
            i.channels
              .filter((c) => c !== "elevation")
              .map((c) => (
                <span key={c} className={`${styles.badge} ${c === "gps" ? styles.badgeGps : styles.badgeSensor}`}>
                  {CHANNEL_SHORT[c]}
                </span>
              ))
          ) : (
            <span className={styles.badge}>Summary</span>
          )}
        </span>
        <span className={`${styles.status} ${styles[`status_${status}`]}`}>{STATUS_LABELS[status]}</span>
      </li>
    );
  };

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const isOpen = filtering || open.has(f.path);
    const acts = allItems(f).filter((i) => i.kind === "activity");
    const allChecked = acts.length > 0 && acts.every((i) => checked.has(i.key));
    return (
      <li key={f.path} className={styles.folder}>
        <div className={styles.folderRow}>
          <input type="checkbox" checked={allChecked} disabled={!acts.length} onChange={(e) => toggle(acts.map((i) => i.key), e.target.checked)} aria-label={`Select everything in ${f.name}`} />
          <button
            className={styles.folderButton}
            onClick={() =>
              setOpen((o) => {
                const next = new Set(o);
                if (next.has(f.path)) next.delete(f.path);
                else next.add(f.path);
                return next;
              })
            }
            aria-expanded={isOpen}
          >
            <span className={styles.caret}>{isOpen ? "▾" : "▸"}</span> {f.name}
            <span className={styles.muted}> ({acts.length.toLocaleString()})</span>
          </button>
        </div>
        {isOpen && renderList(f, depth + 1)}
      </li>
    );
  };

  const renderList = (f: Folder, depth: number) => (
    <ul className={styles.list}>
      {f.folders.map((sub) => renderFolder(sub, depth))}
      {f.items.map(renderItem)}
    </ul>
  );

  return (
    <div className={styles.library}>
      <div className={styles.pickers}>
        <label className={styles.picker}>
          <strong>{folderName ? `Folder: ${folderName}` : "1. Choose the folder with your exports"}</strong>
          <span className={styles.muted}>Nike Run Club, TomTom, Google Fit, Google Takeout… (FIT, GPX, TCX, JSON; zips inside are opened too)</span>
          <input
            type="file"
            hidden
            // @ts-expect-error webkitdirectory isn't in React's types, but every current browser supports it.
            webkitdirectory=""
            multiple
            onChange={(e) => loadFolder(e.target.files)}
          />
        </label>
        <label className={styles.picker}>
          <strong>{strava ? `Strava export: ${strava.name}` : "2. Choose your Strava export (.zip)"}</strong>
          <span className={styles.muted}>strava.com → Settings → My Account → Download or Delete Your Account → Request your archive</span>
          <input type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && loadStrava(e.target.files[0], e.target.files[0].name)} />
        </label>
      </div>

      {foundExports.length > 0 && !strava && (
        <p className={styles.notice}>
          Your folder has a Strava export in it ({foundExports.map((x) => x.path).join(", ")}).{" "}
          <button className={styles.inlineButton} onClick={() => loadStrava(foundExports[0].file, foundExports[0].path)}>
            Compare with it
          </button>
        </p>
      )}
      {scan && (
        <p className={styles.progress}>
          Reading files… {scan.done.toLocaleString()} of {scan.total.toLocaleString()}
          <progress value={scan.done} max={scan.total} />
        </p>
      )}
      {strava?.reading && (
        <p className={styles.progress}>
          Reading Strava activity files to compare tracks… {strava.reading.done.toLocaleString()} of {strava.reading.total.toLocaleString()}
          <progress value={strava.reading.done} max={strava.reading.total} />
        </p>
      )}
      {message && <p className={styles[message.kind]}>{message.text}</p>}

      {!items.length && !scan && (
        <p className={styles.muted}>
          Everything happens in your browser: your files are never uploaded. The page lists every activity it finds, shows what
          each recorded (GPS only, or heart rate and other sensors too), checks which ones are already on Strava, and exports the
          ones you pick as files Strava reads with the right sport.
        </p>
      )}

      {activities.length > 0 && (
        <>
          <div className={styles.filters}>
            {(["all", "new", "partial", "instrava", "added", ...(strava ? [] : ["unknown"])] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? styles.filterOn : undefined} onClick={() => setFilter(f)}>
                {f === "all" ? `All (${activities.length.toLocaleString()})` : `${STATUS_LABELS[f]} (${counts[f].toLocaleString()})`}
              </button>
            ))}
            <input className={styles.search} type="search" placeholder="Search name, date, sport…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {otherCount > 0 && (
              <label className={styles.muted}>
                <input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> Show other files ({otherCount.toLocaleString()})
              </label>
            )}
          </div>

          <div className={styles.workspace}>
            <div className={styles.treePane}>
              <div className={styles.treeTools}>
                <button onClick={() => toggle(visible.filter((i) => i.kind === "activity").map((i) => i.key), true)}>Select all shown</button>
                <button onClick={() => setChecked(new Set())} disabled={!checked.size}>
                  Clear selection
                </button>
              </div>
              <div className={styles.tree}>{visible.length ? renderList(tree, 0) : <p className={styles.muted}>Nothing matches.</p>}</div>
              {checkedItems.length > 0 && (
                <div className={styles.selectionBar}>
                  <strong>{checkedItems.length.toLocaleString()} selected</strong>
                  <select value="" onChange={(e) => e.target.value && setSport(checkedItems.map((i) => i.key), e.target.value)} aria-label="Set sport for the selected activities">
                    <option value="">Set sport…</option>
                    {SPORTS.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => setAdded(checkedItems.map((i) => i.key), true)}>Mark as added to Strava</button>
                  <button onClick={() => setAdded(checkedItems.map((i) => i.key), false)}>Unmark</button>
                  <button className={styles.primary} disabled={busy} onClick={() => exportItems(checkedItems)}>
                    {busy ? "Exporting…" : "Export for Strava"}
                  </button>
                </div>
              )}
            </div>

            <div className={styles.detailPane}>
              <div className={styles.map}>
                <TracksMap tracks={tracks} fitKey={sel?.key ?? ""} />
              </div>
              {sel && sel.kind === "activity" ? (
                <Details
                  item={sel}
                  activity={full?.key === sel.key ? full.activity : null}
                  sport={sportOf(sel)}
                  marks={marks}
                  matches={selMatches}
                  dupes={selDupes}
                  stravaLoaded={!!strava}
                  hiddenOnMap={hiddenOnMap}
                  colors={OTHER_COLORS}
                  onToggleMap={(k) =>
                    setHiddenOnMap((h) => {
                      const next = new Set(h);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })
                  }
                  onSport={(s) => setSport([sel.key], s)}
                  onAdded={(on) => setAdded([sel.key], on)}
                  onSelect={setSelected}
                  onExport={() => exportItems([sel])}
                  onSendToFixer={onSendToFixer ? () => sendToFixer(sel) : undefined}
                  busy={busy}
                />
              ) : (
                <p className={styles.muted}>Click an activity to see it on the map.</p>
              )}
            </div>
          </div>
        </>
      )}

      <details className={styles.marksBox}>
        <summary>Your marks ({Object.keys(marks.added).length} added to Strava, {Object.keys(marks.sports).length} sports changed)</summary>
        <p className={styles.muted}>
          Sports you change and activities you mark as added are remembered in this browser. Save them to a file as a backup, or
          to carry on in another browser.
        </p>
        <div className={styles.treeTools}>
          <button onClick={saveMarksFile}>Save marks to a file</button>
          <label className={styles.fileButton}>
            Load marks from a file
            <input type="file" accept=".json,application/json" hidden onChange={(e) => loadMarksFile(e.target.files?.[0])} />
          </label>
        </div>
      </details>
    </div>
  );
}

/* ---------- The panel under the map ---------- */

interface DetailsProps {
  item: Item;
  activity: Activity | null;
  sport: string | null;
  marks: Marks;
  matches: { other: StravaActivity; match: Match }[];
  dupes: { other: Item; match: Match }[];
  stravaLoaded: boolean;
  hiddenOnMap: Set<string>;
  colors: string[];
  onToggleMap: (key: string) => void;
  onSport: (sport: string | null) => void;
  onAdded: (on: boolean) => void;
  onSelect: (key: string) => void;
  onExport: () => void;
  onSendToFixer?: () => void;
  busy: boolean;
}

function Details({ item, activity, sport, marks, matches, dupes, stravaLoaded, hiddenOnMap, colors, onToggleMap, onSport, onAdded, onSelect, onExport, onSendToFixer, busy }: DetailsProps) {
  const counts = activity
    ? (["gps", "heartRate", "cadence", "power", "temperature", "elevation"] as Channel[])
        .map((c) => [c, activity.samples.filter((s) => (c === "gps" ? s.lat !== undefined : s[c] !== undefined)).length] as const)
        .filter(([, n]) => n > 0)
    : [];
  const added = marks.added[item.key];
  const exported = marks.exported[item.key];
  return (
    <div className={styles.details}>
      <h3 className={styles.detailTitle}>{item.title || item.file.name}</h3>
      <p className={styles.muted}>{item.path}</p>
      <p>
        {fmtDate(item.start)}, {fmtTime(item.start)}–{fmtTime(item.end)} · {fmtDuration(item.end - item.start)} · {fmtKm(item.distance)}
      </p>
      <p className={styles.muted}>
        {item.format ? FORMAT_LABELS[item.format] : ""}
        {item.device ? ` · made by ${item.device}` : ""}
      </p>
      <p>
        <strong>Data: {sensorSummary(item.channels)}</strong>
        {counts.length > 0 && (
          <span className={styles.muted}> ({counts.map(([c, n]) => `${n.toLocaleString()} ${CHANNEL_LONG[c]}`).join(", ")} samples)</span>
        )}
      </p>

      <div className={styles.controls}>
        <label>
          Sport{" "}
          <select value={sport ?? ""} onChange={(e) => onSport(e.target.value || null)}>
            <option value="">Unknown</option>
            {SPORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {item.rawSport && <span className={styles.muted}>The file says “{item.rawSport}”.</span>}
        <label>
          <input type="checkbox" checked={!!added} onChange={(e) => onAdded(e.target.checked)} /> Added to Strava
          {added && <span className={styles.muted}> (marked {fmtDate(Date.parse(added))})</span>}
        </label>
        {exported && <span className={styles.muted}>Exported {fmtDate(Date.parse(exported))}.</span>}
      </div>

      <div className={styles.treeTools}>
        <button className={styles.primary} onClick={onExport} disabled={busy}>
          Download for Strava (.fit)
        </button>
        {onSendToFixer && item.channels?.includes("gps") && <button onClick={onSendToFixer}>Fix its GPS points first</button>}
      </div>
      {!item.channels?.length && <p className={styles.muted}>This one is a summary only: Strava will show its time, duration and distance, without a map.</p>}

      <h4>On Strava</h4>
      {!stravaLoaded ? (
        <p className={styles.muted}>Choose your Strava export to compare.</p>
      ) : matches.length === 0 ? (
        <p>No Strava activity at this time.</p>
      ) : (
        <ul className={styles.matchList}>
          {matches.map(({ other, match }, n) => (
            <li key={other.id}>
              <div className={styles.matchHead}>
                <input type="checkbox" checked={!hiddenOnMap.has(`s:${other.id}`)} onChange={() => onToggleMap(`s:${other.id}`)} title="Show on the map" disabled={!other.preview} />
                <span className={styles.swatch} style={{ background: other.preview ? colors[n % colors.length] : "transparent" }} />
                <span className={`${styles.status} ${match.kind === "exact" ? styles.status_instrava : styles.status_partial}`}>{match.kind === "exact" ? "Same activity" : "Partial match"}</span>
                <a href={`https://www.strava.com/activities/${other.id}`} target="_blank" rel="noreferrer">
                  {other.name || "(no name)"}
                </a>
                <span className={styles.muted}>
                  {other.type} · {fmtTime(other.start)} · {fmtKm(other.distance)}
                  {!other.file ? " · manual entry" : ""}
                </span>
                {sportFromStrava(other.type) && sportFromStrava(other.type) !== sport && (
                  <button className={styles.inlineButton} onClick={() => onSport(sportFromStrava(other.type))}>
                    Use “{other.type}”
                  </button>
                )}
              </div>
              <ul className={styles.reasons}>
                {describe(match, "the Strava activity").map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {dupes.length > 0 && (
        <>
          <h4>Also in your folder</h4>
          <ul className={styles.matchList}>
            {dupes.map(({ other, match }, n) => (
              <li key={other.key}>
                <div className={styles.matchHead}>
                  <input type="checkbox" checked={!hiddenOnMap.has(`f:${other.key}`)} onChange={() => onToggleMap(`f:${other.key}`)} title="Show on the map" disabled={!other.preview} />
                  <span className={styles.swatch} style={{ background: other.preview ? colors[(n + matches.length) % colors.length] : "transparent" }} />
                  <span className={`${styles.status} ${match.kind === "exact" ? styles.status_instrava : styles.status_partial}`}>{match.kind === "exact" ? "Same activity" : "Partial match"}</span>
                  <button className={styles.inlineButton} onClick={() => onSelect(other.key)}>
                    {other.path}
                  </button>
                </div>
                <ul className={styles.reasons}>
                  {describe(match, "the other file").map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
