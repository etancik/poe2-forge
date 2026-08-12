#!/usr/bin/env python3
"""Fetch current 24-hour exchange ratios from a PoE2DB item page."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen


TRADE_LEAGUES_URL = "https://www.pathofexile.com/api/trade2/data/leagues"
DEFAULT_TRADE_REALM = "poe2"
DEFAULT_SOURCE_LOCALE = "us"
USER_AGENT = "Codex-PoE2-Cost-Estimator/1.1"


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain(fragment: str) -> str:
    parser = _Text()
    parser.feed(fragment)
    return " ".join(html.unescape("".join(parser.parts)).split())


def _number(text: str) -> float:
    return float(text.replace(",", ""))


def _item_url(item: str, locale: str) -> str:
    if not re.fullmatch(r"[a-z]{2,3}", locale):
        raise ValueError("--source-locale must be a two- or three-letter lowercase code")
    slug = quote(item.strip().replace(" ", "_"), safe="_-'()")
    return f"https://poe2db.tw/{locale}/{slug}"


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"poe2db.tw", "www.poe2db.tw"}:
        raise ValueError("--url must be an https://poe2db.tw item page")
    return url.split("#", 1)[0]


def _name_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return unquote(path.rsplit("/", 1)[-1]).replace("_", " ")


def _locale_from_url(url: str) -> str:
    parts = [part for part in urlparse(url).path.split("/") if part]
    if not parts or not re.fullmatch(r"[a-z]{2,3}", parts[0]):
        raise ValueError("PoE2DB URL does not contain a supported locale prefix")
    return parts[0]


def _market_from_page(page: str) -> str | None:
    for attributes, body in re.findall(
        r"<a\b([^>]*)>(.*?)</a>", page, re.IGNORECASE | re.DOTALL
    ):
        if not re.search(r"\bhref\s*=\s*['\"](?:\.?/)?Economy['\"]", attributes, re.IGNORECASE):
            continue
        rendered = _plain(body)
        match = re.search(r"\b([A-Z]{2,3}) Realm Economy\b", rendered)
        if match:
            return f"{match.group(1)} Realm Economy"
    for heading in re.findall(
        r"<h[1-6][^>]*>(.*?)</h[1-6]>", page, re.IGNORECASE | re.DOTALL
    ):
        rendered = _plain(heading)
        match = re.search(r"\b([A-Z]{2,3}) Realm Economy\b", rendered)
        if match:
            return f"{match.group(1)} Realm Economy"
    return None


def _fetch_text(url: str, timeout: float) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode(
            response.headers.get_content_charset() or "utf-8", "replace"
        )


def _select_current_trade_league(payload: object, trade_realm: str) -> str:
    if not isinstance(payload, dict) or not isinstance(payload.get("result"), list):
        raise RuntimeError("Official trade league response has an unexpected shape")
    permanent = {"standard", "hardcore"}
    candidates: list[str] = []
    for entry in payload["result"]:
        if not isinstance(entry, dict) or entry.get("realm") != trade_realm:
            continue
        league_id = str(entry.get("id") or "").strip()
        folded = league_id.casefold()
        if not league_id or folded in permanent:
            continue
        if folded.startswith("hc ") or folded.startswith("hardcore "):
            continue
        candidates.append(league_id)
    candidates = list(dict.fromkeys(candidates))
    if len(candidates) != 1:
        detail = ", ".join(candidates) if candidates else "none"
        raise RuntimeError(
            "Could not identify exactly one current softcore trade challenge league "
            f"for realm {trade_realm!r} (found: {detail}); pass --league explicitly"
        )
    return candidates[0]


def _current_trade_league(trade_realm: str, timeout: float) -> str:
    payload = json.loads(_fetch_text(TRADE_LEAGUES_URL, timeout))
    return _select_current_trade_league(payload, trade_realm)


def _extract_quotes(page: str) -> tuple[str | None, list[dict[str, object]]]:
    marker = re.search(
        r"<th[^>]*>\s*24h Value\s*</th>\s*<th[^>]*>\s*24h volume traded\s*</th>",
        page,
        re.IGNORECASE,
    )
    if not marker:
        return None, []

    tbody_start = page.find("<tbody", marker.end())
    tbody_start = page.find(">", tbody_start) + 1 if tbody_start >= 0 else -1
    tbody_end = page.find("</tbody>", tbody_start)
    if tbody_start <= 0 or tbody_end < 0:
        return None, []

    rows = re.findall(
        r"<tr[^>]*>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*</tr>",
        page[tbody_start:tbody_end],
        re.IGNORECASE | re.DOTALL,
    )
    result: list[dict[str, object]] = []
    item_name: str | None = None
    for value_cell, volume_cell in rows:
        anchors = re.findall(
            r'<a[^>]+href=["\']Economy_[^"\']+["\'][^>]*>(.*?)</a>',
            value_cell,
            re.IGNORECASE | re.DOTALL,
        )
        amounts = re.findall(r"(?:^|>)\s*([0-9][0-9,.]*)\s*(?=<a)", value_cell)
        if len(anchors) < 2 or len(amounts) < 2:
            rendered = _plain(value_cell)
            numbers = re.findall(r"[0-9][0-9,.]*", rendered)
            if len(anchors) < 2 or len(numbers) < 2:
                continue
            amounts = numbers[:2]

        quote_name = _plain(anchors[0])
        target_name = _plain(anchors[1])
        quote_amount = _number(amounts[0])
        item_amount = _number(amounts[1])
        if quote_amount <= 0 or item_amount <= 0:
            continue
        volume_match = re.search(r"[0-9][0-9,]*", _plain(volume_cell))
        volume = int(volume_match.group(0).replace(",", "")) if volume_match else None
        item_name = item_name or target_name
        result.append(
            {
                "quote": quote_name,
                "quote_amount": quote_amount,
                "item_amount": item_amount,
                "quote_per_item": quote_amount / item_amount,
                "item_per_quote": item_amount / quote_amount,
                "volume_24h": volume,
            }
        )
    return item_name, result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--item", help="Exact PoE2DB item name for the selected locale")
    source.add_argument("--url", help="PoE2DB item URL")
    parser.add_argument("--quote", help="Only return this quote currency")
    parser.add_argument(
        "--league",
        help="Explicit league name; otherwise discover the current challenge league",
    )
    parser.add_argument("--trade-realm", default=DEFAULT_TRADE_REALM)
    parser.add_argument(
        "--source-locale",
        default=DEFAULT_SOURCE_LOCALE,
        help="PoE2DB locale used with --item (default: us)",
    )
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    try:
        url = (
            _item_url(args.item, args.source_locale)
            if args.item
            else _validate_url(args.url)
        )
        source_locale = _locale_from_url(url)
        requested_name = args.item or _name_from_url(url)
        page = _fetch_text(url, args.timeout)
        parsed_name, quotes = _extract_quotes(page)
        if args.quote:
            quotes = [q for q in quotes if str(q["quote"]).casefold() == args.quote.casefold()]
        if not quotes:
            raise RuntimeError("No matching 24h economy rows found on the item page")
        source_market = _market_from_page(page)
        if not source_market:
            raise RuntimeError("PoE2DB page did not identify its Realm Economy market")
        league = args.league or _current_trade_league(args.trade_realm, args.timeout)
        payload = {
            "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
            "game": "poe2",
            "trade_realm": args.trade_realm,
            "league": league,
            "league_attribution": (
                "explicit_override" if args.league else "official_current_trade_league"
            ),
            "league_source": None if args.league else TRADE_LEAGUES_URL,
            "source_market": source_market,
            "source_locale": source_locale,
            "source_league_scope": "not_explicitly_labeled",
            "basis": "PoE2DB 24h aggregate",
            "item": parsed_name or requested_name,
            "source": url,
            "quotes": quotes,
        }
        json.dump(payload, sys.stdout, indent=2 if args.pretty else None, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
