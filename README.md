<div align="center">

Choose memU per character. Existing Souls default to on; other characters stay
off until enabled. Turning it off keeps the Soul and its memories. Re-enabling
can memorize the main chat's added messages, including replies from ST's API.

For any issues or suggestions, please contact mekineer@gmail.com.

REQUIRES:<br>
https://github.com/mekineer-com/memu-sillytavern-plugin/<br>
https://github.com/mekineer-com/mcp-memu-server/<br>
[https://github.com/mekineer-com/memU/](https://github.com/mekineer-com/memU/)<br>
Can be run on Python 3.12 by changing versions in the memU config files including pyproject.toml.<br>
Compatibility includes Alpine 3.23.

Community fork (unofficial).<br>
Part of [OpenAlma](https://github.com/mekineer-com/OpenAlma); project-wide questions and ideas belong in [OpenAlma Discussions](https://github.com/mekineer-com/OpenAlma/discussions).<br>
Upstream: (https://github.com/NevaMind-AI/memu-sillytavern-extension)<br>
Purpose: SillyTavern extension UI + memory sync over the plugin/server memU path.<br>
Not affiliated with the upstream hosted service.<br>
License: see LICENSE (upstream license applies).

![MemUxST Banner](public/banner.png)

### MemU Extension for SillyTavern

Enabling memU creates the Soul using the character's name. Choose an ST persona
first; its name is stored once for that Soul and the picker then locks. Existing
Souls reuse or create a matching persona. Older dev DBs without a stored name
are not automatically upgraded.

Relationship drafts stay bound to the chat/card where they were opened. Switching
keeps the draft but disables its Save; close that editor before editing the new
selection. Refreshing the same selection does not discard the draft.

Branches and checkpoints remain plain ST chats with no memU activity. ST's
controls stay unchanged. In memU-active main chats, replies use MCP only: a
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

**Narrative Suggestion** — The Send button is rate-limited to one request per 10 minutes (enforced client-side via localStorage). After a successful send the button stays disabled for 10 minutes; reload the page to see the remaining cooldown reset on next page load only if the 10 minutes have elapsed.

A seamless, powerful memory plugin powered by MemU!
Requires a server plugin to function: [MemU-Plugin](https://github.com/mekineer-com/memu-sillytavern-plugin).

</div>

### Model Mapping

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
