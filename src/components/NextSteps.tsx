"use client";

import { useState } from "react";
import { activityIdFromLink } from "@/lib/strava";
import styles from "./Editor.module.css";

const STRAVA_UPLOAD = "https://www.strava.com/upload/select";
const STRAVA_MY_ACTIVITIES = "https://www.strava.com/athlete/training";

/** Shown after downloading: shortcuts for swapping the activity on Strava. */
export default function NextSteps({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState("");
  const id = activityIdFromLink(link);
  const originalUrl = id ? `https://www.strava.com/activities/${id}` : STRAVA_MY_ACTIVITIES;

  return (
    <section className={styles.nextSteps} aria-label="Next steps on Strava">
      <strong>Next: swap the activity on Strava</strong>
      <ol>
        <li>
          <span>
            <b>1. Delete the original activity.</b> Copy anything you want to keep first (title,
            description, photos), because kudos and comments can&rsquo;t be moved.
          </span>
          <label className={styles.linkInput}>
            Strava link to the activity (optional):
            <input
              type="url"
              placeholder="https://www.strava.com/activities/…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          <a className={styles.linkButton} href={originalUrl} target="_blank" rel="noopener noreferrer">
            {id ? "Open the original activity" : "Open my activities on Strava"}
          </a>
        </li>
        <li>
          <span>
            <b>2. Upload the fixed file.</b> Do this after deleting, or Strava will reject it as a
            duplicate.
          </span>
          <a className={styles.linkButton} href={STRAVA_UPLOAD} target="_blank" rel="noopener noreferrer">
            Open Strava upload page
          </a>
        </li>
      </ol>
      <button className={styles.closeButton} onClick={onClose} aria-label="Close next steps">
        Close
      </button>
    </section>
  );
}
