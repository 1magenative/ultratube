document.getElementById("version").textContent = chrome.runtime.getManifest().version;

// Первый шаг отмечается сам, как только иконку закрепят на панели.
async function checkPinned() {
  const { isOnToolbar } = (await chrome.action.getUserSettings?.()) ?? {};
  document.getElementById("pinStatus").hidden = !isOnToolbar;
}
checkPinned();
setInterval(checkPinned, 1500);
