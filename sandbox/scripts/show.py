"""Formats server responses for scripts/demo.sh. Usage: show.py <mode> [show-sql] < json"""
import json
import sys

mode = sys.argv[1]
data = json.load(sys.stdin)

if mode == "query":
    if "error" in data:
        print(f"   error: {data['error']['code']} - {data['error']['message']}")
        sys.exit()
    meta, rows = data["meta"], data["data"]
    t = meta["timingsMs"]
    print(
        f"   tier={meta['tier']:<8} cache={meta['cache']:<9} total={t['total']:>8.1f} ms"
        f"   model={t['generate']:>7.1f} ms   rows={len(rows)}   review={meta['review']['status']}"
    )
    print(f"   first row: {rows[0] if rows else None}")
    if len(sys.argv) > 2:
        print("   SQL:", " ".join(meta["sql"].split()))
        if meta["assumptions"]:
            print("   assumptions:", " | ".join(meta["assumptions"]))

elif mode == "review-status":
    handlers = data["handlers"]
    print(handlers[0]["review"]["status"] if handlers else "none")

elif mode == "review":
    h = data["handlers"][0]
    r = h["review"]
    print(f"   review: {r['status']} after {r['reviews']} review(s), revision {h['revision']}")
    for p in r["problems"]:
        print(f"   reviewer: {p[:220]}")

elif mode == "store":
    s = data["store"]
    print(f"loaded {s['loadedOnStart']} saved Liquid handler(s) from the database")

elif mode == "crystal":
    c = data["crystal"]
    print(f"Crystal loaded: {c['loaded']}, refused: {len(c['refused'])}")
