type Cell = {
  name: string;
  number: string;
  detail: string;
  playerId: string | undefined;
  background: string;
  current: boolean;
};

function wrap(context: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && context.measureText(`${line} ${word}`).width > width) {
      lines.push(line);
      line = "";
    }
    for (const letter of Array.from(word)) {
      if (context.measureText(line + letter).width > width && line) {
        lines.push(line);
        line = "";
      }
      line += letter;
    }
    line += " ";
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

async function photos(ids: string[]) {
  const images = new Map<string, ImageBitmap>();
  const signal = AbortSignal.timeout(8000);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length && !signal.aborted) {
        const id = ids[next++];
        try {
          const response = await fetch(`/api/photos/${id}`, { signal });
          if (
            !response.ok ||
            response.headers.get("Content-Type")?.includes("svg")
          )
            continue;
          const image = await createImageBitmap(await response.blob());
          images.set(id, image);
        } catch {
          // The board remains readable when a photo is missing or unavailable.
        }
      }
    }),
  );
  return images;
}

export async function downloadBoardPng(
  table: HTMLTableElement,
  title: string,
  summary: string,
) {
  // Read the complete mounted board before waiting for assets or another room poll.
  const rows = Array.from(table.rows, (row) =>
    Array.from(
      row.cells,
      (cell): Cell => ({
        name:
          cell.querySelector("strong")?.textContent ?? cell.textContent ?? "",
        number: cell.querySelector("small")?.textContent ?? "",
        detail: cell.querySelectorAll("small")[1]?.textContent ?? "",
        playerId: cell.dataset.playerId,
        background: getComputedStyle(cell).backgroundColor,
        current: cell.classList.contains("current"),
      }),
    ),
  );
  const theme = getComputedStyle(table);
  const root = getComputedStyle(document.documentElement);
  const ink = root.getPropertyValue("--ink").trim();
  const muted = root.getPropertyValue("--muted").trim();
  const blue = root.getPropertyValue("--blue").trim();
  const line = root.getPropertyValue("--line").trim();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser.");
  const font = (size: number, bold = false) =>
    `${bold ? "700" : "400"} ${size}px ${theme.fontFamily}`;
  const columnWidth = 200,
    roundWidth = 44,
    margin = 20;
  const width = margin * 2 + roundWidth + (rows[0].length - 1) * columnWidth;
  context.font = font(24, true);
  const titleLines = wrap(context, title, width - margin * 2);
  context.font = font(12);
  const summaryLines = wrap(context, summary, width - margin * 2);
  const top = margin + titleLines.length * 30 + summaryLines.length * 18 + 16;
  const heights = rows.map((row, index) =>
    Math.max(
      index === 0 ? 44 : 86,
      ...row.map((cell, column) => {
        context.font = font(14, true);
        const name = wrap(
          context,
          cell.name,
          (column ? columnWidth : roundWidth) - 20,
        );
        context.font = font(11);
        const detail = wrap(context, cell.detail, columnWidth - 20);
        return (
          20 +
          (cell.playerId ? 42 : cell.number ? 18 : 0) +
          name.length * 18 +
          detail.length * 15
        );
      }),
    ),
  );
  const height =
    top + heights.reduce((total, value) => total + value, 0) + margin;
  // Keep large boards readable while bounding the canvas memory on phones.
  const scale = Math.min(2, Math.sqrt(16000000 / (width * height)));
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  context.scale(scale, scale);
  context.textBaseline = "top";
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  const text = (
    value: string,
    x: number,
    y: number,
    maxWidth: number,
    size: number,
    bold = false,
    color = ink,
  ) => {
    context.font = font(size, bold);
    context.fillStyle = color;
    const lines = wrap(context, value, maxWidth);
    lines.forEach((value, index) =>
      context.fillText(value.trim(), x, y + index * (size + 4)),
    );
    return lines.length * (size + 4);
  };
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.flatMap((cell) => (cell.playerId ? [cell.playerId] : [])),
      ),
    ),
  ];
  const images = await photos(ids);
  try {
    text(title, margin, margin, width - margin * 2, 24, true);
    text(
      summary,
      margin,
      margin + titleLines.length * 30,
      width - margin * 2,
      12,
      false,
      muted,
    );
    let y = top;
    rows.forEach((row, rowIndex) => {
      let x = margin;
      row.forEach((cell, column) => {
        const cellWidth = column ? columnWidth : roundWidth;
        context.fillStyle =
          cell.background === "rgba(0, 0, 0, 0)"
            ? rowIndex === 0
              ? "#f5f7f9"
              : "#fff"
            : cell.background;
        context.fillRect(x, y, cellWidth, heights[rowIndex]);
        context.strokeStyle = line;
        context.lineWidth = 1;
        context.strokeRect(x, y, cellWidth, heights[rowIndex]);
        if (cell.current) {
          context.strokeStyle = blue;
          context.lineWidth = 2;
          context.strokeRect(
            x + 1,
            y + 1,
            cellWidth - 2,
            heights[rowIndex] - 2,
          );
        }
        let contentY = y + 10;
        if (cell.playerId) {
          const image = images.get(cell.playerId);
          context.save();
          context.beginPath();
          context.arc(x + 28, contentY + 18, 18, 0, Math.PI * 2);
          context.clip();
          context.fillStyle = "#eef1f5";
          context.fillRect(x + 10, contentY, 36, 36);
          if (image) {
            const ratio = Math.max(36 / image.width, 36 / image.height);
            context.drawImage(
              image,
              x + 28 - (image.width * ratio) / 2,
              contentY + 18 - (image.height * ratio) / 2,
              image.width * ratio,
              image.height * ratio,
            );
          } else {
            const initials = cell.name
              .split(/\s+/)
              .map((part) => Array.from(part)[0] ?? "")
              .slice(0, 2)
              .join("");
            context.font = font(11);
            context.fillStyle = muted;
            context.fillText(
              initials,
              x + 28 - context.measureText(initials).width / 2,
              contentY + 12,
            );
          }
          context.restore();
          text(
            cell.number,
            x + 54,
            contentY + 12,
            cellWidth - 64,
            11,
            false,
            muted,
          );
          contentY += 42;
        } else if (cell.number) {
          contentY +=
            text(
              cell.number,
              x + 10,
              contentY,
              cellWidth - 20,
              11,
              false,
              muted,
            ) + 3;
        }
        contentY += text(cell.name, x + 10, contentY, cellWidth - 20, 14, true);
        text(
          cell.detail,
          x + 10,
          contentY + 2,
          cellWidth - 20,
          11,
          false,
          muted,
        );
        x += cellWidth;
      });
      y += heights[rowIndex];
    });
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("The board image could not be created.")),
        "image/png",
      ),
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${
      title
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .slice(0, 60) || "draft"
    }-board.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } finally {
    images.forEach((image) => image.close());
    canvas.width = canvas.height = 0;
  }
}
