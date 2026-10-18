const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get("token").then(({ token }) => {
  tokenInput.value = token ?? "";
  refresh();
});

// Tokens are 32 random bytes in base64url (43 chars). Pulling one out of the paste
// tolerates extra terminal output pasted along with it.
const extractToken = (text) => text.match(/[A-Za-z0-9_-]{43}/g)?.at(-1) ?? text.trim();

document.getElementById("save").addEventListener("click", async () => {
  const token = extractToken(tokenInput.value);
  tokenInput.value = token;
  await chrome.storage.local.set({ token });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 2000);
  refresh();
});

document.getElementById("refresh").addEventListener("click", refresh);

const serviceText = {
  ok: "Running",
  "no-service": "Not running (or not reachable on 127.0.0.1:8790)",
  "bad-token": "Running, but it rejected the token above",
  "no-token": "Paste the token above first",
};

async function refresh() {
  const status = tokenInput.value.trim()
    ? await chrome.runtime.sendMessage({ type: "service-status" })
    : { state: "no-token" };
  document.getElementById("service").textContent = serviceText[status?.state] ?? status?.state ?? "";
  const tbody = document.getElementById("repos");
  tbody.replaceChildren();
  for (const repo of status?.repos ?? []) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = repo;
    tr.append(td);
    tbody.append(tr);
  }
}
