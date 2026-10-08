// Background script (MV3 event page). All listeners are registered synchronously at the
// top level, so Thunderbird can wake the page for them after it was suspended.

import { ALARM_DUE, ALARM_HEARTBEAT, HEARTBEAT_MINUTES, createSorter } from "./src/sorter.js";

const sorter = createSorter({ api: messenger });

messenger.messages.onNewMailReceived.addListener((folder, messages) => sorter.onNewMail(folder, messages));
messenger.messages.onMoved.addListener((original, moved) => sorter.onMoved(original, moved));
messenger.messages.onDeleted.addListener((messages) => sorter.onDeleted(messages));

// A target folder that was missing may exist now.
messenger.folders.onCreated.addListener((folder) => sorter.onFoldersChanged(folder));
messenger.folders.onRenamed.addListener((original) => sorter.onFoldersChanged(original));
messenger.folders.onMoved.addListener((original) => sorter.onFoldersChanged(original));
messenger.folders.onDeleted.addListener((folder) => sorter.onFoldersChanged(folder));

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DUE || alarm.name === ALARM_HEARTBEAT) return sorter.tick("alarm");
});

messenger.runtime.onStartup.addListener(() => sorter.tick("start"));

const openOptions = () => messenger.runtime.openOptionsPage().catch((e) => console.warn("Optionsseite:", e));

messenger.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") openOptions();
  return sorter.tick("install");
});

messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "config" in changes) sorter.tick("config");
});

messenger.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== messenger.runtime.id) return undefined;
  return sorter.command(message);
});

messenger.action.onClicked.addListener(openOptions);

// The precise wake-ups come from the one-shot ALARM_DUE that every run schedules. The
// heartbeat is the safety net; alarms do not survive a restart, so it is created here
// (first run after a minute) and kept as is when the page merely wakes up.
messenger.alarms
  .get(ALARM_HEARTBEAT)
  .then((alarm) => {
    if (alarm?.periodInMinutes === HEARTBEAT_MINUTES) return;
    return messenger.alarms.create(ALARM_HEARTBEAT, { delayInMinutes: 1, periodInMinutes: HEARTBEAT_MINUTES });
  })
  .catch((e) => console.warn("Alarm:", e));
