import express from "express";
import http from "http";
import { Server } from "socket.io";
import { exec, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.static("public"));

// Returns: "logged-in" | "not-logged-in" | "not-installed"
function checkSupabaseAuth() {
  return new Promise((resolve) => {
    exec(
      'powershell -ExecutionPolicy Bypass -Command "supabase projects list 2>&1"',
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err && err.killed) return resolve("not-installed");
        const out = (stdout + stderr).toLowerCase();
        if (out.includes("não é reconhecido") || out.includes("not recognized") || out.includes("commandnotfoundexception")) {
          return resolve("not-installed");
        }
        // If the command exited with a non-zero code, the user is not authenticated
        if (err) return resolve("not-logged-in");
        resolve("logged-in");
      }
    );
  });
}

app.get("/login", (req, res) => {
  res.render("login");
});

app.get("/check-auth", async (req, res) => {
  const status = await checkSupabaseAuth();
  res.json({ loggedIn: status === "logged-in", status });
});

app.get("/", async (req, res) => {
  const status = await checkSupabaseAuth();
  if (status !== "logged-in") return res.redirect("/login");
  res.render("index");
});

app.get("/user-info", (req, res) => {
  exec(
    'powershell -ExecutionPolicy Bypass -Command "supabase orgs list --output json 2>&1"',
    { timeout: 10000 },
    (err, stdout, stderr) => {
      const raw = (stdout + stderr).toLowerCase();
      if (raw.includes("não é reconhecido") || raw.includes("not recognized") || raw.includes("commandnotfoundexception")) {
        return res.json({ orgs: [], error: "not-installed" });
      }
      try {
        const orgs = JSON.parse(stdout.trim());
        res.json({ orgs: orgs.map((o) => o.name) });
      } catch {
        res.json({ orgs: [], error: "parse-error" });
      }
    }
  );
});

app.post("/logout", (req, res) => {
  exec(
    'powershell -ExecutionPolicy Bypass -Command "echo y | supabase logout"',
    { timeout: 10000 },
    () => res.redirect("/login")
  );
});

const pendingLogins = new Map(); // socketId → { ecdh, sessionId }

io.on("connection", (socket) => {
  console.log("New client connected");

  socket.on("installCLI", () => {
    const psScript = `
$ErrorActionPreference = 'Continue'
if (Get-Command scoop -ErrorAction SilentlyContinue) {
    Write-Host "Package manager detected: Scoop"
    Write-Host "Adding Supabase bucket..."
    scoop bucket add supabase https://github.com/supabase/scoop-bucket.git 2>&1
    Write-Host "Installing Supabase CLI..."
    scoop install supabase 2>&1
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Package manager detected: winget"
    winget install Supabase.CLI 2>&1
} elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Package manager detected: Chocolatey"
    choco install supabase -y 2>&1
} else {
    Write-Host "No supported package manager found. Please install manually."
    exit 1
}
Write-Host "Done!"
`;
    const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-Command", psScript]);
    child.stdout.on("data", (data) => socket.emit("installLog", data.toString()));
    child.stderr.on("data", (data) => socket.emit("installLog", data.toString()));
    child.on("close", (code) => socket.emit("installDone", { success: code === 0 }));
  });

  socket.on("triggerLogin", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const publicKeyHex = ecdh.getPublicKey("hex");
    const sessionId = crypto.randomUUID();
    const tokenName = `bilbo_${Date.now()}`;

    const loginUrl =
      `https://supabase.com/dashboard/cli/login` +
      `?session_id=${sessionId}` +
      `&token_name=${encodeURIComponent(tokenName)}` +
      `&public_key=${publicKeyHex}`;

    exec(`powershell -ExecutionPolicy Bypass -Command "Start-Process '${loginUrl}'"`);
    pendingLogins.set(socket.id, { ecdh, sessionId });

    socket.emit("loginLog", "Browser opened — log in to Supabase.");
    socket.emit("awaitingCode");
  });

  socket.on("submitDeviceCode", ({ code }) => {
    const pending = pendingLogins.get(socket.id);
    if (!pending) return;
    const { ecdh, sessionId } = pending;
    pendingLogins.delete(socket.id);

    socket.emit("loginLog", "Verifying code...");

    let attempts = 0;
    const poll = setInterval(async () => {
      if (++attempts > 150) {
        clearInterval(poll);
        socket.emit("loginLog", "Timed out after 5 minutes. Please try again.");
        return;
      }
      try {
        const res = await fetch(
          `https://api.supabase.com/platform/cli/login/${sessionId}?device_code=${encodeURIComponent(code)}`
        );
        const text = await res.text();
        if (!res.ok) {
          socket.emit("loginLog", `API ${res.status}: ${text.slice(0, 200)}`);
          return;
        }
        const data = JSON.parse(text);
        socket.emit("loginLog", `Response keys: ${Object.keys(data).join(", ")}`);

        const encryptedHex = data.token || data.access_token || data.AccessToken;
        const serverPubKeyHex = data.public_key || data.PublicKey;
        const nonceHex = data.nonce || data.Nonce;
        if (!encryptedHex || !serverPubKeyHex || !nonceHex) {
          socket.emit("loginLog", `Waiting for token fields... got: ${JSON.stringify(data).slice(0, 200)}`);
          return;
        }

        clearInterval(poll);

        const sharedSecret = ecdh.computeSecret(Buffer.from(serverPubKeyHex, "hex"));
        const encrypted = Buffer.from(encryptedHex, "hex");
        const authTag = encrypted.slice(-16);
        const ciphertext = encrypted.slice(0, -16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", sharedSecret, Buffer.from(nonceHex, "hex"));
        decipher.setAuthTag(authTag);
        const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

        exec(
          'powershell -ExecutionPolicy Bypass -Command "supabase login --token $env:BILBO_TOKEN"',
          { timeout: 10000, env: { ...process.env, BILBO_TOKEN: token } },
          (err) => {
            if (!err) socket.emit("loginLog", "Authenticated! Redirecting...");
            else socket.emit("loginLog", "Error saving token: " + err.message);
          }
        );
      } catch (_) {}
    }, 2000);
  });

  socket.on("startMigration", ({ source, target }) => {
    console.log(`Starting migration from ${source} → ${target}`);

    const send = (msg) => socket.emit("log", msg);

    // Validation
    if (!source || !target) {
      send("Please provide both Source and Target project IDs.");
      socket.emit("done");
      return;
    }

    // PowerShell script (no emojis, safe for UTF-8)
    const psScript = `
  Write-Host "Checking Supabase login..."
  $loginStatus = supabase projects list 2>&1
  if ($loginStatus -match "Not logged in") {
      Write-Host "You are not logged in to Supabase CLI. Please run 'supabase login' and try again."
      exit 1
  }

  Write-Host "Listing Edge Functions from ${source}..."
  $functions = supabase functions list --project-ref ${source} --output json | jq -r '.[].name'

  if (-not $functions) {
      Write-Host "No Edge Functions found in ${source}."
      exit 0
  }

  foreach ($fn in $functions) {
      Write-Host "Downloading function: $fn"
      supabase functions download $fn --project-ref ${source}
  }

  Write-Host "Deploying all functions to target project: ${target}"
  $functionDirs = Get-ChildItem "supabase/functions" -Directory

  foreach ($d in $functionDirs) {
      Write-Host "Deploying function: $($d.Name)"
      supabase functions deploy $($d.Name) --project-ref ${target}
  }

  Write-Host "Migration completed successfully!"
`;


    // Save temporary PowerShell script
    const tempScriptPath = path.join(process.cwd(), "bilbo_temp.ps1");
    fs.writeFileSync(tempScriptPath, psScript, "utf-8");

    // Execute the PowerShell script
    const child = exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`);

    // Send real-time logs to frontend
    child.stdout.on("data", (data) => {
      socket.emit("log", data.toString());
    });

    child.stderr.on("data", (data) => {
      socket.emit("log", "Error: " + data.toString());
    });

    // Handle completion
    child.on("close", (code) => {
      if (code === 0) {
        socket.emit("log", "Migration finished successfully.");
      } else {
        socket.emit("log", "Migration failed. Please check your credentials and try again.");
      }

      // Cleanup
      if (fs.existsSync(tempScriptPath)) fs.unlinkSync(tempScriptPath);
      socket.emit("done");
      console.log("Temporary script removed. Process finished.");
    });
  });

  socket.on("disconnect", () => {
    pendingLogins.delete(socket.id);
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bilbo running at http://localhost:${PORT}`));
