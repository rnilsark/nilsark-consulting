---
name: cfo-policy
description: Standing finance policy for NILSARK CONSULTING AB — autonomy level, run cadence, payment-urgency thresholds, and anomaly rules. Read this skill at the start of any CFO orchestration run (/cfo-run) before taking action. This is the single place to change "until further notice" behavior.
---

# CFO Standing Policy

This skill is the **one place** where standing finance policy lives. Commands and agents
read it; they do not hardcode these values. Change behavior here, not in the orchestration.

## Autonomy level

```
autonomy_level: instruction-gated
```

The agent's send behavior is governed by **instruction**, not a capability lock. The rules
(until further notice):

- **Fortnox / bookkeeper emails → always DRAFT, never send.** The user spot-checks and sends.
- **Self-notifications → SEND, only to `MY_EMAIL`** (the todo). Sender = receiver.
- **Never send to any other recipient**, never PAY, never do BankID.

To change send behavior (e.g. allow auto-send of the bookkeeper handoff), change the rule
here — this skill is the single source of the policy.

## Cadence

| Cadence | Trigger | Command | Purpose |
|---|---|---|---|
| Heartbeat | weekly or biweekly | `/cfo-run` | collect + classify + match, refresh payments, prepare bookkeeper draft, emit todo |
| Monthly close | near month-end, **after** the bank export is reconciled | `/month-close` | finalize bookkeeper drafts for the period, mark the month closed |

A heartbeat run is always safe to repeat — idempotency is guaranteed by `state.md`
(accounting facts) and `cfo-state.json` (`todo_last_emitted`, `export_status`).

## Payment-urgency thresholds (PAY todo)

- `URGENT` — due within **48 hours** of the run date, **or** already `overdue`.
- `SOON` — due within **7 days**.
- `SCHEDULED` — due later.

Sort the PAY list by due date ascending; render `URGENT` items first regardless of date.
Always show amount, OCR, and bankgiro/plusgiro so payment needs no document lookup.

## Export reminder (EXPORT todo)

Surface an EXPORT item when `cfo-state.json` has `export_status: pending` for the period and
the run date is within the last 5 days of the month **or** there are unreconciled outgoing
bank transactions. The export is a BankID action only the user can do; the agent only reminds.

## Anomaly rules (APPROVE todo — flag inline)

Apply these **deterministic** checks to each document classified in the current run. A hit
is added to the period's `flagged[]` and shown inline on the APPROVE item so the user can
approve without opening the draft unless something is flagged. The checks are deterministic —
no model-judgment anomalies.

1. **New supplier** — supplier not present in any prior month's `state.md` Documents table.
2. **Large amount** — `amount > 10000 SEK` (single document).
3. **Missing payment key** — a `leverantörsfaktura` with no `ocr_number` **and** no `bank_account`.
4. **Non-standard VAT** — effective VAT rate is not one of `25% / 12% / 6% / 0%`.
5. **Currency** — `currency` is not `SEK`.
6. **Suspected duplicate** — same `supplier` + `amount` already booked in the same period.

Each flag renders as a short reason string, e.g. `⚠ new supplier`, `⚠ 14 200 SEK > 10k`,
`⚠ no OCR/bankgiro`.
