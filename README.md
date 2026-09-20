# Recurrence Rule Studio

Revision-aware workbench for recurring schedules. Compare two revisions of a rule
inside a time window and stream the occurrence differences (added, removed,
time changed) plus whether existing exceptions still locate their targets under
the new rule.

## Run

```bash
npm install
npm run dev      # API on :4174, Vite dev server on :4173
npm test         # vitest (engine + HTTP/SSE)
npm run build    # tsc --noEmit + vite build
```

## Rule document

`GET/PUT /api/schedules/:id`, revision history at `/api/schedules/:id/revisions`.
A schedule revision stores a JSON rule document:

```json
{
  "timezone": "America/New_York",
  "dstPolicy": "earlier",
  "segments": [
    {"id": "standup", "frequency": "DAILY", "interval": 1, "localTime": "09:00",
     "start": "2026-01-01", "until": "2026-06-30", "count": null,
     "byWeekDay": ["MO", "WE"], "byMonthDay": [1, 15]}
  ],
  "exceptions": [
    {"id": "holiday", "kind": "cancel", "segmentId": "standup", "date": "2026-02-09"},
    {"id": "moved", "kind": "replace", "segmentId": "standup", "date": "2026-01-20",
     "replacement": {"localDate": "2026-01-21", "localTime": "11:00"}},
    {"id": "summer", "kind": "cancelRange", "segmentId": "standup",
     "date": "2026-07-01", "endDate": "2026-08-15"}
  ]
}
```

Each side expands under **its own** timezone and DST policy (`earlier`/`later`
for spring-forward gaps and fall-back overlaps).

## Comparing revisions

```
POST /api/schedules/:id/compare {oldRevision, newRevision, from, to}
  -> 201 {sessionId, streamUrl}        # both revisions pinned at creation
GET  /api/compare/:sessionId/stream     # text/event-stream, resumable via Last-Event-ID
```

SSE events: `start`, `item` (streamed), `exception`, `progress` (partial
counts), `done` (final stats). Counts in `progress` are explicitly partial until
`done`; reconnects replay only events after `Last-Event-ID`.

Occurrences are matched by a **stable source key**, not timestamp set difference:

```
occ|<shape>/p<phase>@<localTime>|<epoch-anchored ordinal>[|<weekday/month slot>]
```

- timezone-only edit keeps the key → every occurrence is `modified` (time change)
- `localTime` edits are relinked when exactly one wall time on the same line
  changed → `modified`; ambiguous multi-line edits are not guessed
- frequency / interval / `by*` changes change the key → `removed` + `added`
- splitting or renaming same-shape segments keeps keys (aligned phase/ordinal)
- exceptions surface `unchanged | retargeted | orphaned | added | removed`; an
  exception whose target date the new cadence no longer generates is `orphaned`

Output order is deterministic (earliest instant on either side, then key), so
repeated runs compare byte-for-byte.
