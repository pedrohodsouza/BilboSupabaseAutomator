const socket = io();
const form = document.getElementById("migrateForm");
const logs = document.getElementById("logs");

fetch("/user-info")
  .then((r) => r.json())
  .then(({ orgs, error }) => {
    const el = document.getElementById("accountOrgs");
    if (error === "not-installed") {
      el.textContent = "Supabase CLI not installed";
      el.style.color = "#ffcc66";
    } else {
      el.textContent = orgs.length ? orgs.join(", ") : "—";
    }
  })
  .catch(() => {
    document.getElementById("accountOrgs").textContent = "—";
  });

function addLog(message, type = "") {
  const line = document.createElement("div");
  line.classList.add("terminal-line");
  if (type) line.classList.add(type);
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight; 
}

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const source = document.getElementById("source").value.trim();
  const target = document.getElementById("target").value.trim();

  logs.innerHTML = "";

  if (!source || !target) {
    addLog("Please enter both Source and Target project IDs.", "error");
    return;
  }

  addLog("🚀 Starting migration...", "success");
  socket.emit("startMigration", { source, target });
});

socket.on("log", (msg) => {
  let type = "";

  const lower = msg.toLowerCase();
  if (lower.includes("error")) type = "error";
  else if (lower.includes("warning") || lower.includes("⚠️")) type = "warning";
  else if (lower.includes("success") || lower.includes("completed")) type = "success";

  addLog(msg.trim(), type);
});

socket.on("done", () => {
  addLog("✅ Migration completed successfully!", "success");
});
