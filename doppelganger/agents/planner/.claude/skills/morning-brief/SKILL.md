---
name: morning-brief
description: Write today's morning brief over the work and family calendars, with conflict check. Use when the task is morning_brief. Output is in Swedish.
---

# Morning brief

Produce a morning brief in markdown over **today's** events in both calendars, with a conflict
check. The brief and the `out.json` summary are written in **Swedish**.

## Steps

1. **Today's date and time window** (local time):
   ```bash
   date +%F                      # e.g. 2026-06-11
   date -Iseconds                # for timeMin
   date -Iseconds -d 'tomorrow 00:00'   # for timeMax
   ```
   Use `timeMin` = today 00:00 local time, `timeMax` = tomorrow 00:00 local time, as RFC3339 with offset.

2. **Read both calendars** (one `events list` per calendar):
   ```bash
   gws calendar events list --params '{"calendarId":"work@example.com","timeMin":"<RFC3339>","timeMax":"<RFC3339>","singleEvents":true,"orderBy":"startTime"}'
   gws calendar events list --params '{"calendarId":"family@example.com","timeMin":"<RFC3339>","timeMax":"<RFC3339>","singleEvents":true,"orderBy":"startTime"}'
   ```

3. **Conflict check across BOTH calendars**:
   ```bash
   gws calendar freebusy query --json '{"timeMin":"<RFC3339>","timeMax":"<RFC3339>","items":[{"id":"work@example.com"},{"id":"family@example.com"}]}'
   ```
   Flag every time interval where busy blocks overlap — within one calendar or between them.
   All-day events do not count as conflicts, but are mentioned in the brief.

4. **Write the brief** (in Swedish) to `$DOPPELGANGER_HOME/briefs/YYYY-MM-DD.md` (the directory already exists):

   ```markdown
   # Morgon-brief YYYY-MM-DD

   ## Jobb
   - HH:MM–HH:MM Titel (plats/möteslänk om finns)

   ## Familj
   - HH:MM–HH:MM Titel

   ## ⚠️ Krockar
   - HH:MM–HH:MM: <händelse A> ↔ <händelse B>
   (eller "Inga krockar.")
   ```

   Empty day in one calendar → write "Inget inbokat." under that heading.

5. **Write `out.json`** to the path given in the task prompt:
   - `status`: `success` (brief written), `flagged` (brief written but conflicts found —
     mention them in the summary), `error` (could not read the calendars).
   - `summary`: 1–2 sentences in Swedish, e.g. "Brief för 2026-06-11 skriven: 3 jobbhändelser,
     1 familjehändelse, 1 krock 12:00–13:00."

## Rules

- Read-only: NEVER create, modify or delete events in this skill.
- Never invent events. gws failure → `status: "error"`, not an empty brief.
