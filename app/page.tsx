"use client";
import { useState } from "react";
import { defaultSettings, settingsSchema } from "@/lib/model";
import { SettingsEditor } from "./components/settings";

export default function Home() {
  const [settings, setSettings] = useState(defaultSettings);
  const [name, setName] = useState(""),
    [commissioner, setCommissioner] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    const valid = settingsSchema.safeParse(settings);
    if (!valid.success) {
      setError(valid.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, commissioner, settings }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      sessionStorage.setItem(`recovery_${result.id}`, result.recoveryCode);
      location.assign(`/room/${result.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Room could not be created. Try again.",
      );
      setBusy(false);
    }
  }
  return (
    <form className="shell create" onSubmit={create}>
      <header className="topbar">
        <div className="title">
          <h1>NBA Draft Room</h1>
          <small>Live draft · ESPN projections · CSV export</small>
        </div>
      </header>
      <main className="panel">
        <div className="scroll">
          <div className="grid">
            <label>
              Room name
              <input
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="League draft"
              />
            </label>
            <label>
              Your name
              <input
                required
                maxLength={60}
                value={commissioner}
                onChange={(event) => setCommissioner(event.target.value)}
                placeholder="Commissioner"
              />
            </label>
          </div>
          <SettingsEditor settings={settings} onChange={setSettings} />
          <p className="hint">
            Not affiliated with ESPN. No ESPN login, roster import, or ESPN
            changes. Rooms expire after 7 days without manager activity.
          </p>
        </div>
      </main>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      <footer className="actionbar">
        <button className="primary draft-button" disabled={busy}>
          {busy ? "Loading ESPN players…" : "Create room"}
        </button>
      </footer>
    </form>
  );
}
