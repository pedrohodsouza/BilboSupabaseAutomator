import express from "express";
import http from "http";
import { Server } from "socket.io";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.static("public"));

// Main page
app.get("/", (req, res) => {
  res.render("index");
});

io.on("connection", (socket) => {
  console.log("New client connected");

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
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bilbo running at http://localhost:${PORT}`));
