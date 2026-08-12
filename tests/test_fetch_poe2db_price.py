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
    / "fetch_poe2db_price.py"
)
SPEC = importlib.util.spec_from_file_location("fetch_poe2db_price", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MarketMetadataTests(unittest.TestCase):
    def test_selects_current_softcore_challenge_league(self):
        payload = {
            "result": [
                {"id": "Runes of Aldur", "realm": "poe2"},
                {"id": "HC Runes of Aldur", "realm": "poe2"},
                {"id": "Standard", "realm": "poe2"},
                {"id": "Hardcore", "realm": "poe2"},
            ]
        }
        self.assertEqual(
            MODULE._select_current_trade_league(payload, "poe2"),
            "Runes of Aldur",
        )

    def test_future_league_name_requires_no_code_change(self):
        payload = {
            "result": [
                {"id": "Future Challenge", "realm": "poe2"},
                {"id": "HC Future Challenge", "realm": "poe2"},
                {"id": "Standard", "realm": "poe2"},
            ]
        }
        self.assertEqual(
            MODULE._select_current_trade_league(payload, "poe2"),
            "Future Challenge",
        )

    def test_ambiguous_challenge_leagues_require_override(self):
        payload = {
            "result": [
                {"id": "Challenge One", "realm": "poe2"},
                {"id": "Challenge Two", "realm": "poe2"},
            ]
        }
        with self.assertRaisesRegex(RuntimeError, "pass --league explicitly"):
            MODULE._select_current_trade_league(payload, "poe2")

    def test_locale_and_market_are_separate(self):
        self.assertEqual(
            MODULE._locale_from_url("https://poe2db.tw/fr/Divine_Orb"), "fr"
        )
        page = '<a href="Economy">US Realm Economy</a>'
        self.assertEqual(MODULE._market_from_page(page), "US Realm Economy")


if __name__ == "__main__":
    unittest.main()
