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
    <>
      <header className="site-header">
        <strong>NBA Draft Room</strong>
        <span>Standalone fantasy basketball</span>
      </header>
      <main className="setup-page">
        <h1>Create your draft</h1>
        <p>
          Set your league rules, share the room, and draft together. Export the
          results for manual ESPN entry.
        </p>
        <form className="panel setup-form" onSubmit={create}>
          <div className="settings-grid">
            <label>
              Room name
              <input
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your league draft"
              />
            </label>
            <label>
              Commissioner name
              <input
                required
                maxLength={60}
                value={commissioner}
                onChange={(event) => setCommissioner(event.target.value)}
                placeholder="Your name"
              />
            </label>
          </div>
          <SettingsEditor settings={settings} onChange={setSettings} />
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Loading ESPN player pool…" : "Create draft room"}
          </button>
          <p className="hint">
            Fresh-player draft only. No keepers, trades, ESPN login, roster
            import, or ESPN changes. All picks save to Postgres.
          </p>
        </form>
        <p className="hint">
          Independent app. Not affiliated with ESPN. Projection source: ESPN’s
          unofficial read-only endpoint.
        </p>
      </main>
    </>
  );
}
