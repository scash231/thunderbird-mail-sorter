// Background script (MV3 event page). All listeners are registered synchronously at the
// top level, so Thunderbird can wake the page for them after it was suspended.

import { ALARM_NAME, createSorter } from "./src/sorter.js";

const sorter = createSorter({ api: messenger });

messenger.messages.onNewMailReceived.addListener((folder, messages) => sorter.onNewMail(folder, messages));
messenger.messages.onMoved.addListener((original, moved) => sorter.onMoved(original, moved));
messenger.messages.onDeleted.addListener((messages) => sorter.onDeleted(messages));

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) return sorter.tick("alarm");
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

// Alarms do not survive a restart. Keep an existing one, so its rhythm is not reset
// every time the page wakes up.
messenger.alarms.get(ALARM_NAME).then((alarm) => {
  if (!alarm) messenger.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 1 });
});
