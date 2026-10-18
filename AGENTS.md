# ST memU Extension

Keep README.md for people choosing, installing and using this project. Put durable
working guidance here, code navigation in an existing index, and task history in
the relevant plan or audit; do not turn this file into a session log.

This is the browser UI and saved-chat integration, not ST core. Source is in
`src/`; the sibling server plugin resolves credentials and calls MCP. Do not
patch stock SillyTavern to implement extension behavior.

## Behavior to Preserve

Enabling memU creates the Soul using the character's name. Choose an ST persona
first; its name is stored once for that Soul and the picker then locks. Existing
Souls reuse or create a matching persona and keep its native ST selection,
description, chat lock and sole character connection aligned, even with memU
off. Conflicting native persona controls are disabled for bound Souls; ordinary
ST cards keep their controls. Older dev DBs without a stored name are not
automatically upgraded.

Only locally bound cards may await persona synchronization before native chat
loading. First-use discovery stays in the background; unbound discovery failures
belong in the memU panel, not unsolicited popups.

Relationship drafts stay bound to the chat/card where they were opened. Switching
keeps the draft but disables its Save; close that editor before editing the new
selection. Refreshing the same selection does not discard the draft.

Branches and checkpoints have no memU activity, but retain their owning Soul's
fixed persona. In memU-active main chats, replies use MCP only: a
server error blocks the reply rather than switching APIs. Continue is temporarily
unavailable there; it still works normally with memU off.

Deleting or regenerating a reply only undoes Soul state when that exact reply
came from memU. Plain ST replies made while off leave earlier memU state intact.

Memorize reads plain text from the saved main chat, including the newest saved
reply. Automatic admission runs after saving; the server owns size/sleep gates
and failure pause. Delete publication updates the saved source without starting
paid work. Failed work requires explicit Retry in OpenAlma. Use one active browser
tab per chat; checkpoints and branches never publish to memU.

Manual Memorize first flushes ST's native save. The progress banner observes the
Soul's current run, including after navigation or an ST restart; it is not a
receipt for one chat. Polling outages preserve known progress. Cancel remains
visible as requested until MCP confirms the terminal outcome; a network failure
does not disable another Cancel attempt. Paid failures still require Launcher
Retry rather than automatic re-extraction.

**Narrative Suggestion** — A successful send starts a ten-minute cooldown stored
in localStorage. Reloading does not bypass it; the next render checks whether
the stored deadline has passed.

## Model Mapping

Opening the panel reads the actual server config, including hand edits.
SRMM stays in ST settings and supplies ST replies, Narrative Suggestions and
ST APImw synthesis. Other App Replies and active memory steps can follow SRMM,
ST selected, or a named profile. Named profiles stay independent of other
selections; their own saved updates apply. Source markers stay in ST, not config.
Choosing config.json keeps its existing values and changes only the marker.
Config-backed fields follow hand edits silently. Hand changes to ST-owned values
switch the field to config.json with a red info icon; explicitly choosing
config.json clears that icon. Loading never writes values back. Disabled steps
do not follow source changes.

Advanced Mapping is checked when server step overrides exist. Disabling asks
before removing them and their matching capacities from config.json. ST retains
source choices for re-enabling; config-owned values are not duplicated in ST.
Hiding the controls with Use Claude Code
does not disable or delete mappings. Other OpenAlma App Replies edits the ordinary
shared base connection. Keys are resolved by the plugin, never sent to the page.

## Checks

Extend the relevant `scripts/check-*.cjs` harness. `npm run build` creates the
shipped bundle; source edits alone do not update the running extension. Real
browser turns exercise a different path from direct MCP/dry-run calls.
