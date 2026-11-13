# Setup

Turns this thread into the assistant's home. When `~/.assistant/profile.md`
already exists the assistant is moving threads: read it, skip to step 4, and
rebind the existing tasks.

1. **Inventory** what this session can actually reach: connectors, signed-in
   CLIs, other T3 threads, the machine inventory. Try one read against each
   candidate; a source counts only once a read has returned data.
2. **Interview** the user, one question at a time, each with your recommended
   default:
   - which of the reachable sources to sweep, and what in each matters;
   - brief time and quiet hours;
   - heartbeat interval (default hourly);
   - which events should interrupt them at once, and which may wake them;
   - any standing orders they want from day one.
3. **Sweep their head.** Ask what is on their plate right now and keep asking
   "what else?" until they run dry. Capture each answer as a loop.
4. **Write** `~/.assistant/profile.md` and `~/.assistant/ledger.md`.
5. **Schedule** two tasks bound to this thread with `schedule_task`. Exactly
   one of each exists: when `list_scheduled_tasks` shows one already, update
   it by its `scheduledTaskId`.
   - `Assistant heartbeat` — interval; prompt:
     `Heartbeat: load the personal-assistant skill and run its heartbeat.`
   - `Assistant brief` — fixed time; prompt:
     `Brief: load the personal-assistant skill and run its brief.`
6. **Rename** the thread `Assistant`.
7. **Read back** to the user: the sources you will sweep, the loops you
   captured, and the next run time each task returned.

Setup is done when both files exist, exactly one heartbeat and one brief task
are bound to this thread, and the user has heard their next run times.
