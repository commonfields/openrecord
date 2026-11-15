# Roadmap (current; max 3 active milestones)

Updated 2026-11-15. Product and UI work happens in the macOS app
(`apps/desktop`, Rust + Rune). The web app (`apps/web`) keeps working against
the same API but gets no new UI unless asked for by name.

1. The agent does the work from a website and a goal. The person gives only
   the URL and what they want in the chat; the agent drafts, edits and, with
   approval, publishes. In place: artifacts in tabs beside the chat and edited
   from it, steering a running turn, blanks the agent asks about. Not yet
   dependable end to end; making it so comes before anything else. Next:
   putting an approved artifact live on a connected site from the chat.
2. Close the dogfood loop. Run OpenRecord on OpenRecord from the desktop app,
   end to end, then decide whether to restart the paid-pilot plan below.
3. Ship the desktop app, only once 1 and 2 hold up. The Desktop workflow
   already builds a disk image; the first `desktop-v0.1.0` tag, Developer ID
   signing and notarization wait until the product is usable.

Paused, not dropped (the roadmap of 2026-10-07): the first 3 paid pilots
($750 audit offer, 3 to 5 companies with 20 to 30 problems each) and the
intervention corpus V1 that depended on them.

Everything else: BACKLOG (before/after compare, matcher study,
portfolio/agency UI, billing/teams, SOC2, additional providers, Truth Delivery
scope decision, website fix-or-remove, positioning model) or FROZEN (Jev
productization, browser crawling, autonomous remediation without approval,
scores) until customer evidence reactivates it.
