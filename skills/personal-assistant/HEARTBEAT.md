# Heartbeat

A heartbeat is a scheduled wake with nobody watching. Its product is an
advanced ledger; a message to the user is the exception. The home thread
stays free for the user to talk to: a background subagent does the legwork,
and the home thread keeps the ledger and the decision.

## In the home thread

1. **Dispatch** a background subagent with the paths of the profile, the
   ledger, and this skill's folder, and the instruction to run
   [The legwork](#the-legwork). End the turn.
2. **Write** the ledger from its report when it arrives, and stamp
   `Last heartbeat`.
3. **Decide.** Judge each thing it found against the bar in
   [Interrupting](SKILL.md#interrupting).
   - Something clears it: send one `PushNotification` leading with the most
     urgent item, and one message carrying every item that cleared, each with
     what you need from the user.
   - Nothing clears it: take the quiet path — reply `Quiet.` and end the turn.

The heartbeat is done when the report's changes are in the ledger and
`Last heartbeat` is stamped.

## The legwork

You are the subagent. The home thread alone writes the ledger and speaks to
the user; your one output is the report in step 5.

1. **Read** the profile, the ledger, and [`SKILL.md`](SKILL.md).
2. **Sweep** every source in the profile for what changed since
   `Last heartbeat`. Note the loops the changes open and the loops the
   evidence closes. A source you cannot reach is itself a loop: owner `user`,
   with the exact error.
3. **Work** every loop whose check date has arrived:
   - owner `me` — do the next action as far as [Acting](SKILL.md#acting)
     allows, then name the following next action and check date.
   - owner `user` — bring it prepared, then name a new check date.
   - owner `waiting-for` — look for the reply in its source. Still waiting:
     draft the nudge for approval and name a new check date.
4. **Look ahead** two days: prepare now every loop due inside that window.
5. **Report** every ledger change, everything you prepared, and each thing
   that may clear the interrupt bar.

The legwork is done when every source in the profile has been swept and every
loop whose check date had arrived appears in the report with a later check
date or as closed.
