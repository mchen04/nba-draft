"use client";
import { Settings, categoryStats, countingStats, slots } from "@/lib/model";
import { useState } from "react";

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
  return (
    <div className="settings-grid">
      <label>
        Teams
        <input
          type="number"
          min="2"
          max="20"
          value={settings.teamCount}
          onChange={(event) => {
            const count = Number(event.target.value);
            const order = Array.from(
              { length: Math.min(20, Math.max(0, count)) },
              (_, index) => index,
            );
            setOrderText(order.map((slot) => slot + 1).join(","));
            update({ teamCount: count, order });
          }}
        />
      </label>
      <label>
        Seconds per pick
        <input
          type="number"
          min="5"
          max="600"
          value={settings.seconds}
          onChange={(event) => update({ seconds: Number(event.target.value) })}
        />
      </label>
      <label>
        Draft format
        <select
          value={settings.format}
          onChange={(event) =>
            update({ format: event.target.value as Settings["format"] })
          }
        >
          <option value="3rr">Third-round reversal (3RR)</option>
          <option value="snake">Ordinary snake</option>
        </select>
      </label>
      <label>
        Season ending year
        <input
          type="number"
          min="2020"
          max="2100"
          value={settings.season}
          onChange={(event) => update({ season: Number(event.target.value) })}
        />
      </label>
      <label className="wide">
        Draft order (team numbers, separated by commas)
        <input
          value={orderText}
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
      <p className="wide hint">
        3RR runs forward, reverse, reverse, forward, reverse, then alternates.
        Snake reverses every round. These are app defaults, not your league
        rules.
      </p>
      <fieldset className="wide">
        <legend>
          Roster positions ·{" "}
          {Object.values(settings.slots).reduce((sum, count) => sum + count, 0)}{" "}
          rounds
        </legend>
        <div className="slot-inputs">
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
          <option value="categories">Categories</option>
          <option value="points">Custom points</option>
        </select>
      </label>
      <label>
        Timeout ranking (per game)
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
            <option key={stat}>{stat}</option>
          ))}
        </select>
      </label>
      <p className="hint wide">
        Timeouts use your highest available eligible queued player, then this
        ranking. TO ranks low first. Category ranking is not a balanced category
        recommendation.
      </p>
      {settings.scoring === "categories" ? (
        <fieldset className="wide">
          <legend>Projected categories</legend>
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
        <fieldset className="wide">
          <legend>
            Points weights · totals × weights, divided by projected games
          </legend>
          <div className="slot-inputs">
            {countingStats.map((stat) => (
              <label key={stat}>
                {stat}
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
          <p className="hint">
            Missing inputs produce an incomplete projection, not zero. No
            bonuses or double-double inputs are available.
          </p>
        </fieldset>
      )}
    </div>
  );
}
