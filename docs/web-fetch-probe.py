#!/usr/bin/env python3
"""
The measurement behind DESIGN §4f — can a plain HTTP fetch see a price?

Run it before arguing about web_fetch, and again before building P6b: these sites
change their defences, and §4f is only worth what the numbers say today.

    python3 docs/web-fetch-probe.py

WHAT IT MEASURES, and why this metric rather than another: the money visible in
the text an extractor recovers once <script> and <style> are stripped — because
that stripped text is what a web_fetch tool would hand the model. Counting prices
in the raw HTML is misleading: Google Flights embeds fares inside
AF_initDataCallback script blobs, so a naive grep over the bytes reports success
on a page whose readable text says "Loading results". That false positive is the
whole reason this file exists.

Read-only GETs, one per target, no retries. Nothing here logs in, submits a form,
or takes any action.

Result on 2026-08-03: 1 of 8 price targets readable — and it is the one that
matters. Google Flights serves a server-rendered no-JS fallback: 60,906 chars of
real itineraries, 29 fares, byte-identical across four consecutive runs. The other
seven fail in two ways, client-side rendering (Ryanair: 7 chars of text) and
outright 403 (idealo, currys, and the r.jina.ai reader). The controls (Wikipedia,
Hacker News) return full text, proving the extractor works and that the targets,
not the method, are what fail.

RUN IT MORE THAN ONCE BEFORE CONCLUDING ANYTHING. An early single run of the same
Google Flights URL returned 2,140 chars ending in "Loading results", and that one
sample became a confident, wrong claim in DESIGN §4e that the use case was
impossible. Repetition is what settled it.
"""
import re
import subprocess

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# (label, url, is_control)
TARGETS = [
    ("Google Flights search", "https://www.google.com/travel/flights?q=Flights%20from%20Amsterdam%20to%20London%20on%202026-09-10", False),
    ("Google Flights via r.jina.ai", "https://r.jina.ai/https://www.google.com/travel/flights?q=Flights%20from%20Amsterdam%20to%20London%20on%202026-09-10", False),
    ("Ryanair booking", "https://www.ryanair.com/gb/en/trip/flights/select?ADT=1&DateOut=2026-09-10&Origin=AMS&Destination=STN", False),
    ("Kayak flights", "https://www.kayak.com/flights/AMS-LON/2026-09-10", False),
    ("tweakers Pricewatch", "https://tweakers.net/pricewatch/best-getest/videokaarten/", False),
    ("coolblue.nl category", "https://www.coolblue.nl/laptops", False),
    ("idealo.de comparison", "https://www.idealo.de/preisvergleich/ProductCategory/16073.html", False),
    ("currys.co.uk category", "https://www.currys.co.uk/laptops.html", False),
    ("Wikipedia", "https://en.wikipedia.org/wiki/Airline_ticket", True),
    ("Hacker News", "https://news.ycombinator.com", True),
]

MONEY = re.compile(r"(?:€|£|\$)\s?\d[\d.,]{1,7}")


def visible_text(html: str) -> str:
    """What a tool would actually hand the model: no scripts, no tags, no runs of space."""
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html)).strip()


def probe(url: str):
    r = subprocess.run(
        ["curl", "-sL", "--max-time", "25", "-A", UA, "-w", "\n__CODE__%{http_code}", url],
        capture_output=True, text=True, timeout=45,
    )
    code = r.stdout.rsplit("__CODE__", 1)[-1].strip() or "???"
    return code, visible_text(r.stdout.rsplit("\n__CODE__", 1)[0])


def main() -> None:
    print(f"{'target':34s} {'http':5s} {'text chars':>11s} {'prices':>7s}  sample")
    print("-" * 90)
    failures = 0
    for label, url, is_control in TARGETS:
        try:
            code, text = probe(url)
            found = sorted(set(MONEY.findall(text)))
        except Exception as exc:  # a probe that cannot run is a result too, not a crash
            print(f"{label:34s} {'ERR':5s} {str(exc)[:44]}")
            continue
        tag = " (control)" if is_control else ""
        print(f"{label + tag:34s} {code:5s} {len(text):11d} {len(found):7d}  {found[:4]}")
        if not is_control and not found:
            failures += 1
    targets = sum(1 for *_, control in TARGETS if not control)
    print("-" * 90)
    print(f"{failures}/{targets} price targets yielded NO price in recoverable text.")
    if failures == targets:
        print("Unchanged from 2026-08-03: a plain fetch cannot do price comparison (DESIGN §4f).")


if __name__ == "__main__":
    main()
