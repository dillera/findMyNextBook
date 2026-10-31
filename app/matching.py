"""Title/author normalisation and matching, shared by the importers, the recommender and the Kindle-store check.

Amazon, Goodreads and the LLM each spell the same book differently ("Children of Ruin (Children of Time Book 2)",
"Children of Ruin", "Gone-Away World, The"; "Tchaikovsky, Adrian" vs "Adrian Tchaikovsky"), so everything is compared
as (normalised title, author surname)."""
import difflib
import re
from collections import defaultdict

from .google_books import _strip_series


def norm_title(t: str | None) -> str:
    t = _strip_series(t or "").lower()
    t = re.split(r"[:(]", t)[0]  # drop subtitles
    t = re.sub(r"^(the|a|an)\s+", "", t)
    t = re.sub(r",\s*(the|a|an)\s*$", "", t)  # "Gone-Away World, The"
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def surname(a: str | None) -> str:
    """'Peter Watts' -> 'watts'; Amazon's 'Watts, Peter' -> 'watts'; 'Pitre, Boisy G; Loguidice, Bill' -> 'pitre'."""
    a = (a or "").split(";")[0].strip()
    if not a:
        return ""
    if "," in a:
        return a.split(",")[0].strip().lower()
    return a.split()[-1].lower()


def similar(a: str, b: str) -> bool:
    """Two normalised titles by the same author: equal, one contains the other, or a near-identical spelling."""
    if a == b:
        return True
    if len(a) >= 8 and len(b) >= 8 and (a in b or b in a):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.9


def is_known(title: str, author: str | None, known: set[tuple[str, str]]) -> str | None:
    """Return the matching known title if `title` is already in the library / owned list, else None.
    known = {(norm_title, author_surname)}. Exact normalized match, containment, or close fuzzy match by same author."""
    nt = norm_title(title)
    if not nt:
        return None
    sa = surname(author)
    for kt, ka in known:
        if nt == kt:
            return kt
        if (not sa or not ka or sa == ka) and similar(nt, kt):
            return kt
    return None


class BookIndex:
    """Every row of `books`, indexed for matching an incoming Kindle / Goodreads / order-history item to an existing book.
    ASIN and ISBN are exact; otherwise the same normalised title by the same author, then a fuzzy title by that author."""

    COLS = "id, title, author, asin, isbn, goodreads_id, exclusive_shelf, my_rating, date_read, thumbnail"

    def __init__(self, conn, where: str = ""):
        self.by_id, self.by_asin, self.by_isbn = {}, {}, {}
        self.by_norm, self.by_surname = defaultdict(list), defaultdict(list)
        for r in conn.execute(f"SELECT {self.COLS} FROM books {where}"):
            self.add(dict(r))

    def add(self, b: dict) -> None:
        b["_norm"], b["_sur"] = norm_title(b["title"]), surname(b.get("author"))
        self.by_id[b["id"]] = b
        if b.get("asin"):
            self.by_asin.setdefault(b["asin"], b)
        if b.get("isbn"):
            self.by_isbn.setdefault(b["isbn"].upper(), b)
        if b["_norm"]:
            self.by_norm[b["_norm"]].append(b)
            self.by_surname[b["_sur"]].append(b)

    def remove(self, b: dict) -> None:
        self.by_id.pop(b["id"], None)
        for d, k in ((self.by_asin, b.get("asin")), (self.by_isbn, (b.get("isbn") or "").upper())):
            if k and d.get(k) is b:
                del d[k]
        for lst in (self.by_norm.get(b["_norm"], []), self.by_surname.get(b["_sur"], [])):
            if b in lst:
                lst.remove(b)

    def find(self, title: str, author: str | None = None, asin: str | None = None, isbn: str | None = None) -> dict | None:
        if asin and asin in self.by_asin:
            return self.by_asin[asin]
        if isbn and isbn.upper() in self.by_isbn:
            return self.by_isbn[isbn.upper()]
        nt, sa = norm_title(title), surname(author)
        if not nt:
            return None
        for b in self.by_norm.get(nt, []):
            if not sa or not b["_sur"] or sa == b["_sur"]:
                return b
        if not sa:  # title-only items (order history has no author): exact titles only, fuzzy is too risky
            return None
        for b in self.by_surname.get(sa, []):
            if similar(nt, b["_norm"]):
                return b
        return None
