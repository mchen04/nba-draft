"use client";
import { useState } from "react";
import { Player } from "@/lib/model";

export function Avatar({ player }: { player: Player }) {
  const [failedId, setFailedId] = useState<number | null>(null);
  return (
    <span className="avatar" aria-hidden="true">
      {failedId === player.id ? (
        player.name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join("")
      ) : (
        <img
          src={`/api/photos/${player.id}`}
          alt=""
          width="36"
          height="36"
          loading="lazy"
          onError={() => setFailedId(player.id)}
        />
      )}
    </span>
  );
}
