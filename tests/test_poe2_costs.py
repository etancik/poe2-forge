import importlib.util
import pathlib
import sys
import unittest


sys.dont_write_bytecode = True
SCRIPT = (
    pathlib.Path(__file__).parents[1]
    / "skills"
    / "estimate-poe2-build-costs"
    / "scripts"
    / "poe2-costs.py"
)
SPEC = importlib.util.spec_from_file_location("poe2_costs", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def exchange_quote(requirement, quote, locale, timeout):
    return {
        "unit_price": 10,
        "range": [9, 11],
        "confidence": "high",
        "volume_24h": 100,
        "source": f"https://example.test/{requirement['name']}",
        "source_market": "US Realm Economy",
        "source_locale": locale,
        "source_league_scope": "not_explicitly_labeled",
    }


class CostBatchTests(unittest.TestCase):
    def test_alternative_candidates_remain_separate_and_quotes_are_deduplicated(self):
        calls = []

        def loader(requirement, quote, locale, timeout):
            calls.append(requirement["name"])
            return exchange_quote(requirement, quote, locale, timeout)

        result = MODULE.run_batch(
            {
                "candidates": [
                    {
                        "candidate_id": "a",
                        "requirements": [
                            {"name": "Shared", "quantity": 1, "pricing": "exchange"}
                        ],
                    },
                    {
                        "candidate_id": "b",
                        "requirements": [
                            {"name": "Shared", "quantity": 2, "pricing": "exchange"}
                        ],
                    },
                ]
            },
            quote_loader=loader,
            league_loader=lambda realm, timeout: "Future League",
        )
        self.assertEqual(calls, ["Shared"])
        self.assertEqual([entry["direct_total"] for entry in result["candidates"]], [10, 20])
        self.assertEqual(result["unique_exchange_queries"], 1)
        self.assertEqual(result["snapshot"]["league"], "Future League")

    def test_owned_and_no_trade_cost_batch_skips_market_lookup(self):
        def forbidden(*args):
            raise AssertionError("market lookup should not run")

        result = MODULE.run_batch(
            {
                "candidates": [
                    {
                        "candidate_id": "passive",
                        "requirements": [
                            {"name": "Passive respec", "pricing": "none"},
                            {
                                "name": "Owned gem",
                                "quantity": 1,
                                "owned": 1,
                                "pricing": "exchange",
                            },
                        ],
                    }
                ]
            },
            quote_loader=forbidden,
            league_loader=forbidden,
        )
        self.assertEqual(result["candidates"][0]["direct_total"], 0)
        self.assertEqual(
            result["snapshot"]["league_attribution"],
            "not_queried_no_market_acquisition",
        )

    def test_unknown_manual_component_never_becomes_zero(self):
        result = MODULE.run_batch(
            {
                "snapshot": {"league": "Explicit League"},
                "candidates": [
                    {
                        "candidate_id": "rare",
                        "requirements": [{"name": "Rare boots", "pricing": "manual"}],
                    }
                ],
            }
        )
        candidate = result["candidates"][0]
        self.assertIsNone(candidate["direct_total"])
        self.assertEqual(candidate["priced_subtotal"], 0)
        self.assertEqual(candidate["unpriced"][0]["reason"], "manual_research")

    def test_large_batch_requires_approval(self):
        candidates = [
            {"candidate_id": str(index), "requirements": []}
            for index in range(MODULE.LARGE_WORK_LIMIT + 1)
        ]
        with self.assertRaisesRegex(ValueError, "approved: true"):
            MODULE.run_batch({"candidates": candidates})

    def test_packet_is_bounded(self):
        artifact = {
            "snapshot": {"league": "League"},
            "candidates": [
                {
                    "candidate_id": "x" * 300,
                    "direct_total": index,
                    "range": [index, index],
                    "confidence": "high",
                    "unpriced": [],
                }
                for index in range(40)
            ],
        }
        packet = MODULE._batch_packet(artifact, "artifact.json")
        encoded = __import__("json").dumps(packet, ensure_ascii=False).encode("utf-8")
        self.assertLessEqual(len(encoded), MODULE.MAX_PACKET_BYTES)
        self.assertGreater(packet["omitted"], 0)

    def test_candidate_report_packet_is_bounded(self):
        candidate = {
            "candidate_id": "large",
            "direct_total": None,
            "priced_subtotal": 0,
            "range": None,
            "confidence": "unknown",
            "requirements": [
                {
                    "name": "x" * 300,
                    "net_quantity": 1,
                    "status": "unpriced",
                    "cost": None,
                }
                for _ in range(40)
            ],
            "unpriced": [{"name": "x" * 300, "reason": "manual"} for _ in range(40)],
        }
        packet = MODULE._candidate_packet(candidate)
        encoded = __import__("json").dumps(packet, ensure_ascii=False).encode("utf-8")
        self.assertLessEqual(len(encoded), MODULE.MAX_PACKET_BYTES)
        self.assertGreater(packet["candidate"]["requirements_omitted"], 0)


if __name__ == "__main__":
    unittest.main()
