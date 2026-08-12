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


def _item_url(item: str) -> str:
    slug = quote(item.strip().replace(" ", "_"), safe="_-'()")
    return f"https://poe2db.tw/us/{slug}"


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"poe2db.tw", "www.poe2db.tw"}:
        raise ValueError("--url must be an https://poe2db.tw item page")
    return url.split("#", 1)[0]


def _name_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return unquote(path.rsplit("/", 1)[-1]).replace("_", " ")


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
    source.add_argument("--item", help="Exact English PoE2DB item name")
    source.add_argument("--url", help="PoE2DB item URL")
    parser.add_argument("--quote", help="Only return this quote currency")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    try:
        url = _item_url(args.item) if args.item else _validate_url(args.url)
        requested_name = args.item or _name_from_url(url)
        request = Request(url, headers={"User-Agent": "Codex-PoE2-Cost-Estimator/1.0"})
        with urlopen(request, timeout=args.timeout) as response:
            page = response.read().decode(response.headers.get_content_charset() or "utf-8", "replace")
        parsed_name, quotes = _extract_quotes(page)
        if args.quote:
            quotes = [q for q in quotes if str(q["quote"]).casefold() == args.quote.casefold()]
        if not quotes:
            raise RuntimeError("No matching 24h economy rows found on the item page")
        payload = {
            "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
            "basis": "PoE2DB 24h aggregate",
            "realm": "US",
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
