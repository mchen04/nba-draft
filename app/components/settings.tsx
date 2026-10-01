"use client";
import {
  Settings,
  categoryStats,
  countingStats,
  currentSeason,
  espnPointsDefaults,
  slots,
} from "@/lib/model";
import { useState } from "react";

const espnWeights = espnPointsDefaults.weights as Settings["weights"];
const espnRules: Partial<Settings> = {
  ...espnPointsDefaults,
  order: Array.from({ length: espnPointsDefaults.teamCount }, (_, i) => i),
  scoring: "points",
  fallback: "FP",
};
const differs = (settings: Settings) =>
  settings.teamCount !== espnPointsDefaults.teamCount ||
  settings.seconds !== espnPointsDefaults.seconds ||
  settings.scoring !== "points" ||
  slots.some(
    (slot) => settings.slots[slot] !== espnPointsDefaults.slots[slot],
  ) ||
  countingStats.some(
    (stat) => (settings.weights[stat] ?? 0) !== (espnWeights[stat] ?? 0),
  );

export function SettingsEditor({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  const [orderText, setOrderText] = useState(
    settings.order.map((slot) => slot + 1).join(","),
  );
  const update = (changes: Partial<Settings>) =>
    onChange({ ...settings, ...changes });
  const resetOrder = (count: number) => {
    const order = Array.from(
      { length: Math.min(20, Math.max(0, count)) },
      (_, index) => index,
    );
    setOrderText(order.map((slot) => slot + 1).join(","));
    return order;
  };
  return (
    <div className="settings">
      <p className="defaults-note">
        {differs(settings) ? "Custom rules." : "ESPN H2H Points defaults"}
        {settings.format === "3rr"
          ? " · 3RR is this app's default; ESPN defaults to snake."
          : ""}
        {differs(settings) && (
          <button
            type="button"
            onClick={() => {
              resetOrder(espnPointsDefaults.teamCount);
              update({ ...espnRules, format: settings.format });
            }}
          >
            Use ESPN defaults
          </button>
        )}
      </p>
      <div className="grid">
        <label>
          Teams
          <input
            type="number"
            min="2"
            max="20"
            value={settings.teamCount}
            onChange={(event) => {
              const count = Number(event.target.value);
              update({ teamCount: count, order: resetOrder(count) });
            }}
          />
        </label>
        <label>
          Seconds/pick
          <input
            type="number"
            min="5"
            max="600"
            value={settings.seconds}
            onChange={(event) =>
              update({ seconds: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Format
          <select
            value={settings.format}
            onChange={(event) =>
              update({ format: event.target.value as Settings["format"] })
            }
          >
            <option value="3rr">3RR (app default)</option>
            <option value="snake">Snake (ESPN default)</option>
          </select>
        </label>
        <label>
          Season
          <select
            value={settings.season}
            onChange={(event) => update({ season: Number(event.target.value) })}
          >
            {[
              ...new Set([
                currentSeason() - 1,
                currentSeason(),
                settings.season,
              ]),
            ].map((season) => (
              <option key={season} value={season}>
                {season - 1}–{String(season).slice(-2)}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          First-round order (team numbers)
          <input
            value={orderText}
            inputMode="numeric"
            onChange={(event) => {
              setOrderText(event.target.value);
              update({
                order: event.target.value
                  .split(",")
                  .map((input) => Number(input.trim()) - 1),
              });
            }}
          />
        </label>
      </div>
      <fieldset>
        <legend>
          Roster ·{" "}
          {Object.values(settings.slots).reduce((sum, n) => sum + n, 0)} rounds
        </legend>
        <div className="mini-grid">
          {slots.map((slot) => (
            <label key={slot}>
              {slot}
              <input
                type="number"
                min="0"
                max="30"
                value={settings.slots[slot]}
                onChange={(event) =>
                  update({
                    slots: {
                      ...settings.slots,
                      [slot]: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid">
        <label>
          Scoring
          <select
            value={settings.scoring}
            onChange={(event) =>
              update({
                scoring: event.target.value as Settings["scoring"],
                fallback: event.target.value === "points" ? "FP" : "PTS",
              })
            }
          >
            <option value="points">Points</option>
            <option value="categories">Categories</option>
          </select>
        </label>
        <label>
          Timeout pick by
          <select
            value={settings.fallback}
            onChange={(event) =>
              update({ fallback: event.target.value as Settings["fallback"] })
            }
          >
            {(settings.scoring === "points"
              ? ["FP", ...categoryStats]
              : categoryStats
            ).map((stat) => (
              <option key={stat} value={stat}>
                {stat}/game
              </option>
            ))}
          </select>
        </label>
      </div>
      {settings.scoring === "categories" ? (
        <fieldset>
          <legend>Categories</legend>
          <div className="checks">
            {categoryStats.map((stat) => (
              <label key={stat}>
                <input
                  type="checkbox"
                  checked={settings.categories.includes(stat)}
                  onChange={(event) =>
                    update({
                      categories: event.target.checked
                        ? [...settings.categories, stat]
                        : settings.categories.filter((key) => key !== stat),
                    })
                  }
                />
                {stat}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <fieldset>
          <legend>Points per stat</legend>
          <div className="mini-grid">
            {countingStats.map((stat) => (
              <label key={stat}>
                {stat === "TO" ? "TOV" : stat}
                <input
                  type="number"
                  min="-100"
                  max="100"
                  step="0.001"
                  value={settings.weights[stat] ?? 0}
                  onChange={(event) =>
                    update({
                      weights: {
                        ...settings.weights,
                        [stat]: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
