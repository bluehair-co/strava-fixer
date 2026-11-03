"use client";

import styles from "./Editor.module.css";

const STRAVA_UPLOAD = "https://www.strava.com/upload/select";

/** Shown after downloading: how to swap the activity on Strava. */
export default function NextSteps({ onClose, merged = false }: { onClose: () => void; merged?: boolean }) {
  return (
    <section className={styles.nextSteps} aria-label="Next steps on Strava">
      <strong>Next: swap the activity on Strava</strong>
      <ol>
        <li>
          <span>
            <b>1. Delete the original {merged ? "activities (both of them)" : "activity"} on Strava.</b> Copy
            anything you want to keep first (title, description, photos), because kudos and comments
            can&rsquo;t be moved.
          </span>
        </li>
        <li>
          <span>
            <b>2. Upload the {merged ? "new" : "fixed"} file.</b> Do this after deleting, or Strava
            will reject it as a duplicate.
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
