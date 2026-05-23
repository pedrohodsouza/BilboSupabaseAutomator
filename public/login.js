const socket = io();
const loginStatus = document.getElementById("loginStatus");
const installSection = document.getElementById("installSection");
const loginSection = document.getElementById("loginSection");
let polling = null;

fetch("/check-auth")
  .then((r) => r.json())
  .then(({ loggedIn, status }) => {
    if (loggedIn) return (window.location.href = "/");
    if (status === "not-installed") {
      installSection.style.display = "block";
    } else {
      loginSection.style.display = "block";
    }
  });

function addStatus(msg, type = "") {
  loginStatus.classList.add("visible");
  const line = document.createElement("div");
  line.classList.add("terminal-line");
  if (type) line.classList.add(type);
  line.textContent = msg;
  loginStatus.appendChild(line);
  loginStatus.scrollTop = loginStatus.scrollHeight;
}

// ── Install flow ──────────────────────────────────────────
const installBtn = document.getElementById("installBtn");

installBtn.addEventListener("click", () => {
  installBtn.disabled = true;
  installBtn.textContent = "Installing...";
  loginStatus.innerHTML = "";
  addStatus("Detecting package manager...");
  socket.emit("installCLI");
});

socket.on("installLog", (msg) => {
  const trimmed = msg.trim();
  if (trimmed) addStatus(trimmed);
});

socket.on("installDone", ({ success }) => {
  if (success) {
    addStatus("Supabase CLI installed successfully!", "success");
    addStatus("You can now connect to your account.");
    installSection.style.display = "none";
    loginSection.style.display = "block";
  } else {
    addStatus("Installation failed. Try one of the manual commands below.", "error");
    installBtn.disabled = false;
    installBtn.textContent = "Retry Installation";
  }
});

// ── Clickable copy commands ───────────────────────────────
document.querySelectorAll(".cmd-line").forEach((el) => {
  el.addEventListener("click", () => {
    navigator.clipboard.writeText(el.textContent).then(() => {
      const original = el.textContent;
      el.textContent = "Copied!";
      el.classList.add("copied");
      setTimeout(() => {
        el.textContent = original;
        el.classList.remove("copied");
      }, 1200);
    });
  });
});

// ── Login flow ────────────────────────────────────────────
const loginBtn = document.getElementById("loginBtn");

function startPolling() {
  polling = setInterval(async () => {
    try {
      const { loggedIn } = await fetch("/check-auth").then((r) => r.json());
      if (loggedIn) {
        clearInterval(polling);
        addStatus("Login successful! Redirecting...", "success");
        setTimeout(() => (window.location.href = "/"), 1200);
      }
    } catch (_) {}
  }, 2000);
}

loginBtn.addEventListener("click", () => {
  loginBtn.disabled = true;
  loginBtn.textContent = "Opening browser...";
  loginStatus.innerHTML = "";
  socket.emit("triggerLogin");
});

socket.on("awaitingCode", () => {
  document.getElementById("loginSection").style.display = "none";
  const codeSection = document.getElementById("codeSection");
  codeSection.style.display = "block";
  document.getElementById("codeInput").focus();
});

document.getElementById("codeBtn").addEventListener("click", () => {
  const code = document.getElementById("codeInput").value.trim();
  if (!code) { addStatus("Please enter the code.", "error"); return; }
  document.getElementById("codeSection").style.display = "none";
  addStatus("Code submitted — verifying...");
  socket.emit("submitDeviceCode", { code });
  startPolling();
});
