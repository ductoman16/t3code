# Skills

Skills for agents running inside T3 Code. Skills for working on this repo live in `.agents/skills`.

## personal-assistant

Turns a thread into a proactive personal assistant. It keeps a ledger of your open loops in `~/.assistant/`, wakes on a scheduled heartbeat to work them in the background, stays quiet unless something needs you, and sends one brief a day. It pairs with voice mode, so you can talk to the thread like a phone call.

Install it on the machine that runs your T3 Code server:

```sh
npx skills add ductoman16/t3code --skill personal-assistant
```

Then start a thread and ask it to become your assistant. Setup asks what to watch, when to brief you, and what is on your plate.

Written for the Claude provider. It uses T3 Code's scheduled tasks and thread messaging, and Claude Code's `PushNotification` for interrupts.
