const tokenInput = document.getElementById("token");
const status = document.getElementById("status");
const tbody = document.getElementById("sessions");

chrome.storage.local.get("token").then(({ token }) => {
  tokenInput.value = token ?? "";
  refresh();
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: tokenInput.value.trim() });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 2000);
  refresh();
});

document.getElementById("refresh").addEventListener("click", refresh);

async function refresh() {
  const sessions = await chrome.runtime.sendMessage({ type: "list-sessions" });
  tbody.replaceChildren();
  if (!sessions?.length) {
    addRow(["—", "No sessions found on ports 8790–8799", ""]);
    return;
  }
  for (const s of sessions) {
    addRow(s.unauthorized ? [s.port, "Token rejected: check the pairing token", ""] : [s.port, s.repo ?? "(any repo)", s.cwd]);
  }
}

function addRow(cells) {
  const tr = document.createElement("tr");
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = String(c);
    tr.append(td);
  }
  tbody.append(tr);
}
