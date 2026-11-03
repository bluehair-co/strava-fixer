"use client";

import { useState } from "react";
import Editor from "./Editor";
import Merge from "./Merge";
import styles from "./Editor.module.css";

type Tab = "fix" | "merge";

/** The two tools of the app, as tabs. */
export default function App() {
  const [tab, setTab] = useState<Tab>("fix");
  return (
    <>
      <nav className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={tab === "fix"} onClick={() => setTab("fix")}>
          Fix GPS points
        </button>
        <button role="tab" aria-selected={tab === "merge"} onClick={() => setTab("merge")}>
          Merge watch + phone
        </button>
      </nav>
      {tab === "fix" ? <Editor /> : <Merge />}
    </>
  );
}
