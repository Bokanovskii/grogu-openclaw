import copy
import importlib.util
import pathlib
import unittest


path = pathlib.Path(__file__).with_name("protected-policy-helper.py")
spec = importlib.util.spec_from_file_location("protected_policy_helper", path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class FakeCloudflare:
    def __init__(self):
        self.policy = {
            "id": "policy-id",
            "name": "Managed policy",
            "decision": "allow",
            "include": [{"email": {"email": "owner@example.invalid"}}],
            "exclude": [],
            "require": [],
            "precedence": 3,
        }
        self.writes = []
        self.failure = None
        self.after_write = None

    def send(self, method, path, token, payload=None):
        app_path = "/client/v4/accounts/account-id/access/apps/app-id/policies/policy-id"
        reusable_path = "/client/v4/accounts/account-id/access/policies/policy-id"
        expected = reusable_path if method == "PUT" and self.policy.get("reusable") is True else app_path
        if path != expected:
            return {"success": False}
        if token != "synthetic-token":
            raise AssertionError("Unexpected credential")
        if method == "PUT":
            self.writes.append(copy.deepcopy(payload))
            if self.failure != "before":
                self.policy.update(copy.deepcopy(payload))
                if self.after_write:
                    self.after_write(self.policy)
            if self.failure:
                raise OSError("Synthetic disconnected write")
        return {"success": True, "result": copy.deepcopy(self.policy)}


class ProtectedPolicyHelperTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            "accountId": "account-id",
            "appId": "app-id",
            "policyId": "policy-id",
            "policyName": "Managed policy",
            "ownerEmail": "owner@example.invalid",
            "token": "synthetic-token",
        }
        self.cloudflare = FakeCloudflare()

    def sync(self, add=(), remove=()):
        return helper.synchronize(
            self.config, {"revision": 7, "add": list(add), "remove": list(remove)}, self.cloudflare.send
        )

    def test_only_managed_policy_is_updated_and_owner_is_retained(self):
        self.cloudflare.policy["include"].append({"email": {"email": "legacy@example.invalid"}})
        self.assertEqual(self.sync(["member@example.invalid"]), {"revision": 7, "status": "synced"})
        self.assertEqual(
            self.cloudflare.writes[0]["include"],
            [
                {"email": {"email": "legacy@example.invalid"}},
                {"email": {"email": "member@example.invalid"}},
                {"email": {"email": "owner@example.invalid"}},
            ],
        )
        self.assertEqual(self.cloudflare.writes[0]["precedence"], 3)
        self.assertEqual(self.sync(remove=["member@example.invalid"]), {"revision": 7, "status": "synced"})
        self.assertEqual(
            self.cloudflare.writes[-1]["include"],
            [
                {"email": {"email": "legacy@example.invalid"}},
                {"email": {"email": "owner@example.invalid"}},
            ],
        )
        with self.assertRaises(helper.PolicyError):
            self.sync(remove=["owner@example.invalid"])

    def test_uncertain_write_is_read_back_without_retry(self):
        self.cloudflare.failure = "after"
        self.assertEqual(self.sync(["member@example.invalid"]), {"revision": 7, "status": "synced"})
        self.assertEqual(len(self.cloudflare.writes), 1)

        self.cloudflare = FakeCloudflare()
        self.cloudflare.failure = "before"
        self.assertEqual(self.sync(["member@example.invalid"]), {"revision": 7, "status": "unknown"})
        self.assertEqual(len(self.cloudflare.writes), 1)

    def test_refuses_unexpected_rules_or_missing_owner(self):
        self.cloudflare.policy["include"].append({"everyone": {}})
        with self.assertRaises(helper.PolicyError):
            self.sync(["member@example.invalid"])
        self.assertEqual(self.cloudflare.writes, [])
        self.cloudflare.policy["include"] = [{"email": {"email": "other@example.invalid"}}]
        with self.assertRaises(helper.PolicyError):
            self.sync()
        self.assertEqual(self.cloudflare.writes, [])

    def test_reusable_policy_updates_only_account_policy_without_precedence(self):
        self.cloudflare.policy.update(reusable=True, app_count=1, uid="policy-id")
        self.assertEqual(self.sync(["member@example.invalid"]), {"revision": 7, "status": "synced"})
        self.assertNotIn("precedence", self.cloudflare.writes[0])
        self.assertEqual(self.cloudflare.policy["precedence"], 3)

    def test_reusable_policy_rejects_wrong_target_or_consumer_count(self):
        for field, value in (("app_count", 0), ("app_count", 2), ("app_count", True),
                             ("app_count", None), ("id", "other"), ("name", "other"),
                             ("decision", "deny")):
            with self.subTest(field=field, value=value):
                self.cloudflare = FakeCloudflare()
                self.cloudflare.policy.update(reusable=True, app_count=1, uid="policy-id")
                self.cloudflare.policy[field] = value
                with self.assertRaises(helper.PolicyError):
                    self.sync(["member@example.invalid"])
                self.assertEqual(self.cloudflare.writes, [])
        self.cloudflare = FakeCloudflare()
        self.cloudflare.policy.update(reusable=True, app_count=1, uid="policy-id")
        self.config["appId"] = "other-app"
        with self.assertRaises(helper.PolicyError):
            self.sync(["member@example.invalid"])
        self.assertEqual(self.cloudflare.writes, [])

    def test_reusable_policy_reports_unknown_when_readback_is_unsafe_or_mismatched(self):
        for field, value in (("app_count", 2), ("reusable", False),
                             ("include", [{"email": {"email": "owner@example.invalid"}}])):
            with self.subTest(field=field):
                self.cloudflare = FakeCloudflare()
                self.cloudflare.policy.update(reusable=True, app_count=1, uid="policy-id")
                self.cloudflare.after_write = lambda policy: policy.update({field: value})
                self.assertEqual(self.sync(["member@example.invalid"]), {"revision": 7, "status": "unknown"})
                self.assertEqual(len(self.cloudflare.writes), 1)


if __name__ == "__main__":
    unittest.main()
