# Brief

The brief is the one message a day that carries everything the heartbeats
held back. Run [`HEARTBEAT.md`](HEARTBEAT.md) through its **Write** step
first — the legwork in the background subagent, the ledger here — then, in
place of its **Decide** step, write the brief in this order, leaving out any
section that is empty:

1. **Needs you** — each decision or approval, prepared, with your
   recommendation.
2. **Today** — what is due or scheduled today and tomorrow.
3. **Done** — what you closed or advanced since the last brief, one line
   each.
4. **Waiting** — loops stalled on someone else, and for how long.

On the first brief of the week add **Stale**: every loop untouched for two
weeks, each with your proposal to do, defer, or drop it.

Keep it to what reads aloud in under a minute; the user asks for the detail
they want.

Then send one `PushNotification` leading with the first **Needs you** item,
clear `Held for brief` and `Done since last brief`, and stamp `Last brief`.

The brief is done when every `Held for brief` entry has been delivered or
deliberately dropped, both sections are empty, and `Last brief` is stamped.
