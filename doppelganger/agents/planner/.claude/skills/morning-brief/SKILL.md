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

2. **Read both calendars** (one `events list` per calendar — use the `workCalendar` and
   `familyCalendar` IDs from your Settings):
   ```bash
   gws calendar events list --params '{"calendarId":"<workCalendar>","timeMin":"<RFC3339>","timeMax":"<RFC3339>","singleEvents":true,"orderBy":"startTime"}'
   gws calendar events list --params '{"calendarId":"<familyCalendar>","timeMin":"<RFC3339>","timeMax":"<RFC3339>","singleEvents":true,"orderBy":"startTime"}'
   ```

3. **Conflict check across BOTH calendars** (same IDs from your Settings):
   ```bash
   gws calendar freebusy query --json '{"timeMin":"<RFC3339>","timeMax":"<RFC3339>","items":[{"id":"<workCalendar>"},{"id":"<familyCalendar>"}]}'
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

5. **Gratulationer** (om någon firar idag): your context may name celebration dates — birthdays,
   anniversaries (bröllopsdag), namnsdagar, or anything similar. Compare **today's date** to any
   such dates you've been given (match on month+day, ignore the year). For every match, write one
   warm, natural Swedish line — say it however feels right; vary the wording. Examples: "Grattis
   på födelsedagen, Linnea! 🎂", "Grattis på namnsdagen, Edvard!", "Idag är det er bröllopsdag —
   grattis! 🥂".
   - **Ground every congratulation in a date you were actually given.** No matching date in your
     context → no congratulation. **Never guess a namnsdag** — silence beats a grattis on the
     wrong day.

6. **Push the brief to the operator** (only if the prompt has an `## Operator` section with a
   conversationId — otherwise skip; the file from step 4 is still the record). Emit ONE `replies`
   entry to that conversationId: a short Swedish WhatsApp version of the brief — not the full
   markdown. Lead with any gratulationer from step 5, then the day. One merged message, e.g.:

   ```
   God morgon ☀️
   🎂 Grattis på födelsedagen, Linnea!
   Jobb: 09:00 Kundmöte Acme, 13:00 Standup
   Familj: 17:30 Fotboll Vera
   ⚠️ Krock 12:00–13:00: Lunch ↔ Standup
   ```

   Empty day → "Inget inbokat idag." No conflicts → drop the ⚠️ line. No celebrations → drop the
   grattis line.

7. **Write `out.json`** to the path given in the task prompt:
   - `status`: `success` (brief written), `flagged` (brief written but conflicts found —
     mention them in the summary), `error` (could not read the calendars).
   - `summary`: 1–2 sentences in Swedish, e.g. "Brief för 2026-06-11 skriven: 3 jobbhändelser,
     1 familjehändelse, 1 krock 12:00–13:00."
   - `replies`: the operator push from step 6, if any.

## Rules

- Read-only: NEVER create, modify or delete events in this skill.
- Never invent events. gws failure → `status: "error"`, not an empty brief.
- Push **only** to the conversationId given in the `## Operator` section — never anywhere else.
