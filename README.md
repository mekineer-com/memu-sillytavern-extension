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

Enabling memU gives the character a Soul with lasting memories. Choose an ST
persona first: that persona stays attached to the Soul, even when memU is off.
Conflicting persona controls are locked; ordinary ST characters are unaffected.

The saved main chat supplies her memories. Branches and checkpoints keep the
persona but do not use memU. With memU on, replies come from OpenAlma; if the
server is unavailable, the reply stops rather than switching providers.
Continue is currently unavailable in memU chats.

The progress banner follows the Soul's memory processing, not just the open
chat. Cancel waits for server confirmation. If processing fails, use **Retry**
in the OpenAlma launcher. Use one active browser tab per chat.

**Narrative Suggestion** lets you suggest a change to her self-description,
with a ten-minute cooldown between successful sends.

Relationship drafts stay with the chat where you opened them. Return there to
save, or close the editor before editing a different relationship.

Requires a server plugin to function: [MemU-Plugin](https://github.com/mekineer-com/memu-sillytavern-plugin).

</div>

### Model Mapping

Choose the connection for SillyTavern replies separately from **Other OpenAlma
App Replies** and the memory operations in **Advanced Mapping**.

- **config.json** keeps the server's configured values.
- **ST selected** follows your current SillyTavern connection.
- **default (SRMM)** follows the SillyTavern Replies selection.
- A named profile follows that profile's saved changes, independently of other selections.

Other App Replies and Advanced Mapping update the shared server configuration.
A red info icon marks a hand-edited value that was previously controlled here;
choosing config.json clears the icon without changing that value.

Disabling Advanced Mapping asks before removing its overrides. Selecting
**Use Claude Code** hides the mapping controls without deleting their settings.

### Development

See [AGENTS.md](AGENTS.md) for integration contracts and checks.
