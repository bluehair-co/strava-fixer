"use client";

import { useState } from "react";
import Editor, { type IncomingFile } from "./Editor";
import Merge from "./Merge";
import styles from "./Editor.module.css";

type Tab = "fix" | "merge";

/** The two tools of the app, as tabs. */
export default function App() {
  const [tab, setTab] = useState<Tab>("fix");
  // A combined file sent from "Combine recordings" to "Fix GPS points".
  const [incoming, setIncoming] = useState<IncomingFile | null>(null);

  const sendToFixer = (fileName: string, data: Uint8Array) => {
    setIncoming({ fileName, data, id: Date.now() });
    setTab("fix");
  };

  // Both tabs stay in the page (only one is shown), so switching back and
  // forth keeps the files and choices in each.
  return (
    <>
      <nav className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={tab === "fix"} onClick={() => setTab("fix")}>
          Fix GPS points
        </button>
        <button role="tab" aria-selected={tab === "merge"} onClick={() => setTab("merge")}>
          Combine recordings
        </button>
      </nav>
      <div hidden={tab !== "fix"}>
        <Editor incoming={incoming} />
      </div>
      <div hidden={tab !== "merge"}>
        <Merge onSendToFixer={sendToFixer} />
      </div>
    </>
  );
}
