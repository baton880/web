# Durable RTK ingress

`POST /api/telemetry/rtk` writes the exact request body to
`runtime/rtk-ingress.sqlite3` before returning `202`. The inbox uses WAL and
`synchronous=FULL`. If that write fails, the endpoint returns `503`; devices must
retain the packet.

The worker processes inbox rows FIFO into the main Prisma database. Temporary
database errors use exponential retry. Malformed JSON and requests whose packets
are all invalid become `permanent`, so one bad request cannot block later rows.
Processed inbox rows are retained for seven days.

The main `RtkTelemetry` table deduplicates on `ingestKey`. New firmware supplies
`packet_id`; legacy packets use a SHA-256 key over canonical packet JSON. The API
accepts one object, an array, or:

```json
{
  "items": [],
  "transport": {
    "delivery_kind": "buffer",
    "buffer_remaining_after_ack": 0
  }
}
```

Apply Prisma migrations before deployment:

```powershell
npx prisma migrate deploy
npx prisma generate
```

Admin status is available at `GET /api/telemetry/rtk/admin/ingest-status` and
includes pending/retry/permanent counts, oldest pending age, and the last inbox
error. Back up both the main database and `runtime/rtk-ingress.sqlite3`.

Recovery scripts are dry-run by default:

```powershell
node scripts/import-rtk-dead-letter.mjs --file=<dead-letter.jsonl> --inbox=<inbox.sqlite3>
node scripts/import-rtk-dead-letter.mjs --file=<dead-letter.jsonl> --inbox=<inbox.sqlite3> --apply

node scripts/repair-rtk-midnight-timestamps.mjs --database=<copy.db>
node scripts/repair-rtk-midnight-timestamps.mjs --database=<copy.db> --backup=<backup.db> --apply
```

Never use `--apply` on the production database without a verified backup and a
review of the dry-run candidate list.
