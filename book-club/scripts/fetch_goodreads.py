#!/usr/bin/env python3
"""Pull a Goodreads user's shelves from the public RSS feeds and write JSON.

Goodreads retired its developer API in Dec 2020, but every public shelf is
still exposed as RSS at /review/list_rss/<user_id>?shelf=<name>. Each item
carries the user's star rating, the Goodreads average, page count, publish
year, cover and description -- enough to model taste without scraping.

Browsers can't read that feed directly from GitHub Pages (no CORS headers),
so a scheduled GitHub Action runs this script and commits the JSON the page
reads. Standard library only, so the Action needs no installs.

Usage:  python3 fetch_goodreads.py              # every reader in data/readers.json
        python3 fetch_goodreads.py --user 123 --out some.json
"""

import argparse
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
READERS = DATA / "readers.json"
OVERRIDES = DATA / "tag-overrides.json"
FEED = "https://www.goodreads.com/review/list_rss/{user}?shelf={shelf}&per_page=200&page={page}"
UA = "Mozilla/5.0 (book-club-picker; +https://github.com/schubatis1/Aqi-Watch)"

# Theme tags inferred from each book's title + description. Candidates in
# candidates.json use the same vocabulary, which is what lets the page match
# "books like this one" against what you've already rated.
TAG_RULES = {
    "horror": r"\bhorror|terrif|dread|nightmare|macabre|haunted|sinister|gruesome|terror\b|wendigo",
    "ghost": r"\bghosts?\b|haunt|spectr|apparition|poltergeist",
    "gothic": r"\bgothic|governess|manor|mansion|crumbling|victorian|brooding|estate\b",
    "folk-horror": r"folk.horror|pagan|ritual|\bcult\b|burial ground|wendigo|harvest|sacrific|wilderness|\bthe woods\b|small town|village",
    "weird": r"\bweird|uncanny|eerie|surreal|cosmic|dreamlike|labyrinth|occult|mystic|visionary",
    "supernatural": r"supernatural|magic|witch|sorcer|curse|resurrect|undead|dead come back|otherworld|spell",
    "halloween": r"halloween|jack-o|pumpkin|trick.or.treat|all hallows|carnival",
    "death": r"\bdeath\b|\bdying\b|\bdie\b|grief|mourn|funeral|afterlife|mortal|loss of|cemetery|hell\b",
    "coming-of-age": r"coming.of.age|boyhood|childhood|\bboys?\b|young man|teen|adolescen|growing up|school",
    "literary": r"\bliterary|prose|masterpiece|lyrical|novella|pulitzer|booker|meditation|luminous|classic",
    "psychological": r"psycholog|madness|insan|obsess|paranoi|unreliable|mind\b|sanity|isolation",
    "mythology": r"\bmyth|legends?\b|legendary|folklore|\bgods\b|greek|norse",
    "fantasy": r"\bfantasy|wizard|dragon|quest|kingdom|fairy|elves|sword",
    "sci-fi": r"science fiction|\bsci-fi|alien|space|planet|galax|robot|\bai\b|future|dystop|starship|time travel",
    "thriller": r"thriller|suspense|mystery|murder|killer|detective|conspiracy|pulse-pounding",
    "history": r"\bhistory\b|historian|civiliz|empire\b",
    "nonfiction": r"\bnonfiction|non-fiction|memoir|essays?\b|guide\b|how to|science of|research|reporting",
    "humor": r"\bhumou?r|funny|hilarious|comic|satir|witty|laugh",
}
COMPILED = {tag: re.compile(rx, re.I) for tag, rx in TAG_RULES.items()}


def strip_html(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def infer_tags(title, desc, year):
    text = f"{title} {desc}"
    tags = {tag for tag, rx in COMPILED.items() if rx.search(text)}
    if year and year < 1960:
        tags.add("classic")
    # "Big Idea: A Subtitle About It" is the house style of nonfiction.
    if re.search(r"\S: \w", title) and "(" not in title:
        tags.add("nonfiction")
    # Nonfiction books trip a lot of fiction keywords ("history of ghosts");
    # keep the nonfiction/history signal and drop genre-fiction noise.
    if "nonfiction" in tags:
        tags -= {"horror", "ghost", "gothic", "folk-horror", "supernatural", "fantasy", "sci-fi", "thriller", "halloween"}
    return sorted(tags)


def fetch(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:  # network hiccup -> back off and retry
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1} after {e}", file=sys.stderr)
            time.sleep(2 ** (attempt + 1))


def to_int(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_item(it, overrides):
    book_id = it.findtext("book_id")
    title = (it.findtext("title") or "").strip()
    desc = strip_html(it.findtext("book_description"))
    year = to_int(it.findtext("book_published"))
    pages = to_int(it.find("book").findtext("num_pages")) if it.find("book") is not None else None
    tags = set(infer_tags(title, desc, year))
    ov = overrides.get(book_id, {})
    tags |= set(ov.get("add", []))
    tags -= set(ov.get("remove", []))
    rating = to_int(it.findtext("user_rating")) or 0
    return {
        "id": book_id,
        "title": title,
        "author": re.sub(r"\s+", " ", it.findtext("author_name") or "").strip(),
        "rating": rating,  # 0 = shelved but not rated
        "avg": to_float(it.findtext("average_rating")),
        "year": year,
        "pages": pages,
        "readAt": (it.findtext("user_read_at") or "").strip() or None,
        "added": (it.findtext("user_date_added") or "").strip() or None,
        "shelves": [s.strip() for s in (it.findtext("user_shelves") or "").split(",") if s.strip()],
        "cover": (it.findtext("book_medium_image_url") or "").strip() or None,
        "url": f"https://www.goodreads.com/book/show/{book_id}",
        "tags": sorted(tags),
        "blurb": desc[:280],
    }


def fetch_shelf(user, shelf, overrides):
    books, page = [], 1
    while page <= 25:
        root = ET.fromstring(fetch(FEED.format(user=user, shelf=shelf, page=page)))
        items = root.findall(".//item")
        if not items:
            break
        books += [parse_item(it, overrides) for it in items]
        if len(items) < 100:  # Goodreads caps RSS pages at ~100 items
            break
        page += 1
    print(f"  {shelf}: {len(books)} books", file=sys.stderr)
    return books


def sync(user, out_path, overrides, profile=None):
    print(f"Fetching Goodreads shelves for user {user}", file=sys.stderr)
    read = fetch_shelf(user, "read", overrides)
    to_read = fetch_shelf(user, "to-read", overrides)
    if not read:
        print(f"  read shelf empty for {user} -- is the profile public? Keeping old data.", file=sys.stderr)
        return False
    out = {
        "user": user,
        "profile": profile or f"https://www.goodreads.com/user/show/{user}",
        "fetchedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "read": read,
        "toRead": to_read,
    }
    Path(out_path).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"  wrote {out_path}", file=sys.stderr)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", help="one Goodreads user id (default: everyone in readers.json)")
    ap.add_argument("--out", help="output path when --user is given")
    args = ap.parse_args()

    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    overrides.pop("_comment", None)

    if args.user:
        ok = sync(args.user, args.out or DATA / f"goodreads-{args.user}.json", overrides)
        sys.exit(0 if ok else 1)

    readers = json.loads(READERS.read_text())["readers"]
    results = [sync(r["id"], DATA / f"goodreads-{r['id']}.json", overrides, r.get("profile")) for r in readers]
    # One private/broken profile shouldn't block everyone else's refresh.
    if not any(results):
        sys.exit("Every shelf came back empty; nothing written.")


if __name__ == "__main__":
    main()
