"""Decode actual browser downloads and check readable board cells with OCR.

Needs Pillow and tesseract. Run with the external evidence directory as argument.
"""
import io
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(sys.argv[1])
output = root / "readability"
output.mkdir(exist_ok=True)

def normalize(value):
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", plain.lower())

def ocr(image):
    data = io.BytesIO()
    image.save(data, format="PNG")
    result = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6"], input=data.getvalue(), capture_output=True, timeout=30, check=True)
    return result.stdout.decode().strip()

results = []
for path in sorted((root / "downloads").glob("*.png")):
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as source:
        image = source.convert("RGB")
        image.load()
    results.append({"path": str(path), "decoded": True, "size": image.size})

for name in ["desktop-populated", "desktop-long-full-board"]:
    receipt = json.loads((root / f"{name}-receipt.json").read_text())
    image = Image.open(receipt["path"]).convert("RGB")
    bold = [d for d in receipt["draws"] if re.match(r"^(bold|700) 14px", d["font"])]
    left = min(d["x"] for d in bold)
    anchors = [d for d in bold if d["x"] == left]
    rows = receipt["board"]
    columns = len(rows[0])
    scale = bold[0]["scale"]
    # Find each visible header's first line in the actual draw receipt.
    header_draws = [d for d in bold if d["y"] < anchors[1]["y"]]
    xs = []
    for cell in rows[0]:
        candidates = [d for d in header_draws if normalize(cell["name"]).startswith(normalize(d["text"])) and (not xs or d["x"] > xs[-1])]
        assert candidates, cell["name"]
        xs.append(candidates[0]["x"])
    cells = [(0, 1), (1, 1), (1, columns - 1), (len(rows) - 1, 1), (len(rows) - 1, columns - 1)]
    longest = sorted([(r, c) for r in range(1, len(rows)) for c in range(1, columns)], key=lambda rc: len(rows[rc[0]][rc[1]]["name"]), reverse=True)[:4]
    cells = list(dict.fromkeys(cells + longest))
    crops, checks = [], []
    for row, column in cells:
        x = xs[column]
        right = xs[column + 1] - 10 * scale if column + 1 < columns else image.width - 20 * scale
        y = anchors[row]["y"] - 10 * scale
        bottom = anchors[row + 1]["y"] - 10 * scale if row + 1 < len(rows) else image.height - 20 * scale
        crop = image.crop((round(x - 10 * scale), round(y), round(right), round(bottom)))
        text = ocr(crop)
        expected = rows[row][column]["name"]
        assert normalize(expected) in normalize(text), (name, row, column, expected, text)
        crop_path = output / f"{name}-row-{row}-column-{column}.png"
        crop.save(crop_path)
        crops.append((crop, f"Row {row}, column {column}: {expected}"))
        checks.append({"row": row, "column": column, "expected": expected, "ocr": text, "path": str(crop_path), "readable": True})
    # A cropped-away name must fail the same OCR assertion.
    negative = crops[-1][0].copy()
    negative.paste("white", (0, 0, negative.width, negative.height))
    assert normalize(checks[-1]["expected"]) not in normalize(ocr(negative))
    sheet_width = 1100
    sheet = Image.new("RGB", (sheet_width, len(crops) * 180), "white")
    draw = ImageDraw.Draw(sheet)
    for index, (crop, label) in enumerate(crops):
        draw.text((10, index * 180 + 6), label, fill="black")
        # Preserve pixels at their original size, without scaling up.
        sheet.paste(crop, (10, index * 180 + 28))
    sheet_path = output / f"{name}-contact-sheet.png"
    sheet.save(sheet_path)
    results.append({"name": name, "pixelOCR": checks, "missingNameRejected": True, "contactSheet": str(sheet_path)})
(root / "readability-receipt.json").write_text(json.dumps(results, indent=2))
print(json.dumps({"decoded": sum(1 for r in results if r.get("decoded")), "OCRCells": sum(len(r.get("pixelOCR", [])) for r in results), "negativeControlRejected": True}))
