#!/usr/bin/env python3
"""Compare direct purchase with deterministic discrete conversion recipes."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def _positive_map(value: Any, label: str) -> dict[str, float]:
    if not isinstance(value, dict) or not value:
        raise ValueError(f"{label} must be a non-empty object")
    result: dict[str, float] = {}
    for name, quantity in value.items():
        amount = float(quantity)
        if not isinstance(name, str) or not name or amount <= 0:
            raise ValueError(f"{label} contains an invalid item or quantity")
        result[name] = amount
    return result


def _merge(target: dict[str, float], source: dict[str, float]) -> None:
    for key, value in source.items():
        target[key] += value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="JSON input file, or - for stdin")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        spec = json.loads(raw)
        quote = str(spec.get("quote") or "Exalted Orb")
        requirements = _positive_map(spec.get("requirements"), "requirements")
        prices = _positive_map(spec.get("prices"), "prices")

        recipes_by_output: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for index, raw_recipe in enumerate(spec.get("recipes", [])):
            inputs = _positive_map(raw_recipe.get("inputs"), f"recipes[{index}].inputs")
            outputs = _positive_map(raw_recipe.get("outputs"), f"recipes[{index}].outputs")
            if len(outputs) != 1:
                raise ValueError("each recipe must have exactly one output item")
            output_item, output_quantity = next(iter(outputs.items()))
            recipes_by_output[output_item].append(
                {
                    "name": str(raw_recipe.get("name") or f"recipe-{index + 1}"),
                    "inputs": inputs,
                    "output_item": output_item,
                    "output_quantity": output_quantity,
                }
            )

        def plan(item: str, quantity: float, stack: frozenset[str]) -> dict[str, Any] | None:
            if item in stack:
                return None
            candidates: list[dict[str, Any]] = []
            if item in prices:
                candidates.append(
                    {
                        "cost": prices[item] * quantity,
                        "purchases": {item: quantity},
                        "transforms": [],
                    }
                )
            for recipe in recipes_by_output.get(item, []):
                batches = math.ceil((quantity / recipe["output_quantity"]) - 1e-12)
                purchases: dict[str, float] = defaultdict(float)
                transforms: list[dict[str, Any]] = []
                cost = 0.0
                possible = True
                for input_item, input_quantity in recipe["inputs"].items():
                    child = plan(input_item, input_quantity * batches, stack | {item})
                    if child is None:
                        possible = False
                        break
                    cost += child["cost"]
                    _merge(purchases, child["purchases"])
                    transforms.extend(child["transforms"])
                if possible:
                    transforms.append(
                        {
                            "recipe": recipe["name"],
                            "batches": batches,
                            "produces": {item: recipe["output_quantity"] * batches},
                        }
                    )
                    candidates.append(
                        {"cost": cost, "purchases": dict(purchases), "transforms": transforms}
                    )
            return min(candidates, key=lambda candidate: candidate["cost"]) if candidates else None

        direct_total = 0.0
        direct_complete = True
        optimized_total = 0.0
        purchases: dict[str, float] = defaultdict(float)
        transforms: list[dict[str, Any]] = []
        unresolved: list[str] = []

        for item, quantity in requirements.items():
            if item in prices:
                direct_total += prices[item] * quantity
            else:
                direct_complete = False
            chosen = plan(item, quantity, frozenset())
            if chosen is None:
                unresolved.append(item)
                continue
            optimized_total += chosen["cost"]
            _merge(purchases, chosen["purchases"])
            transforms.extend(chosen["transforms"])

        payload = {
            "quote": quote,
            "direct_total": round(direct_total, 8) if direct_complete else None,
            "optimized_total": round(optimized_total, 8) if not unresolved else None,
            "savings": round(direct_total - optimized_total, 8) if direct_complete and not unresolved else None,
            "requirements": requirements,
            "purchases": dict(sorted(purchases.items())),
            "transformations": transforms,
            "unresolved": unresolved,
            "notes": [
                "Recipe batches are discrete and rounded upward.",
                "Incidental excess output is not reused across separate requirements.",
            ],
        }
        json.dump(payload, sys.stdout, indent=2 if args.pretty else None, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
