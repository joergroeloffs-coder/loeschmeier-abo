import re
from pathlib import Path

HIER = Path(__file__).resolve().parent
SRC = str(HIER / "src") + "/"
OUT = str(HIER / "dist" / "bundle.js")

def strip(text, drop_export=False):
    lines = text.split("\n")
    result = []
    for line in lines:
        if line.startswith("import "):
            continue
        if drop_export and line.startswith("export default"):
            continue
        line = re.sub(r"^export (async function|function|const)", r"\1", line)
        result.append(line)
    return "\n".join(result)

supabase = open(SRC + "supabase.js").read()
paypal = open(SRC + "paypal.js").read()
index = open(SRC + "index.js").read()

header = """// Löschmeier Test — Cloudflare Worker (zusammengefasste Datei für den
// Dashboard-Code-Editor). Quelle/Wartung in worker/src/*.js — diese Datei
// wird daraus automatisch zusammengesetzt (build_bundle.py), bitte nicht
// direkt bearbeiten.
"""

out = header + "\n// ===== supabase.js =====\n\n" + strip(supabase)
out += "\n// ===== paypal.js =====\n\n" + strip(paypal)
out += "\n// ===== index.js =====\n\n" + strip(index)

with open(OUT, "w") as f:
    f.write(out)

print("geschrieben:", OUT)
