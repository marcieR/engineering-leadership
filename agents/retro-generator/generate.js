#!/usr/bin/env node
/*
 * Bi-weekly retrospective generator.
 *
 * Fetches the live Retromat activity catalogue (open-source data behind
 * https://retromat.org) and builds a Confluence-ready retro plan: one random
 * activity per phase, each rendered as its own table with a row for every team
 * member and blank cells for them to fill in during the retro.
 *
 * Outputs two files into ./out :
 *   retro-<date>.html  -> open in a browser, select-all, copy, paste into a
 *                         Confluence page. Confluence turns the HTML tables into
 *                         native Confluence tables.
 *   retro-<date>.md    -> markdown fallback.
 *
 * Usage:
 *   node generate.js                 # random plan for today
 *   node generate.js --seed 42       # reproducible plan
 *   node generate.js --team "A,B,C"  # override team list
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_URL =
  'https://raw.githubusercontent.com/findingmarbles/Retromat/master/backend/tests/data/activities_en.js';

const DEFAULT_TEAM = [
  'Andrew', 'Jace', 'Balarka', 'Bakir', 'Leila',
  'Azra', 'Marcie', 'Evan', 'Elvis',
];

// Retromat's five canonical retrospective phases (index === activity.phase).
const PHASES = [
  { n: 0, title: 'Set the Stage',            emoji: '🎬' },
  { n: 1, title: 'Gather Data',              emoji: '📊' },
  { n: 2, title: 'Generate Insights',        emoji: '💡' },
  { n: 3, title: 'Decide What to Do',        emoji: '✅' },
  { n: 4, title: 'Close the Retrospective',  emoji: '🎉' },
];

// Keyword -> emoji palette. First match wins for the title decoration; every
// match contributes to the "pick one" mood/theme row when relevant.
const EMOJI_RULES = [
  { re: /\bsmil(e|es|ies|y)\b|satisfaction|feedback door/i, emojis: ['😀', '🙂', '😐', '🙁', '😞'], pick: true, label: 'Pick the smiley that matches how you feel' },
  { re: /mad sad glad|happiness|\bemotion|\bmood\b/i, emojis: ['😄', '😐', '😢', '😡', '😍'], pick: true, label: 'Pick the face that matches your mood' },
  { re: /\bweather\b|\bstorm\b|\bsunny\b|\bclouds?\b/i, emojis: ['☀️', '⛅', '🌧️', '⛈️', '🌈'], pick: true, label: 'Pick your weather' },
  { re: /temperature|thermometer|freezing|\bhot\b/i,  emojis: ['🥶', '😬', '🙂', '🔥'],       pick: true, label: 'Pick your temperature' },
  { re: /\besvp\b|explorer|shopper|vacationer|prisoner/i, emojis: ['🧭', '🛒', '🏖️', '⛓️'],  pick: true, label: 'Explorer / Shopper / Vacationer / Prisoner?' },
  { re: /sailboat|speedboat|\bboat\b|\banchor\b|\bsails?\b/i, emojis: ['⛵', '⚓', '💨', '🏝️'], pick: false },
  { re: /\bstars?\b|starfish|constellation/i,         emojis: ['⭐', '🌟'],                    pick: false },
  { re: /\benergy\b|batter(y|ies)|\bfuel\b|\btank\b/i, emojis: ['⚡', '🔋'],                   pick: true, label: 'How full is your battery?' },
  { re: /superhero|\bhero\b|superpower/i,             emojis: ['🦸', '💥'],                    pick: false },
  { re: /\bmovie\b|\bfilm\b|movie critic|oscar/i,     emojis: ['🎬', '🍿'],                    pick: false },
  { re: /\bamazon\b|amazon review/i,                  emojis: ['⭐', '📝'],                    pick: false },
  { re: /\btimeline\b|\bjourney\b/i,                  emojis: ['🛣️', '🗓️'],                   pick: false },
  { re: /balloon|helium|hot air/i,                    emojis: ['🎈'],                          pick: false },
  { re: /\bgift\b|appreciat|\bthank/i,                emojis: ['🎁', '🙏'],                    pick: false },
  { re: /dot.?vot/i,                                  emojis: ['🗳️', '📌'],                   pick: false },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { seed: null, team: DEFAULT_TEAM, out: path.join(__dirname, 'out') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--team') args.team = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

// Deterministic PRNG (mulberry32) so --seed gives reproducible plans.
function makeRng(seed) {
  if (seed == null) return Math.random;
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function fetchData(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchData(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

// The data file is JS (`all_activities[i] = {...}`) that references a handful of
// `source_*` variables. We evaluate it in a sandbox with those stubbed out.
function parseActivities(js) {
  const sandbox = { all_activities: [] };
  const sourceStubs = [
    'source_agileRetrospectives', 'source_findingMarbles', 'source_innovationGames',
    'source_judith', 'source_skycoach', 'source_unknown',
  ];
  const preamble = sourceStubs.map((s) => `var ${s} = '';`).join('\n');
  // eslint-disable-next-line no-new-func
  const fn = new Function('all_activities', `${preamble}\n${js}\nreturn all_activities;`);
  const list = fn(sandbox.all_activities);
  return list
    .filter(Boolean)
    .map((a, i) => ({ id: i + 1, ...a }))
    .filter((a) => a.name && typeof a.phase === 'number');
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

function pickPlan(activities, rng) {
  return PHASES.map((phase) => {
    const candidates = activities.filter((a) => a.phase === phase.n);
    const chosen = candidates[Math.floor(rng() * candidates.length)];
    return { phase, activity: chosen };
  });
}

// Strip Retromat's inline HTML into readable plain text (for the .md output and
// for scanning). Keeps list items as bullet lines.
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<li>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|ul|ol|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\\\s*$/gm, '')
    .trim();
}

// Clean Retromat HTML for embedding (keep basic formatting, drop backslash line
// continuations left over from the JS source).
function cleanHtml(html) {
  if (!html) return '';
  return html.replace(/\\\s*\n/g, ' ').replace(/\\\s*$/gm, ' ').trim();
}

function emojiFor(activity) {
  const hay = `${activity.name} ${activity.summary || ''} ${htmlToText(activity.desc)}`;
  const matches = EMOJI_RULES.filter((r) => r.re.test(hay));
  const titleEmoji = matches.length ? matches[0].emojis.slice(0, 2).join('') : '';
  const pick = matches.find((m) => m.pick) || null;
  return { titleEmoji, pick };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function renderHtml(plan, team, dateStr) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const activityBlocks = plan
    .map(({ phase, activity }, idx) => {
      const { titleEmoji, pick } = emojiFor(activity);
      const teamRows = team
        .map(
          (name) =>
            `        <tr><td style="width:22%"><strong>${esc(name)}</strong></td><td>&nbsp;</td></tr>`
        )
        .join('\n');
      const pickRow = pick
        ? `      <p><em>${esc(pick.label)}:</em> ${pick.emojis.join('   ')}</p>`
        : '';
      return `    <h2>${idx + 1}. ${phase.emoji} ${esc(activity.name)} ${titleEmoji}</h2>
      <p><strong>Phase ${phase.n + 1} — ${esc(phase.title)}</strong>${
        activity.duration ? ` &middot; ${esc(activity.duration)}` : ''
      }</p>
      <p><strong>What it's for:</strong> ${esc(activity.summary || '')}</p>
      <blockquote><strong>How to run it:</strong><br>${cleanHtml(activity.desc)}</blockquote>
${pickRow}
      <p><strong>Team responses</strong></p>
      <table style="width:100%">
        <tbody>
        <tr><th style="width:22%">Team member</th><th>Response / notes</th></tr>
${teamRows}
        </tbody>
      </table>
      <hr>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Team Retrospective — ${dateStr}</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; color: #172b4d; line-height: 1.5; }
    h1 { border-bottom: 3px solid #0052cc; padding-bottom: .4rem; }
    h2 { margin-top: 2rem; }
    table { border-collapse: collapse; margin: .5rem 0 1rem; }
    th, td { border: 1px solid #c1c7d0; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f4f5f7; }
    blockquote { background: #f4f5f7; border-left: 4px solid #0052cc; margin: .5rem 0; padding: .6rem 1rem; }
    hr { border: 0; border-top: 1px solid #dfe1e6; margin: 1.5rem 0; }
    .hint { color: #5e6c84; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>🔄 Team Retrospective — ${dateStr}</h1>
  <p class="hint">Generated from <a href="https://retromat.org/en/">Retromat</a>. Select all (Cmd/Ctrl+A), copy, and paste into a Confluence page — the tables come across as native Confluence tables. Fill in your response in the table for each activity.</p>
${activityBlocks}
  <p class="hint">Team: ${team.map(esc).join(', ')}</p>
</body>
</html>`;
}

function renderMarkdown(plan, team, dateStr) {
  const lines = [];
  lines.push(`# 🔄 Team Retrospective — ${dateStr}`);
  lines.push('');
  lines.push('_Generated from [Retromat](https://retromat.org/en/). Paste into Confluence and fill in the response tables._');
  lines.push('');
  plan.forEach(({ phase, activity }, idx) => {
    const { titleEmoji, pick } = emojiFor(activity);
    lines.push(`## ${idx + 1}. ${phase.emoji} ${activity.name} ${titleEmoji}`.trim());
    lines.push('');
    lines.push(`**Phase ${phase.n + 1} — ${phase.title}**${activity.duration ? ` · ${activity.duration}` : ''}`);
    lines.push('');
    lines.push(`**What it's for:** ${activity.summary || ''}`);
    lines.push('');
    lines.push(`**How to run it:** ${htmlToText(activity.desc).replace(/\n/g, ' ')}`);
    lines.push('');
    if (pick) lines.push(`_${pick.label}:_ ${pick.emojis.join('  ')}`);
    lines.push('');
    lines.push('| Team member | Response / notes |');
    lines.push('| --- | --- |');
    team.forEach((name) => lines.push(`| **${name}** |  |`));
    lines.push('');
  });
  lines.push(`_Team: ${team.join(', ')}_`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const rng = makeRng(args.seed);

  let js;
  const cache = path.join(__dirname, 'activities_en.js');
  try {
    js = await fetchData(DATA_URL);
    fs.writeFileSync(cache, js); // refresh local cache on success
  } catch (e) {
    if (fs.existsSync(cache)) {
      console.error(`Fetch failed (${e.message}); using cached data.`);
      js = fs.readFileSync(cache, 'utf8');
    } else {
      throw e;
    }
  }

  const activities = parseActivities(js);
  const plan = pickPlan(activities, rng);
  const dateStr = fmtDate(new Date());

  fs.mkdirSync(args.out, { recursive: true });
  const htmlPath = path.join(args.out, `retro-${dateStr}.html`);
  const mdPath = path.join(args.out, `retro-${dateStr}.md`);
  fs.writeFileSync(htmlPath, renderHtml(plan, args.team, dateStr));
  fs.writeFileSync(mdPath, renderMarkdown(plan, args.team, dateStr));

  console.log(`Retro plan for ${dateStr}:`);
  plan.forEach(({ phase, activity }, i) =>
    console.log(`  ${i + 1}. [${phase.title}] ${activity.name}`)
  );
  console.log(`\nWrote:\n  ${htmlPath}\n  ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
