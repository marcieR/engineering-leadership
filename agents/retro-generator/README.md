# Bi-weekly Retrospective Generator

An agent that, **every other Monday**, builds a fresh retrospective plan from
[Retromat](https://retromat.org/en/) and delivers a Confluence-ready document to
Marcie in Slack. Each retro activity gets its own table with a row for every
team member and blank cells for their responses, plus a plain-language
description and context-appropriate emoji (e.g. a row of smilies to pick from
for mood/feedback activities).

- **First run:** Monday, July 27, 2026
- **Cadence:** every other Monday (bi-weekly)
- **Delivery:** Slack message to Marcie
- **Team:** Andrew, Jace, Balarka, Bakir, Leila, Azra, Marcie, Evan, Elvis

## What it produces

A random Retromat plan — one activity for each of the five retro phases:

1. 🎬 Set the Stage
2. 📊 Gather Data
3. 💡 Generate Insights
4. ✅ Decide What to Do
5. 🎉 Close the Retrospective

For every activity the document contains the **title**, a **"What it's for"**
summary, **"How to run it"** instructions, appropriate **emoji**, and a
**response table** with one row per team member.

## Running it manually

```bash
cd agents/retro-generator
node generate.js                 # random plan for today
node generate.js --seed 42       # reproducible plan (same seed => same plan)
node generate.js --team "A,B,C"  # override the team list
```

Outputs land in `agents/retro-generator/out/`:

- `retro-<date>.html` — open in a browser, **select all → copy → paste into a
  Confluence page**. The HTML tables become native Confluence tables.
- `retro-<date>.md` — markdown version (this is what gets sent to Slack).

The activity catalogue is fetched live from the open-source Retromat data on
each run and cached to `activities_en.js` as an offline fallback.

## How the schedule works

Cron can't express "every other week" directly, so the routine fires **every**
Monday morning and the agent checks the week's parity against the anchor date
(2026-07-27). On "off" weeks it exits without sending anything. See the routine
prompt for the exact logic.

To change cadence, team, delivery, or timing, edit the scheduled routine
(managed via the `/schedule` skill) or this generator.
