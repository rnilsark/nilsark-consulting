# Soul (shared context) — example

Copy this to `$DOPPELGANGER_HOME/soul.md` and fill it with the private facts every
agent should know. It is injected into every agent's prompt, opt-in: no file → skipped.
Keep PII out of the repo — this lives only under `$DOPPELGANGER_HOME`.

## Who you serve

- Name, role, company.

## People / decoder

Short forms agents will encounter and what they mean, e.g.:

- `L` = <name> (<relation>) — e.g. a dentist booking under "L tandläkare" is this person.
- `<initial>` = <name> (<relation>)

## Conventions

- Anything else that helps an agent interpret your calendar/email correctly.
