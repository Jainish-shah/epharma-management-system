"""Re-encrypt stored medical records under the current encryption key.

Rotating a key is a three-step operation:

    1. move the existing secret into EPHARMA_ENC_KEY_OLD
    2. set EPHARMA_ENC_KEY to the new secret, and deploy
       (at this point new writes use the new key; existing rows still open with the old one)
    3. run this command, then remove EPHARMA_ENC_KEY_OLD

    python manage.py rotate_encryption_key            # re-encrypt
    python manage.py rotate_encryption_key --dry-run  # just report what would change

Only rows that the current key cannot already read are touched, so the command is safe to re-run
and safe to interrupt — it simply continues where it left off.
"""
from django.core.management.base import BaseCommand

from api import crypto, db

# (table, column) pairs holding encrypted values.
ENCRYPTED_COLUMNS = [
    ("prescriptions", "content"),
    ("messages", "body"),
    ("users", "documents"),
]


class Command(BaseCommand):
    help = "Re-encrypt data that is still protected by a retired encryption key."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="report without writing changes")

    def handle(self, *args, **options):
        dry = options["dry_run"]
        total = 0

        for table, column in ENCRYPTED_COLUMNS:
            rows = db.query(f"SELECT id, {column} AS value FROM {table} WHERE {column} IS NOT NULL")
            stale = [r for r in rows if crypto.needs_rotation(r["value"])]

            for r in stale:
                if not dry:
                    plaintext = crypto.decrypt(r["value"])
                    if plaintext == r["value"]:
                        # Could not be read with the current key OR any retired key — leave it
                        # alone and report it, rather than destroying data we cannot recover.
                        self.stderr.write(f"  ! {table}#{r['id']} unreadable with the configured keys — skipped")
                        continue
                    db.run(f"UPDATE {table} SET {column} = ? WHERE id = ?", (crypto.encrypt(plaintext), r["id"]))
                total += 1

            self.stdout.write(f"{table}.{column}: {len(stale)} of {len(rows)} row(s) need re-encryption")

        verb = "would be re-encrypted" if dry else "re-encrypted"
        self.stdout.write(self.style.SUCCESS(f"{total} row(s) {verb}."))
        if total and not dry:
            self.stdout.write("Rotation complete — EPHARMA_ENC_KEY_OLD can now be removed.")
