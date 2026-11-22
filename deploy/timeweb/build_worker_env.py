"""Read Render configuration into a private worker env file on the owner's VPS."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import warnings

SERVICE_ID = "srv-dbgk0st9el5s73d0kaq0"
ACCOUNT_ID = "17841404391195020"


def build_worker_env(source):
    # The worker needs the database and token encryption key, not the frontend
    # administrator key, Meta app secret, SMTP or payment credentials.
    selected = {key: source.get(key, "") for key in (
        "DATABASE_URL", "VETASTART_TOKEN_KEY", "INSTAGRAM_CONFIG_ID", "META_GRAPH_API_VERSION"
    )}
    selected["VETASTART_PG_SCHEMA"] = source.get("VETASTART_PG_SCHEMA") or "vetastart_pilot"
    if len(base64.b64decode(selected["VETASTART_TOKEN_KEY"], validate=True)) != 32:
        raise ValueError("Invalid encryption key")
    if not re.fullmatch(r"\d+", selected["INSTAGRAM_CONFIG_ID"]):
        raise ValueError("Invalid configuration ID")
    if not re.fullmatch(r"v\d+\.\d+", selected["META_GRAPH_API_VERSION"]):
        raise ValueError("Invalid API version")
    if not re.fullmatch(r"vetastart_[a-z0-9_]{1,32}", selected["VETASTART_PG_SCHEMA"]):
        raise ValueError("Invalid schema")
    url = urllib.parse.urlsplit(selected["DATABASE_URL"])
    if url.scheme not in ("postgres", "postgresql") or not url.username or not url.password:
        raise ValueError("Invalid database URL")
    host = url.hostname or ""
    if re.fullmatch(r"dpg-[a-z0-9-]+", host):
        # Existing VetaStart staging PostgreSQL was verified in Virginia.
        host += ".virginia-postgres.render.com"
    if not re.fullmatch(r"dpg-[a-z0-9-]+\.(virginia|oregon|ohio|frankfurt|singapore)-postgres\.render\.com", host):
        raise ValueError("Unexpected database provider")
    authority = url.netloc.rsplit("@", 1)[0] + "@" + host
    if url.port:
        authority += ":" + str(url.port)
    query = [(key, value) for key, value in urllib.parse.parse_qsl(url.query)
             if key.lower() not in ("sslmode", "sslcert", "sslkey", "sslrootcert")]
    selected["DATABASE_URL"] = urllib.parse.urlunsplit((url.scheme, authority, url.path,
                                                        urllib.parse.urlencode(query), ""))
    selected.update({
        "NODE_ENV": "production", "DATABASE_SSL": "true", "INSTAGRAM_LOGIN_MODE": "unified",
        "VETASTART_AUTOMATION_ENABLED": "true", "VETASTART_AUTOMATION_INTERVAL_MS": "10000",
        "VETASTART_API_POLL_ENABLED": "true", "VETASTART_API_POLL_ACCOUNT_ID": ACCOUNT_ID,
        "VETASTART_API_POLL_INTERVAL_MS": "60000", "VETASTART_SEND_ENABLED": "false",
        "VETASTART_MAIL_ENABLED": "false", "VETASTART_SIGNUP_ENABLED": "false",
        "VETASTART_AUTH_DEV_MODE": "false", "ROBOKASSA_ENABLED": "false",
    })
    for value in selected.values():
        if not isinstance(value, str) or "\n" in value or "\r" in value or "\0" in value:
            raise ValueError("Multiline worker variables are not supported")
    return selected


def environment_file(values):
    # systemd EnvironmentFile syntax, never sourced as shell code.
    return "".join(key + '="' + value.replace("\\", "\\\\").replace('"', '\\"') + '"\n'
                   for key, value in sorted(values.items()))


PROBE = r"""
const {Pool}=require('pg');const {unseal}=require('./instagram-auth');
(async()=>{
 const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},
  connectionTimeoutMillis:10000,statement_timeout:5000});
 try{
  const schema=process.env.VETASTART_PG_SCHEMA;
  const result=await db.query('SELECT token_cipher,token_mode,connection_status,expires_at FROM '+schema+
   '.instagram_connections c WHERE account_id=$1 AND NOT EXISTS (SELECT 1 FROM '+schema+
   '.customer_accounts a WHERE a.account_id=c.account_id)',[process.env.VETASTART_API_POLL_ACCOUNT_ID]);
  const row=result.rows[0];
  if(!row||row.token_mode!=='unified'||row.connection_status!=='active'||
   (Number(row.expires_at)!==0&&Number(row.expires_at)<=Date.now())||!unseal(row.token_cipher,process.env))throw new Error();
 }finally{await db.end();}
})().catch(()=>{console.error('Worker database/TLS/connection check failed');process.exitCode=1;});
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    warnings.simplefilter("error", getpass.GetPassWarning)
    key = getpass.getpass("Render API key (ввод скрыт; ключ не сохраняется): ")
    if not key:
        raise ValueError("Render key required")
    request = urllib.request.Request(
        "https://api.render.com/v1/services/" + SERVICE_ID + "/env-vars?limit=100",
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        entries = json.load(response)
    del key, request
    source = {item["envVar"]["key"]: item["envVar"]["value"] for item in entries}
    values = build_worker_env(source)
    del source, entries
    child = {key: value for key, value in os.environ.items()
             if key in ("PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")}
    child.update(values)
    check = subprocess.run([args.node, "-e", PROBE], cwd=args.release, env=child,
                           capture_output=True, text=True, timeout=25)
    if check.returncode:
        raise RuntimeError("Worker database/TLS/connection check failed")
    destination = Path(args.output)
    descriptor, temporary = tempfile.mkstemp(prefix=".worker-env-", dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(environment_file(values))
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Worker configuration saved privately; database TLS and token check passed; sending is OFF.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider exceptions can contain request URLs. Never print credentials.
        print("Worker configuration was not completed. Check Render access and external PostgreSQL connectivity.")
        raise SystemExit(1)
