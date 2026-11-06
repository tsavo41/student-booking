import { createInterface, emitKeypressEvents } from "node:readline";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import { sendAdministratorEmail } from "./mail.js";

const root = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(process.env.ATTACHFLOW_DB || resolve(root, "data", "attachflow.sqlite"));
const initialAdministratorEmail = "juki13305@gmail.com";

export async function createSuperAdministrator(database, account, sendEmail = sendAdministratorEmail) {
  const fullName = typeof account.fullName === "string" ? account.fullName.trim() : "";
  const username = typeof account.username === "string" ? account.username.trim() : "";
  const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : initialAdministratorEmail;
  const password = account.password;

  if (!fullName || fullName.length > 120) throw new Error("Full name must be between 1 and 120 characters.");
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) {
    throw new Error("Username must contain 3-80 letters, numbers, dots, underscores or hyphens.");
  }
  if (email !== initialAdministratorEmail) throw new Error(`The first Super Administrator email must be ${initialAdministratorEmail}.`);
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must contain at least 12 characters and no more than 72 UTF-8 bytes.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verificationToken = sendEmail ? randomBytes(32).toString("base64url") : null;
  const tokenHash = verificationToken ? createHash("sha256").update(verificationToken).digest("hex") : null;
  const now = new Date().toISOString();
  let verificationLink;
  if (verificationToken) {
    const origin = (process.env.ATTACHFLOW_PUBLIC_ORIGIN || "http://127.0.0.1:3000").replace(/\/+$/, "");
    verificationLink = new URL("/", origin);
    verificationLink.searchParams.set("adminVerify", verificationToken);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const count = Number(database.prepare("SELECT COUNT(*) AS count FROM administrators").get().count);
    if (count !== 0) throw new Error("An administrator account already exists; first-account creation is disabled.");
    const result = database.prepare(`
      INSERT INTO administrators (username, full_name, email, password_hash, role, suspended, email_verified, created_at)
      VALUES (?, ?, ?, ?, 'super_admin', 0, ?, ?)
    `).run(username, fullName, email, passwordHash, sendEmail ? 0 : 1, now);
    if (sendEmail) {
      database.prepare(`
        INSERT INTO administrator_email_tokens (token_hash, purpose, administrator_id, email, expires_at, created_at)
        VALUES (?, 'verify_email', ?, ?, ?, ?)
      `).run(tokenHash, Number(result.lastInsertRowid), email, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), now);
    }
    database.prepare(`
      INSERT INTO activity_logs (administrator_id, action, details, created_at)
      VALUES (?, ?, ?, ?)
    `).run(Number(result.lastInsertRowid), "Initial administrator created", `${username} created through the VS Code terminal`, now);
    if (sendEmail) {
      const message = `Verify the email address for your AttachFlow Super Administrator account, ${username}, using the one-time link below. The link expires in 24 hours.`;
      await sendEmail({
        to: email,
        subject: "AttachFlow: Verify Super Administrator email",
        text: `${message}\n\n${verificationLink}\n\nIf you did not create this account, contact your system administrator.`,
        html: `<main style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;color:#172b4d"><h1 style="color:#10243e">AttachFlow</h1><h2>Verify administrator email</h2><p>${message}</p><p><a href="${verificationLink}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Verify email</a></p></main>`
      });
    }
    database.exec("COMMIT");
    return { id: Number(result.lastInsertRowid), username, role: "super_admin" };
  } catch (error) {
    database.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw new Error("That administrator username or email address is already in use.");
    }
    throw error;
  }
}

function ask(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer, reject) => {
    readline.question(prompt, answer => {
      readline.close();
      resolveAnswer(answer);
    });
    readline.once("SIGINT", () => {
      readline.close();
      reject(new Error("Account creation cancelled."));
    });
  });
}

function askHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Run this command interactively in the VS Code terminal so the password can be entered without echo."));
  }

  emitKeypressEvents(input);
  return new Promise((resolveAnswer, reject) => {
    let value = "";
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\r\n");
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Account creation cancelled."));
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolveAnswer(value);
      } else if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };
    process.stdout.write(prompt);
    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
  });
}

async function main() {
  if (!existsSync(databasePath)) {
    throw new Error(`AttachFlow database not found at ${databasePath}. Run "npm start" once to initialize the application database, then run this command again.`);
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has("administrators") || !tables.has("activity_logs")) {
      throw new Error("The AttachFlow administrator schema is not initialized. Run \"npm start\" once, then run this command again.");
    }
    if (Number(database.prepare("SELECT COUNT(*) AS count FROM administrators").get().count) !== 0) {
      throw new Error("An administrator account already exists; first-account creation is disabled.");
    }

    process.stdout.write("Create the first AttachFlow Super Administrator account.\r\n");
    const fullName = (await ask("Full name: ")).trim();
    const username = (await ask("Username: ")).trim();
    const password = await askHidden("Password (input hidden): ");
    const confirmation = await askHidden("Confirm password (input hidden): ");
    if (password !== confirmation) throw new Error("The passwords do not match.");
    await createSuperAdministrator(database, { fullName, username, password }, null);
    process.stdout.write(`Super Administrator created and activated. Sign in with username "${username}". Email services must be configured for password recovery.\r\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\r\n`);
    process.exitCode = 1;
  });
}
