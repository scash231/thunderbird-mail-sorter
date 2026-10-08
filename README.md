# Thunderbird Mail Sorter

A Thunderbird add-on that moves mail out of your inbox into folders, but waits a while first.

## Why

The iPhone Mail app only checks for new mail every 15 minutes, and it only shows a
notification for mail that is still in the inbox. If mail gets sorted into folders right
away, the notification never shows up.

This add-on leaves new mail in the inbox for 45 minutes, so your phone sees it, and then
moves it into the right folder. Spam is moved right away.

## What it does

- Each of your addresses gets its own folder, for example mail to `dev@...` goes to
  `Inbox/dev@...`.
- New mail waits in the inbox, then it is moved to its folder.
- Mail that doesn't match any of your addresses stays in the inbox.
- Nothing is ever deleted, and read or unread stays the way it is.
- Mail you move back into the inbox yourself stays there.
- It only runs while Thunderbird is open. Mail that came in while your computer was off is
  sorted when you start Thunderbird again.
- It starts in **test mode**: it only shows what it would move. You switch that off once
  everything looks right.

## Install

1. Download the `.xpi` file from [Releases](../../releases).
2. In Thunderbird open **Add-ons and Themes**, click the gear icon and choose
   **Install Add-on From File**.
3. Pick the `.xpi` file and confirm.

Thunderbird accepts the add-on even though it isn't signed.

## Set up

The settings page opens after installing. You can also open it with the
**Mail-Sortierer** button in the toolbar.

1. Pick your mail account.
2. Check the rules: address, folder and wait time. If a mail went to more than one of your
   addresses, the rule further up wins.
3. Save.
4. Watch the **Status** tab for a while. It lists what would be moved and when.
5. When it looks right, turn off test mode (DRY_RUN) and save.

The default rules are set up for the `braunben.de` addresses, change them to your own.
The settings page is in German.

## Update

Install the new `.xpi` the same way. Your settings stay.

## Good to know

- It only works while Thunderbird is running.
- The iPhone checks every 15 minutes, so don't set the wait time much lower than 20
  minutes.
- To see who a mail was for, the add-on reads it once. For mail with big attachments that
  can take a moment.

## Build it yourself

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm test
npm run build
```

The add-on file ends up in the `dist` folder.
