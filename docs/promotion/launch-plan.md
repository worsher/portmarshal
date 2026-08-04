# PortMarshal launch plan

This plan optimizes for the first useful users and actionable attribution
reports, not a one-day star count.

## Prepared material

- [Show HN submission kit](show-hn.md) — compliant submission fields and a
  human-authorship fact outline
- [Community post drafts](channel-posts.md) — V2EX, Reddit, X/Bluesky, and
  LinkedIn variants
- [Launch reply bank](reply-bank.md) — verified answers to likely technical and
  safety questions
- [Awesome-list submission plan](awesome-prs.md) — current targets, paused
  routes, and PR copy
- [GitHub Social Preview](../social-preview.png) — 1280×640 share image

## Platform copy map

| Platform | Copy file | Notes |
|---|---|---|
| V2EX / 分享创造 | [channel-posts.md — V2EX](channel-posts.md#v2ex--分享创造) | Chinese launch post |
| Reddit / r/ClaudeAI | [channel-posts.md — r/ClaudeAI](channel-posts.md#rclaudeai-showcase) | Recheck the live Showcase rules |
| Reddit / r/commandline | [channel-posts.md — r/commandline](channel-posts.md#rcommandline) | Post only if current self-promotion rules allow it |
| X / Bluesky | [channel-posts.md — X / Bluesky](channel-posts.md#x--bluesky) | Attach the Social Preview when it is clearer than the link card |
| LinkedIn | [channel-posts.md — LinkedIn](channel-posts.md#linkedin) | Longer builder-story version |
| Hacker News / Show HN | [show-hn.md](show-hn.md) | Submission fields plus facts; write the first comment in your own voice |
| awesome-cli-apps / awesome-mac | [awesome-prs.md](awesome-prs.md) | One focused submission at a time |
| Product Hunt | Not prepared yet | Wait for stronger visual assets and user proof |

## Canonical links and claims

- Repository: https://github.com/worsher/portmarshal
- npm: https://www.npmjs.com/package/portmarshal
- Latest published release: https://github.com/worsher/portmarshal/releases/tag/v0.6.0
- Install: `npm install -g portmarshal`
- Platforms: macOS and Linux; Node.js 18.17 or newer
- License: MIT
- Runtime npm dependencies: zero
- Managed-runtime attribution: Docker/Compose containers and PM2 applications,
  with stops delegated to `docker stop` or `pm2 stop`
- Positioning: local dev-server ownership and stop safety for parallel coding
  agents

Do not describe `claim` as a socket reservation or `detached` as proof of an
orphan. Do not claim complete attribution when the OS hides process metadata.

## Recommended order

| Wave | Channel | Goal | Gate |
|---|---|---|---|
| 1 | V2EX / 分享创造 | Chinese developer feedback and macOS/Linux cases | Post at a time when you can reply; do not publish simultaneously with HN |
| 1 | Show HN | Technical feedback from builders | Post after observing the V2EX launch; write the first comment in your own voice and stay available for two hours |
| 2 | r/ClaudeAI Showcase | Reach Claude Code users with the exact multi-session problem | Recheck the live Showcase rules and disclose that you are the author |
| 2 | r/commandline | Reach CLI users interested in process and port tooling | Read the community rules immediately before posting; skip if self-promotion is disallowed |
| 3 | awesome-cli-apps, then awesome-mac | Long-tail discovery | Wait for real usage feedback; send one focused PR at a time |
| Later | Product Hunt | Broader product discovery | Wait for stronger visual assets, user proof, and a meaningful release milestone |

Leave at least a day between community posts. Change the opening and emphasis
for each audience rather than pasting the same announcement everywhere.

## Why Product Hunt is later

PortMarshal is live and eligible as a digital product, but the current launch
package is optimized for GitHub rather than Product Hunt. A strong Product Hunt
draft still needs:

- a square thumbnail (recommended 240×240);
- at least two gallery images (recommended 1270×760) for a visible gallery;
- a short product demo hosted on YouTube or a supported interactive-demo tool;
- at least a few concrete user outcomes or quotations, used with permission.

Product Hunt normally requires a significant update and roughly six months
before relaunching the same product, so using that launch before the visual
assets and user proof are ready would reduce the value of a later v1.0 launch.

## Launch-day checklist

- Confirm `npm install -g portmarshal` installs the version named in the post.
- Open the GitHub repository in a logged-out/private window and verify the
  Social Preview, README demo, npm link, Issues, and latest Release.
- Run the three-command quick start once on the machine used for replies.
- Prepare one real listener to demonstrate `list`, `whois`, and guarded `stop`.
- Publish only one community post.
- Record the post URL and the baseline metrics below.
- Answer every substantive question; turn reproducible defects into GitHub
  issues with OS, command, and expected/actual behavior.

## Measurement sheet

Fill this at publication time so the baseline is not stale.

| Metric | Baseline | 24 hours | 7 days |
|---|---:|---:|---:|
| GitHub stars |  |  |  |
| GitHub forks |  |  |  |
| npm weekly downloads |  |  |  |
| New issues / attribution reports |  |  |  |
| External contributors |  |  |  |

Qualitative signals matter more than raw traffic:

- Did someone reproduce the multi-agent conflict without explanation?
- Which attribution labels were wrong or missing?
- Did anyone integrate `claim` into agent instructions?
- Did the stop guard prevent a real mistaken termination?
- Which objection appeared more than once?

## Stop conditions

Pause the next channel if installation is broken, the README contradicts actual
behavior, a safety issue is reported, or two users reproduce the same
attribution error. Fix and release before resuming promotion.
