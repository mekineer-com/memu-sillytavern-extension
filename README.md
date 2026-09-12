<div align="center">

When you enter a new chat, memU will start to memorize for the entire chat, so be careful not to enter a huge chat or you will have a large token spend.

For any issues or suggestions, please contact mekineer@gmail.com.

REQUIRES:<br>
https://github.com/mekineer-com/memu-sillytavern-plugin/<br>
https://github.com/mekineer-com/mcp-memu-server/<br>
[https://github.com/mekineer-com/memU/](https://github.com/mekineer-com/memU/)<br>
Can be run on Python 3.12 by changing versions in the memU config files including pyproject.toml.<br>
Compatibility includes Alpine 3.23.

Community fork (unofficial).<br>
Upstream: (https://github.com/NevaMind-AI/memu-sillytavern-extension)<br>
Purpose: SillyTavern extension UI + memory sync over the plugin/server memU path.<br>
Not affiliated with the upstream hosted service.<br>
License: see LICENSE (upstream license applies).

![MemUxST Banner](public/banner.png)

### MemU Extension for SillyTavern

On first OpenAlma use, the entered Soul name is authoritative. The extension
selects an exact-name SillyTavern character or creates and selects a new minimal
character, then explicitly creates that Soul through the server.

**Narrative Suggestion** — The Send button is rate-limited to one request per 10 minutes (enforced client-side via localStorage). After a successful send the button stays disabled for 10 minutes; reload the page to see the remaining cooldown reset on next page load only if the 10 minutes have elapsed.

A seamless, powerful memory plugin powered by MemU!
Requires a server plugin to function: [MemU-Plugin](https://github.com/mekineer-com/memu-sillytavern-plugin).

</div>
