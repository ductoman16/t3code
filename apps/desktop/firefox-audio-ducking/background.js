import { followDucking } from "./followDucking.js";

const tabs = new Set();
let ducked = false;
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a runtime.Port, not a window
const tell = (tab) => tab.postMessage(ducked);

browser.runtime.onConnect.addListener((tab) => {
  tabs.add(tab);
  tab.onDisconnect.addListener(() => tabs.delete(tab));
  tell(tab);
});

followDucking({
  open: (url) => new EventSource(url),
  onChange: (next) => {
    ducked = next;
    tabs.forEach(tell);
  },
});
