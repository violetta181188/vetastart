import base64
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("worker_env", Path(__file__).with_name("build_worker_env.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerEnvironmentTests(unittest.TestCase):
    def source(self):
        return {"DATABASE_URL": "postgresql://fixture:fixture-password@dpg-fixture-a/fixture?sslmode=disable",
                "VETASTART_TOKEN_KEY": base64.b64encode(bytes(32)).decode(),
                "INSTAGRAM_CONFIG_ID": "12", "META_GRAPH_API_VERSION": "v27.0",
                "VETASTART_ADMIN_TOKEN": "must-not-copy-admin", "META_APP_SECRET": "must-not-copy-app",
                "SMTP_PASSWORD": "must-not-copy-mail", "RENDER_API_KEY": "must-not-copy-provider",
                "ROBOKASSA_PASSWORD1": "must-not-copy-payment", "VETASTART_SEND_ENABLED": "true"}

    def test_minimal_credentials_and_sending_disabled(self):
        result = module.build_worker_env(self.source())
        self.assertEqual(result["VETASTART_SEND_ENABLED"], "false")
        self.assertEqual(result["DATABASE_SSL"], "true")
        self.assertIn("dpg-fixture-a.virginia-postgres.render.com", result["DATABASE_URL"])
        self.assertNotIn("sslmode=disable", result["DATABASE_URL"])
        self.assertNotIn("must-not-copy", str(result))

    def test_untrusted_database_destination_and_invalid_values_rejected(self):
        for change in [{"DATABASE_URL": "postgresql://fixture:fixture@other.example/db"},
                       {"VETASTART_TOKEN_KEY": "invalid"}, {"INSTAGRAM_CONFIG_ID": "12\nEVIL=yes"},
                       {"VETASTART_PG_SCHEMA": "other_schema"}, {"META_GRAPH_API_VERSION": "invalid"}]:
            with self.subTest(change=list(change)):
                with self.assertRaises(Exception):
                    module.build_worker_env({**self.source(), **change})

    def test_serialization_is_environment_file_data_not_shell(self):
        text = module.environment_file({"FIXTURE": 'value$literal`literal`"\\'})
        self.assertEqual(text, 'FIXTURE="value$literal`literal`\\"\\\\"\n')


if __name__ == "__main__":
    unittest.main()
