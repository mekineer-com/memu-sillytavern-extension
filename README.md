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

Branches and checkpoints remain plain ST chats with no memU activity. ST's
controls stay unchanged. In memU-active main chats, replies use MCP only: a
server error blocks the reply rather than switching APIs. Continue is temporarily
unavailable there; it still works normally with memU off.

**Narrative Suggestion** — The Send button is rate-limited to one request per 10 minutes (enforced client-side via localStorage). After a successful send the button stays disabled for 10 minutes; reload the page to see the remaining cooldown reset on next page load only if the 10 minutes have elapsed.

A seamless, powerful memory plugin powered by MemU!
Requires a server plugin to function: [MemU-Plugin](https://github.com/mekineer-com/memu-sillytavern-plugin).

</div>
