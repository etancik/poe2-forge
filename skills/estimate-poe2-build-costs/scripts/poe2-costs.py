#!/usr/bin/env python3
"""Batch PoE2 acquisition prices with bounded stdout and machine-only artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


sys.dont_write_bytecode = True
MAX_PACKET_BYTES = 2600
LARGE_WORK_LIMIT = 40
CONFIDENCE_ORDER = {"unknown": 0, "low": 1, "medium": 2, "high": 3}


def _load_price_source():
    source = Path(__file__).with_name("fetch_poe2db_price.py")
    spec = importlib.util.spec_from_file_location("poe2db_price_source", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load PoE2DB price source")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PRICE_SOURCE = _load_price_source()


def _number(value: Any, label: str, *, allow_zero: bool = True) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be numeric") from exc
    if result < 0 or (not allow_zero and result == 0):
        raise ValueError(f"{label} must be {'positive' if not allow_zero else 'non-negative'}")
    return result


def _read_json(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Input must be a JSON object")
    return data


def _safe_output(path_text: str) -> Path:
    output = Path(path_text).resolve()
    root = Path.cwd().resolve()
    if root not in output.parents:
        raise ValueError("Output artifact must stay below the current working directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def _normalize_candidates(spec: dict[str, Any]) -> list[dict[str, Any]]:
    raw_candidates = spec.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise ValueError("candidates must be a non-empty array")
    seen: set[str] = set()
    candidates = []
    for index, raw in enumerate(raw_candidates):
        if not isinstance(raw, dict):
            raise ValueError(f"candidates[{index}] must be an object")
        candidate_id = str(raw.get("candidate_id") or "").strip()
        if not candidate_id or candidate_id in seen:
            raise ValueError(f"candidates[{index}].candidate_id must be unique")
        seen.add(candidate_id)
        requirements = raw.get("requirements", [])
        if not isinstance(requirements, list):
            raise ValueError(f"candidates[{index}].requirements must be an array")
        normalized = []
        for req_index, requirement in enumerate(requirements):
            if not isinstance(requirement, dict):
                raise ValueError(
                    f"candidates[{index}].requirements[{req_index}] must be an object"
                )
            name = str(requirement.get("name") or "").strip()
            if not name:
                raise ValueError(
                    f"candidates[{index}].requirements[{req_index}].name is required"
                )
            quantity = _number(requirement.get("quantity", 1), f"{name}.quantity")
            owned = _number(requirement.get("owned", 0), f"{name}.owned")
            pricing = str(requirement.get("pricing") or "manual").lower()
            if pricing not in {"exchange", "observed", "manual", "none"}:
                raise ValueError(f"{name}.pricing is not supported: {pricing}")
            normalized.append(
                {
                    **requirement,
                    "name": name,
                    "quantity": quantity,
                    "owned": owned,
                    "net_quantity": max(0.0, quantity - owned),
                    "pricing": pricing,
                }
            )
        candidates.append(
            {"candidate_id": candidate_id, "label": raw.get("label"), "requirements": normalized}
        )
    return candidates


def _default_league_loader(trade_realm: str, timeout: float) -> str:
    return PRICE_SOURCE._current_trade_league(trade_realm, timeout)


def _default_quote_loader(
    requirement: dict[str, Any], quote: str, locale: str, timeout: float
) -> dict[str, Any]:
    url = requirement.get("url") or PRICE_SOURCE._item_url(requirement["name"], locale)
    url = PRICE_SOURCE._validate_url(str(url))
    page = PRICE_SOURCE._fetch_text(url, timeout)
    _, quotes = PRICE_SOURCE._extract_quotes(page)
    matches = [entry for entry in quotes if str(entry["quote"]).casefold() == quote.casefold()]
    if not matches:
        raise RuntimeError(f"No {quote} quote found for {requirement['name']}")
    market = PRICE_SOURCE._market_from_page(page)
    if not market:
        raise RuntimeError(f"PoE2DB did not identify the market for {requirement['name']}")
    selected = max(matches, key=lambda entry: int(entry.get("volume_24h") or 0))
    return {
        "unit_price": float(selected["quote_per_item"]),
        "range": [float(selected["quote_per_item"]), float(selected["quote_per_item"])],
        "confidence": "high" if selected.get("volume_24h") else "medium",
        "volume_24h": selected.get("volume_24h"),
        "source": url,
        "source_market": market,
        "source_locale": PRICE_SOURCE._locale_from_url(url),
        "source_league_scope": "not_explicitly_labeled",
    }


def _minimum_confidence(values: list[str]) -> str:
    if not values:
        return "high"
    return min(values, key=lambda value: CONFIDENCE_ORDER.get(value, 0))


def run_batch(
    spec: dict[str, Any],
    *,
    quote_loader: Callable[[dict[str, Any], str, str, float], dict[str, Any]] = _default_quote_loader,
    league_loader: Callable[[str, float], str] = _default_league_loader,
    timeout: float = 20.0,
) -> dict[str, Any]:
    candidates = _normalize_candidates(spec)
    snapshot = spec.get("snapshot") or {}
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be an object")
    trade_realm = str(snapshot.get("trade_realm") or "poe2")
    locale = str(snapshot.get("source_locale") or "us")
    quote = str(snapshot.get("quote") or "Exalted Orb")

    exchange_keys = {
        (requirement.get("url") or requirement["name"], quote, locale)
        for candidate in candidates
        for requirement in candidate["requirements"]
        if requirement["net_quantity"] > 0 and requirement["pricing"] == "exchange"
    }
    if (
        len(candidates) > LARGE_WORK_LIMIT or len(exchange_keys) > LARGE_WORK_LIMIT
    ) and spec.get("approved") is not True:
        raise ValueError(
            "More than 40 candidates or distinct exchange queries requires approved: true"
        )

    has_market_acquisition = any(
        requirement["net_quantity"] > 0 and requirement["pricing"] != "none"
        for candidate in candidates
        for requirement in candidate["requirements"]
    )
    explicit_league = str(snapshot.get("league") or "").strip() or None
    if has_market_acquisition:
        league = explicit_league or league_loader(trade_realm, timeout)
        league_attribution = (
            "explicit_override" if explicit_league else "official_current_trade_league"
        )
        league_source = None if explicit_league else PRICE_SOURCE.TRADE_LEAGUES_URL
    else:
        league = explicit_league
        league_attribution = "not_queried_no_market_acquisition"
        league_source = None

    cache: dict[tuple[Any, ...], dict[str, Any]] = {}
    sources: set[str] = set()
    markets: set[str] = set()
    market_locales: set[str] = set()
    league_scopes: set[str] = set()
    results = []

    for candidate in candidates:
        subtotal = 0.0
        low_total = 0.0
        high_total = 0.0
        confidences: list[str] = []
        unpriced = []
        requirements = []
        for requirement in candidate["requirements"]:
            net = requirement["net_quantity"]
            entry = {
                "name": requirement["name"],
                "quantity": requirement["quantity"],
                "owned": requirement["owned"],
                "net_quantity": net,
                "pricing": requirement["pricing"],
                "mandatory": requirement.get("mandatory", []),
                "optional": requirement.get("optional", []),
            }
            if net == 0:
                entry.update({"status": "owned", "cost": 0.0})
            elif requirement["pricing"] == "none":
                entry.update({"status": "no_trade_cost", "cost": 0.0})
            elif requirement["pricing"] == "manual":
                entry.update({"status": "unpriced", "cost": None})
                unpriced.append({"name": requirement["name"], "reason": "manual_research"})
            else:
                try:
                    if requirement["pricing"] == "observed":
                        unit_price = _number(
                            requirement.get("unit_price"),
                            f"{requirement['name']}.unit_price",
                        )
                        raw_range = requirement.get("range", [unit_price, unit_price])
                        if not isinstance(raw_range, list) or len(raw_range) != 2:
                            raise ValueError(f"{requirement['name']}.range must contain two values")
                        quote_result = {
                            "unit_price": unit_price,
                            "range": [
                                _number(raw_range[0], f"{requirement['name']}.range[0]"),
                                _number(raw_range[1], f"{requirement['name']}.range[1]"),
                            ],
                            "confidence": str(requirement.get("confidence") or "unknown"),
                            "source": requirement.get("source"),
                            "source_market": requirement.get("source_market"),
                            "source_locale": requirement.get("source_locale"),
                            "source_league_scope": requirement.get("source_league_scope"),
                        }
                    else:
                        key = (requirement.get("url") or requirement["name"], quote, locale)
                        if key not in cache:
                            cache[key] = quote_loader(requirement, quote, locale, timeout)
                        quote_result = cache[key]
                    unit_price = float(quote_result["unit_price"])
                    raw_range = quote_result.get("range", [unit_price, unit_price])
                    cost = unit_price * net
                    low = float(raw_range[0]) * net
                    high = float(raw_range[1]) * net
                    confidence = str(quote_result.get("confidence") or "unknown")
                    if confidence not in CONFIDENCE_ORDER:
                        raise ValueError(f"Unsupported confidence: {confidence}")
                    subtotal += cost
                    low_total += low
                    high_total += high
                    confidences.append(confidence)
                    entry.update(
                        {
                            "status": "priced",
                            "unit_price": unit_price,
                            "cost": cost,
                            "range": [low, high],
                            "confidence": confidence,
                        }
                    )
                    for field, target in [
                        ("source", sources),
                        ("source_market", markets),
                        ("source_locale", market_locales),
                        ("source_league_scope", league_scopes),
                    ]:
                        value = quote_result.get(field)
                        if value:
                            target.add(str(value))
                except Exception as exc:
                    entry.update({"status": "unpriced", "cost": None})
                    unpriced.append(
                        {"name": requirement["name"], "reason": str(exc)[:240]}
                    )
            requirements.append(entry)
        complete = not unpriced
        results.append(
            {
                "candidate_id": candidate["candidate_id"],
                "label": candidate.get("label"),
                "priced_subtotal": round(subtotal, 8),
                "direct_total": round(subtotal, 8) if complete else None,
                "range": [round(low_total, 8), round(high_total, 8)] if complete else None,
                "confidence": _minimum_confidence(confidences) if complete else "unknown",
                "requirements": requirements,
                "unpriced": unpriced,
            }
        )

    if len(markets) > 1:
        raise RuntimeError(f"Batch crossed multiple source markets: {sorted(markets)}")
    if len(market_locales) > 1:
        raise RuntimeError(f"Batch crossed multiple source locales: {sorted(market_locales)}")
    if len(league_scopes) > 1:
        raise RuntimeError(f"Batch mixed source league scopes: {sorted(league_scopes)}")
    return {
        "ok": True,
        "kind": "cost_batch",
        "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
        "snapshot": {
            "game": "poe2",
            "trade_realm": trade_realm,
            "league": league,
            "league_attribution": league_attribution,
            "league_source": league_source,
            "source_market": next(iter(markets), None),
            "source_locale": next(iter(market_locales), locale),
            "source_league_scope": next(iter(league_scopes), None),
            "quote": quote,
        },
        "candidate_count": len(results),
        "unique_exchange_queries": len(cache),
        "candidates": results,
        "sources": sorted(sources),
    }


def _batch_packet(artifact: dict[str, Any], artifact_path: str) -> dict[str, Any]:
    summaries = [
        {
            "id": candidate["candidate_id"],
            "total": candidate["direct_total"],
            "range": candidate["range"],
            "confidence": candidate["confidence"],
            "unpriced": len(candidate["unpriced"]),
        }
        for candidate in artifact.get("candidates", [])
    ]
    packet = {
        "ok": True,
        "command": "batch",
        "snapshot": artifact.get("snapshot"),
        "candidate_count": len(summaries),
        "candidates": summaries[:12],
        "omitted": max(0, len(summaries) - 12),
        "artifact": artifact_path,
    }
    while len(json.dumps(packet, ensure_ascii=False).encode("utf-8")) > MAX_PACKET_BYTES and packet["candidates"]:
        packet["candidates"].pop()
        packet["omitted"] += 1
    return packet


def _candidate_packet(candidate: dict[str, Any]) -> dict[str, Any]:
    requirements = [
        {
            "name": entry.get("name"),
            "net": entry.get("net_quantity"),
            "status": entry.get("status"),
            "cost": entry.get("cost"),
            "confidence": entry.get("confidence"),
        }
        for entry in candidate.get("requirements", [])
    ]
    unpriced = list(candidate.get("unpriced", []))
    packet = {
        "ok": True,
        "command": "report",
        "candidate": {
            "id": candidate.get("candidate_id"),
            "label": candidate.get("label"),
            "total": candidate.get("direct_total"),
            "priced_subtotal": candidate.get("priced_subtotal"),
            "range": candidate.get("range"),
            "confidence": candidate.get("confidence"),
            "requirements": requirements[:12],
            "requirements_omitted": max(0, len(requirements) - 12),
            "unpriced": unpriced[:8],
            "unpriced_omitted": max(0, len(unpriced) - 8),
        },
    }
    selected = packet["candidate"]
    while len(json.dumps(packet, ensure_ascii=False).encode("utf-8")) > MAX_PACKET_BYTES:
        if selected["requirements"]:
            selected["requirements"].pop()
            selected["requirements_omitted"] += 1
        elif selected["unpriced"]:
            selected["unpriced"].pop()
            selected["unpriced_omitted"] += 1
        else:
            break
    return packet


def _emit(payload: dict[str, Any], mode: str) -> None:
    if mode == "silent":
        return
    if mode == "debug":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def _run_optimize(input_path: str) -> dict[str, Any]:
    script = Path(__file__).with_name("optimize_acquisition.py")
    completed = subprocess.run(
        [sys.executable, str(script), "--input", str(Path(input_path).resolve())],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip()[:500])
    payload = json.loads(completed.stdout)
    return {
        "ok": True,
        "kind": "acquisition_optimization",
        "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
        **payload,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    batch = subparsers.add_parser("batch", help="Price alternative candidates once")
    batch.add_argument("--input", required=True)
    batch.add_argument("--output", required=True)
    batch.add_argument("--stdout-mode", choices=["packet", "silent", "debug"], default="packet")
    batch.add_argument("--timeout", type=float, default=20.0)
    optimize = subparsers.add_parser("optimize", help="Compare verified acquisition recipes")
    optimize.add_argument("--input", required=True)
    optimize.add_argument("--output", required=True)
    optimize.add_argument("--stdout-mode", choices=["packet", "silent", "debug"], default="packet")
    report = subparsers.add_parser("report", help="Read one bounded result from an artifact")
    report.add_argument("--input", required=True)
    report.add_argument("--candidate")
    report.add_argument("--stdout-mode", choices=["packet", "silent", "debug"], default="packet")
    args = parser.parse_args()

    if args.command == "batch":
        output = _safe_output(args.output)
        artifact = run_batch(_read_json(args.input), timeout=args.timeout)
        _write_json(output, artifact)
        _emit(artifact if args.stdout_mode == "debug" else _batch_packet(artifact, str(output)), args.stdout_mode)
    elif args.command == "optimize":
        output = _safe_output(args.output)
        artifact = _run_optimize(args.input)
        _write_json(output, artifact)
        packet = {
            "ok": True,
            "command": "optimize",
            "direct_total": artifact.get("direct_total"),
            "optimized_total": artifact.get("optimized_total"),
            "savings": artifact.get("savings"),
            "unresolved": len(artifact.get("unresolved", [])),
            "artifact": str(output),
        }
        _emit(artifact if args.stdout_mode == "debug" else packet, args.stdout_mode)
    else:
        artifact = _read_json(args.input)
        if args.stdout_mode == "debug":
            _emit(artifact, "debug")
        elif artifact.get("kind") == "cost_batch":
            if args.candidate:
                match = next(
                    (entry for entry in artifact.get("candidates", []) if entry.get("candidate_id") == args.candidate),
                    None,
                )
                if match is None:
                    raise ValueError(f"Candidate not found: {args.candidate}")
                _emit(_candidate_packet(match), args.stdout_mode)
            else:
                _emit(_batch_packet(artifact, str(Path(args.input).resolve())), args.stdout_mode)
        else:
            packet = {
                "ok": True,
                "command": "report",
                "kind": artifact.get("kind"),
                "direct_total": artifact.get("direct_total"),
                "optimized_total": artifact.get("optimized_total"),
                "unresolved": len(artifact.get("unresolved", [])),
            }
            _emit(packet, args.stdout_mode)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:500]}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
