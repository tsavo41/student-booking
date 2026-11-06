import { createServer } from "node:http";
import { createReadStream, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { actionLink, sendAdministratorEmail } from "./mail.js";

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(process.env.ATTACHFLOW_DB || resolve(root, "data", "attachflow.sqlite"));
const publicOrigin = process.env.ATTACHFLOW_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || "";
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const sessions = new Map();
const rateLimits = new Map();
const publicStaticFiles = new Set(["attachflow.html", "app.js"]);
const dummyBcryptHash = bcrypt.hash(randomBytes(32).toString("hex"), 12);

if (process.env.NODE_ENV === "production" && !publicOrigin.startsWith("https://")) {
  throw new Error("Set ATTACHFLOW_PUBLIC_ORIGIN to the HTTPS application origin in production.");
}

const hospitalsToSeed = [
  { id: 5, name: "JARAMOGI OGINGA ODINGA TEACHING& REFERAL HOSPITAL", county: "KISUMU", department: "Occupational Therapy", capacity: 5 },
  { id: 6, name: "KISUMU COUNTY REFERAL HOSPITAL", county: "KISUMU", department: "Occupational Therapy", capacity: 5 },
  { id: 7, name: "KAKAMEGA COUNTY TEACHING & REFERAL HOSPITAL", county: "KAKAMEGA", department: "Occupational Therapy", capacity: 4 },
  { id: 8, name: "UASIN GISHU COUNTY HOSPITAL", county: "UASIN GISHU", department: "Occupational Therapy", capacity: 4 },
  { id: 9, name: "PORT REIZ HOSPITAL", county: "MOMBASA", department: "Occupational Therapy", capacity: 4 },
  { id: 10, name: "NAKURU TEACHING & REFERAL HOSPITAL", county: "NAKURU", department: "Occupational Therapy", capacity: 6 },
  { id: 11, name: "MURANG'A COUNTY REFERAL HOSPITAL", county: "MURANG'A", department: "Occupational Therapy", capacity: 5 },
  { id: 12, name: "EMBU COUNTY TEACHING AND REFEAL HOSPITAL", county: "EMBU", department: "Occupational Therapy", capacity: 4 },
  { id: 13, name: "KERUGOYA COUNTY REFERAL HOSPITAL", county: "KIRINYAGA", department: "Occupational Therapy", capacity: 4 },
  { id: 14, name: "NAROMORU SUB-COUNTY HOSPITAL", county: "NYERI", department: "Occupational Therapy", capacity: 4 },
  { id: 15, name: "KISII TEACHING & REFERAL HOSPITAL", county: "KISII", department: "Occupational Therapy", capacity: 5 },
  { id: 16, name: "MERU TACHING AND REFERAL HOSPITAL", county: "MERU", department: "Occupational Therapy", capacity: 5 },
  { id: 17, name: "MALINDI SUB-COUNTY HOSPITAL", county: "MALINDI", department: "Occupational Therapy", capacity: 4 },
  { id: 18, name: "KILIFICOUNTY & REFERAL HOSPITAL", county: "KILIFI", department: "Occupational Therapy", capacity: 4 },
  { id: 19, name: "UBUNTU LIFE FOUNDATION (MAI MAHIU)", county: "NAKURU", department: "Occupational Therapy", capacity: 4 }
];

mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS administrators (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'read_only_admin')),
    suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified IN (0, 1)),
    email_verified_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hospitals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    county TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT 'Occupational Therapy',
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    manually_locked INTEGER NOT NULL DEFAULT 0 CHECK (manually_locked IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS student_bookings (
    id TEXT PRIMARY KEY,
    hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    admission_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
    course TEXT NOT NULL DEFAULT 'OCCUPATIONAL THERAPY',
    campus TEXT NOT NULL DEFAULT 'KMTC NAIROBI CAMPUS',
    year_of_study TEXT NOT NULL DEFAULT '3.2',
    cancel_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Booked' CHECK (status IN ('Booked')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS student_bookings_hospital_idx ON student_bookings(hospital_id);
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY,
    administrator_id INTEGER REFERENCES administrators(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS booking_history (
    id INTEGER PRIMARY KEY,
    booking_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    admission_number TEXT NOT NULL,
    hospital_id INTEGER NOT NULL,
    hospital_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'Cancelled'),
    booking_created_at TEXT NOT NULL,
    cancelled_at TEXT NOT NULL,
    cancellation_reason TEXT NOT NULL,
    cancelled_by INTEGER REFERENCES administrators(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS booking_history_cancelled_idx ON booking_history(cancelled_at DESC);
  CREATE TRIGGER IF NOT EXISTS booking_capacity_guard_insert
  BEFORE INSERT ON student_bookings
  BEGIN
    SELECT CASE
      WHEN (SELECT manually_locked FROM hospitals WHERE id = NEW.hospital_id) IS NULL
        THEN RAISE(ABORT, 'hospital_not_found')
      WHEN (SELECT manually_locked FROM hospitals WHERE id = NEW.hospital_id) = 1
        THEN RAISE(ABORT, 'hospital_locked')
      WHEN (SELECT COUNT(*) FROM student_bookings WHERE hospital_id = NEW.hospital_id) >=
           (SELECT capacity FROM hospitals WHERE id = NEW.hospital_id)
        THEN RAISE(ABORT, 'hospital_full')
    END;
  END;
  CREATE TRIGGER IF NOT EXISTS booking_capacity_guard_update
  BEFORE UPDATE OF hospital_id ON student_bookings
  WHEN OLD.hospital_id != NEW.hospital_id
  BEGIN
    SELECT CASE
      WHEN (SELECT manually_locked FROM hospitals WHERE id = NEW.hospital_id) IS NULL
        THEN RAISE(ABORT, 'hospital_not_found')
      WHEN (SELECT manually_locked FROM hospitals WHERE id = NEW.hospital_id) = 1
        THEN RAISE(ABORT, 'hospital_locked')
      WHEN (SELECT COUNT(*) FROM student_bookings WHERE hospital_id = NEW.hospital_id) >=
           (SELECT capacity FROM hospitals WHERE id = NEW.hospital_id)
        THEN RAISE(ABORT, 'hospital_full')
    END;
  END;
  CREATE TRIGGER IF NOT EXISTS hospital_capacity_guard_update
  BEFORE UPDATE OF capacity ON hospitals
  WHEN NEW.capacity < (SELECT COUNT(*) FROM student_bookings WHERE hospital_id = OLD.id)
  BEGIN
    SELECT RAISE(ABORT, 'capacity_below_bookings');
  END;
`);

function migrateAdministratorSchema() {
  const columns = new Set(database.prepare("PRAGMA table_info(administrators)").all().map(column => column.name));
  if (columns.has("full_name") && columns.has("email") && columns.has("suspended") && columns.has("email_verified") && columns.has("email_verified_at")) {
    const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'administrators'").get().sql;
    if (schema.includes("'read_only_admin'")) return;
  }

  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    database.exec(`
      DROP TABLE IF EXISTS administrators_new;
      CREATE TABLE administrators_new (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'read_only_admin')),
        suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
        email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified IN (0, 1)),
        email_verified_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    if (columns.has("full_name") && columns.has("email")) {
      const suspended = columns.has("suspended") ? "suspended" : "0";
      const emailVerified = columns.has("email_verified") ? "email_verified" : "1";
      const emailVerifiedAt = columns.has("email_verified_at") ? "email_verified_at" : "created_at";
      database.exec(`
        INSERT INTO administrators_new (id, username, full_name, email, password_hash, role, suspended, email_verified, email_verified_at, created_at)
        SELECT id, username, full_name, email, password_hash, role, ${suspended}, ${emailVerified}, ${emailVerifiedAt}, created_at FROM administrators;
      `);
    } else {
      database.exec(`
        INSERT INTO administrators_new (id, username, full_name, email, password_hash, role, suspended, email_verified, email_verified_at, created_at)
        SELECT id, username, username, username || '@legacy.local', password_hash, 'admin', 0, 1, created_at, created_at
        FROM administrators;
      `);
    }
    database.exec("DROP TABLE administrators; ALTER TABLE administrators_new RENAME TO administrators; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

migrateAdministratorSchema();
database.exec(`
  CREATE TABLE IF NOT EXISTS administrator_email_tokens (
    token_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'invite', 'password_reset')),
    administrator_id INTEGER REFERENCES administrators(id) ON DELETE CASCADE,
    full_name TEXT,
    username TEXT,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT CHECK (role IN ('super_admin', 'admin', 'read_only_admin')),
    invited_by INTEGER REFERENCES administrators(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS administrator_email_tokens_expiry_idx ON administrator_email_tokens(expires_at);
`);

if (database.prepare("SELECT COUNT(*) AS count FROM hospitals").get().count === 0) {
  const insertHospital = database.prepare("INSERT INTO hospitals (id, name, county, department, capacity) VALUES (?, ?, ?, ?, ?)");
  for (const hospital of hospitalsToSeed) {
    insertHospital.run(hospital.id, hospital.name, hospital.county, hospital.department, hospital.capacity);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function transaction(callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function hashEmailToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createEmailToken() {
  return randomBytes(32).toString("base64url");
}

function isEmailAddress(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function adminEmailTemplate(heading, message, link, action) {
  const safeHeading = String(heading).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const safeMessage = String(message).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const safeLink = String(link).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return {
    subject: `AttachFlow: ${heading}`,
    text: `${heading}\n\n${message}\n\n${link}\n\nIf you did not request this, you can ignore this message.`,
    html: `<main style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;color:#172b4d"><h1 style="color:#10243e">AttachFlow</h1><h2>${safeHeading}</h2><p>${safeMessage}</p><p><a href="${safeLink}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">${action}</a></p><p>If you did not request this, you can ignore this message.</p></main>`
  };
}

async function sendAdminActionEmail(to, heading, message, link, action) {
  await sendAdministratorEmail({ to, ...adminEmailTemplate(heading, message, link, action) });
}

function invalidateAdministratorSessions(administratorId) {
  for (const [id, activeSession] of sessions) {
    if (activeSession.administratorId === administratorId) sessions.delete(id);
  }
}

function jsonResponse(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function requestOrigin(request) {
  return publicOrigin || `${request.socket.encrypted ? "https" : "http"}://${request.headers.host || ""}`;
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || origin !== requestOrigin(request)) {
    throw new HttpError(403, "Request origin was not allowed.");
  }
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid JSON object");
    return value;
  } catch {
    throw new HttpError(400, "A valid JSON object is required.");
  }
}

function requireText(value, label, maxLength) {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required.`);
  const clean = value.trim();
  if (!clean || clean.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(clean)) {
    throw new HttpError(400, `${label} must be between 1 and ${maxLength} characters.`);
  }
  return clean;
}

function rateLimit(request, key, limit, windowMs) {
  const now = Date.now();
  const ip = request.socket.remoteAddress || "unknown";
  const id = `${key}:${ip}`;
  let entry = rateLimits.get(id);
  if (!entry || entry.expiresAt <= now) {
    entry = { count: 0, expiresAt: now + windowMs };
    rateLimits.set(id, entry);
  }
  entry.count += 1;
  if (entry.count > limit) throw new HttpError(429, "Too many requests. Please wait and try again.");
  if (rateLimits.size > 5000) {
    for (const [mapKey, mapValue] of rateLimits) {
      if (mapValue.expiresAt <= now) rateLimits.delete(mapKey);
    }
  }
}

function cookieMap(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getSession(request) {
  const id = cookieMap(request).af_session;
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetimeMs;
  return session;
}

function startAdminSession(response, administrator) {
  const id = randomBytes(32).toString("hex");
  const session = {
    administratorId: administrator.id,
    username: administrator.username,
    fullName: administrator.fullName,
    role: administrator.role,
    csrfToken: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + sessionLifetimeMs
  };
  sessions.set(id, session);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `af_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}`);
  return session;
}

function requireAdmin(request, csrf = true, write = false) {
  const session = getSession(request);
  if (!session) throw new HttpError(401, "Administrator sign-in is required.");
  const administrator = database.prepare("SELECT role, suspended FROM administrators WHERE id = ?").get(session.administratorId);
  if (!administrator || administrator.suspended) {
    sessions.delete(cookieMap(request).af_session);
    throw new HttpError(401, "This administrator account is suspended or no longer active.");
  }
  session.role = administrator.role;
  if (write && session.role === "read_only_admin") throw new HttpError(403, "This account has read-only access.");
  if (csrf) {
    assertSameOrigin(request);
    if (request.headers["x-csrf-token"] !== session.csrfToken) {
      throw new HttpError(403, "Your session has expired. Reload the page and sign in again.");
    }
  }
  return session;
}

function requireSuperAdministrator(session) {
  if (session.role !== "super_admin") throw new HttpError(403, "Super Administrator access is required.");
}

function archiveBooking(booking, cancelledBy, reason) {
  database.prepare(`
    INSERT INTO booking_history
      (booking_id, full_name, admission_number, hospital_id, hospital_name, status, booking_created_at, cancelled_at, cancellation_reason, cancelled_by)
    VALUES (?, ?, ?, ?, ?, 'Cancelled', ?, ?, ?, ?)
  `).run(
    booking.id,
    booking.fullName,
    booking.admissionNumber,
    booking.hospitalId,
    booking.hospital,
    booking.createdAt,
    new Date().toISOString(),
    reason,
    cancelledBy
  );
}

async function verifyPassword(password, encoded) {
  if (/^\$2[aby]\$/.test(encoded)) {
    if (Buffer.byteLength(password, "utf8") > 72) return false;
    return bcrypt.compare(password, encoded);
  }
  const [saltHex, hashHex] = encoded.split(":");
  if (!/^[\da-f]{32}$/i.test(saltHex || "") || !/^[\da-f]{128}$/i.test(hashHex || "")) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function logActivity(adminId, action, details) {
  database.prepare("INSERT INTO activity_logs (administrator_id, action, details, created_at) VALUES (?, ?, ?, ?)").run(adminId ?? null, action, details, new Date().toISOString());
}

function hospitalRow(row) {
  const booked = Number(row.booked || 0);
  const capacity = Number(row.capacity);
  const full = booked >= capacity;
  const locked = Boolean(row.manually_locked) || full;
  return {
    id: Number(row.id),
    name: row.name,
    county: row.county,
    department: row.department,
    capacity,
    booked,
    occupancyRate: capacity ? Math.round(booked / capacity * 100) : 0,
    availableSlots: locked ? 0 : capacity - booked,
    full,
    locked,
    status: full ? "FULL" : Boolean(row.manually_locked) ? "LOCKED" : "OPEN",
    manuallyLocked: Boolean(row.manually_locked)
  };
}

const hospitalSelect = `
  SELECT h.*, COUNT(b.id) AS booked
  FROM hospitals h LEFT JOIN student_bookings b ON b.hospital_id = h.id
`;

function listHospitals() {
  return database.prepare(`${hospitalSelect} GROUP BY h.id ORDER BY h.id`).all().map(hospitalRow);
}

function listBookings(filters = {}) {
  const conditions = [];
  const values = [];
  if (filters.hospitalId) {
    conditions.push("h.id = ?");
    values.push(Number(filters.hospitalId));
  }
  if (filters.course) {
    conditions.push("b.course = ?");
    values.push(filters.course);
  }
  if (filters.campus) {
    conditions.push("b.campus = ?");
    values.push(filters.campus);
  }
  if (filters.yearOfStudy) {
    conditions.push("b.year_of_study = ?");
    values.push(filters.yearOfStudy);
  }
  if (filters.query) {
    conditions.push("(b.full_name LIKE ? ESCAPE '\\' OR b.admission_number LIKE ? ESCAPE '\\')");
    const escaped = filters.query.replace(/[\\%_]/g, character => `\\${character}`);
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return database.prepare(`
    SELECT b.id, b.full_name AS fullName, b.admission_number AS admissionNumber,
      b.course, b.campus, b.year_of_study AS yearOfStudy, b.status,
      b.created_at AS createdAt, b.hospital_id AS hospitalId, h.name AS hospital
    FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id
    ${where}
    ORDER BY b.created_at DESC, b.id
  `).all(...values);
}

function listCancelledBookings(filters = {}) {
  const conditions = [];
  const values = [];
  if (filters.hospitalId) {
    conditions.push("hospital_id = ?");
    values.push(Number(filters.hospitalId));
  }
  if (filters.query) {
    conditions.push("(full_name LIKE ? ESCAPE '\\' OR admission_number LIKE ? ESCAPE '\\')");
    const escaped = filters.query.replace(/[\\%_]/g, character => `\\${character}`);
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  return database.prepare(`
    SELECT id AS historyId, booking_id AS bookingId, full_name AS fullName, admission_number AS admissionNumber,
      hospital_id AS hospitalId, hospital_name AS hospital, status,
      booking_created_at AS createdAt, cancelled_at AS cancelledAt,
      cancellation_reason AS cancellationReason
    FROM booking_history
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY cancelled_at DESC, id DESC
  `).all(...values);
}

function recordsForExport() {
  return [...listBookings({}), ...listCancelledBookings({})]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function escapeCsv(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function sendExport(request, response, format) {
  const records = recordsForExport();
  const columns = [
    ["No.", "number"], ["Full Name", "fullName"], ["Admission Number", "admissionNumber"],
    ["Course", "course"], ["Campus", "campus"], ["Year of Study", "yearOfStudy"],
    ["Hospital", "hospital"], ["Booking Status", "status"], ["Booked At", "createdAt"]
  ];
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const lines = [columns.map(([label]) => escapeCsv(label)).join(","), ...records.map((record, index) => columns.map(([label, key]) => escapeCsv(key === "number" ? index + 1 : record[key])).join(","))];
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attachflow-bookings-${date}.csv"`,
      "Cache-Control": "no-store"
    });
    response.end(`\ufeff${lines.join("\r\n")}`);
    return;
  }
  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Student Bookings");
    sheet.columns = columns.map(([header, key]) => ({ header, key, width: Math.max(16, header.length + 2) }));
    records.forEach((record, index) => sheet.addRow({ ...record, number: index + 1 }));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173D65" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const buffer = await workbook.xlsx.writeBuffer();
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="attachflow-bookings-${date}.xlsx"`,
      "Cache-Control": "no-store"
    });
    response.end(Buffer.from(buffer));
    return;
  }
  if (format === "pdf") {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, info: { Title: "AttachFlow Student Booking Records" } });
    const chunks = [];
    document.on("data", chunk => chunks.push(chunk));
    const finished = new Promise((resolvePromise, rejectPromise) => {
      document.on("end", resolvePromise);
      document.on("error", rejectPromise);
    });
    document.fontSize(18).fillColor("#173d65").text("AttachFlow Student Booking Records");
    document.moveDown(0.35).fontSize(9).fillColor("#64748b").text(`Generated ${new Date().toLocaleString()} · ${records.length} booking${records.length === 1 ? "" : "s"}`);
    document.moveDown();
    const widths = [30, 106, 90, 130, 76, 62, 170, 56];
    const headers = ["No.", "Full Name", "Admission Number", "Course", "Campus", "Year", "Hospital", "Status"];
    const drawRow = (values, header = false) => {
      const startX = document.x;
      const rowY = document.y;
      const rowHeight = header ? 24 : 30;
      if (rowY + rowHeight > document.page.height - document.page.margins.bottom) document.addPage();
      const y = document.y;
      let x = document.page.margins.left;
      values.forEach((value, index) => {
        document.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 8 : 7).fillColor(header ? "#173d65" : "#172b4d").text(String(value ?? ""), x + 3, y + 6, { width: widths[index] - 6, height: rowHeight - 8, ellipsis: true, lineBreak: false });
        x += widths[index];
      });
      document.moveTo(startX, y + rowHeight).lineTo(startX + widths.reduce((sum, width) => sum + width, 0), y + rowHeight).strokeColor("#e4eaf2").stroke();
      document.y = y + rowHeight;
    };
    drawRow(headers, true);
    records.forEach((record, index) => drawRow([index + 1, record.fullName, record.admissionNumber, record.course, record.campus, record.yearOfStudy, record.hospital, record.status]));
    document.end();
    await finished;
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="attachflow-bookings-${date}.pdf"`,
      "Cache-Control": "no-store"
    });
    response.end(Buffer.concat(chunks));
    return;
  }
  throw new HttpError(400, "Choose CSV, XLSX, or PDF export format.");
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" })[extension] || "application/octet-stream";
}

function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "attachflow.html" : decodeURIComponent(pathname.slice(1));
  if (!publicStaticFiles.has(requested)) throw new HttpError(404, "Page not found.");
  const path = resolve(root, requested);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path)) throw new HttpError(404, "Page not found.");
  response.writeHead(200, {
    "Content-Type": contentType(path),
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  createReadStream(path).pipe(response);
}

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  const path = url.pathname;
  response.setHeader("Cache-Control", "no-store");

  if (method === "GET" && path === "/api/session") {
    const session = getSession(request);
    return jsonResponse(response, 200, session
      ? { authenticated: true, username: session.username, fullName: session.fullName, role: session.role, csrfToken: session.csrfToken, expiresAt: session.expiresAt }
      : { authenticated: false });
  }

  if (method === "POST" && path === "/api/auth/verify-email") {
    assertSameOrigin(request);
    rateLimit(request, "admin-email-verification", 10, 15 * 60 * 1000);
    const body = await readJson(request);
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 200) {
      throw new HttpError(400, "This verification link is invalid or has expired.");
    }
    const tokenHash = hashEmailToken(body.token);
    const token = database.prepare(`
      SELECT administrator_id AS administratorId, expires_at AS expiresAt
      FROM administrator_email_tokens WHERE token_hash = ? AND purpose = 'verify_email'
    `).get(tokenHash);
    if (!token || Date.parse(token.expiresAt) <= Date.now()) {
      database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(tokenHash);
      throw new HttpError(400, "This verification link is invalid or has expired.");
    }
    transaction(() => {
      database.prepare("UPDATE administrators SET email_verified = 1, email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), token.administratorId);
      database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(tokenHash);
      logActivity(token.administratorId, "Administrator email verified", "Email address verified using a one-time email link");
    });
    return jsonResponse(response, 200, { verified: true });
  }

  if (method === "POST" && path === "/api/auth/register") {
    assertSameOrigin(request);
    rateLimit(request, "administrator-registration", 8, 15 * 60 * 1000);
    const body = await readJson(request);
    const tokenValue = body.token;
    if (typeof tokenValue !== "string" || tokenValue.length < 32 || tokenValue.length > 200) {
      throw new HttpError(400, "A valid Super Administrator invitation is required.");
    }
    const fullName = requireText(body.fullName, "Full name", 120);
    const username = requireText(body.username, "Username", 80);
    const email = requireText(body.email, "Email address", 254).toLowerCase();
    const password = body.password;
    if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) throw new HttpError(400, "Username must contain 3-80 letters, numbers, dots, underscores or hyphens.");
    if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
    if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      throw new HttpError(400, "Choose a password with at least 12 characters and no more than 72 UTF-8 bytes.");
    }
    if (password !== body.confirmPassword) throw new HttpError(400, "The passwords do not match.");
    const passwordHash = await bcrypt.hash(password, 12);
    let created;
    try {
      created = transaction(() => {
        const token = database.prepare(`
          SELECT email, role, invited_by AS invitedBy, expires_at AS expiresAt
          FROM administrator_email_tokens WHERE token_hash = ? AND purpose = 'invite'
        `).get(hashEmailToken(tokenValue));
        if (!token || Date.parse(token.expiresAt) <= Date.now() || token.email.toLowerCase() !== email) {
          throw new HttpError(400, "This invitation is invalid, expired, or for a different email address.");
        }
        if (database.prepare("SELECT 1 FROM administrators WHERE username = ? COLLATE NOCASE").get(username)) {
          throw new HttpError(409, "That username is already in use.");
        }
        if (database.prepare("SELECT 1 FROM administrators WHERE email = ? COLLATE NOCASE").get(email)) {
          throw new HttpError(409, "That email address is already registered.");
        }
        const now = new Date().toISOString();
        const result = database.prepare(`
          INSERT INTO administrators (username, full_name, email, password_hash, role, suspended, email_verified, email_verified_at, created_at)
          VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
        `).run(username, fullName, email, passwordHash, token.role, now, now);
        database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(hashEmailToken(tokenValue));
        logActivity(token.invitedBy, "Administrator invitation accepted", `${username} registered with ${token.role} role`);
        return { id: Number(result.lastInsertRowid), username, role: token.role };
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) throw new HttpError(409, "That username or email address is already registered.");
      throw error;
    }
    return jsonResponse(response, 201, { created: true, administrator: created });
  }

  if (method === "POST" && path === "/api/auth/password-reset/request") {
    assertSameOrigin(request);
    rateLimit(request, "administrator-password-reset", 5, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
    const responseMessage = "If an active administrator account uses that email, a password reset link has been sent.";
    const administrator = database.prepare(`
      SELECT id, email FROM administrators
      WHERE email = ? COLLATE NOCASE AND email_verified = 1 AND suspended = 0
    `).get(email);
    if (!administrator) return jsonResponse(response, 200, { message: responseMessage });

    const tokenValue = createEmailToken();
    const tokenHash = hashEmailToken(tokenValue);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    transaction(() => {
      database.prepare("DELETE FROM administrator_email_tokens WHERE administrator_id = ? AND purpose = 'password_reset'").run(administrator.id);
      database.prepare(`
        INSERT INTO administrator_email_tokens (token_hash, purpose, administrator_id, email, expires_at, created_at)
        VALUES (?, 'password_reset', ?, ?, ?, ?)
      `).run(tokenHash, administrator.id, administrator.email, expiresAt, now);
    });
    void sendAdminActionEmail(
      administrator.email,
      "Reset Administrator Password",
      "A password reset was requested for your AttachFlow administrator account. The link expires in one hour.",
      actionLink(request, "adminReset", tokenValue),
      "Reset password"
    ).catch(() => {
      database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(tokenHash);
      console.error("Administrator password recovery email could not be sent.");
    });
    return jsonResponse(response, 200, { message: responseMessage });
  }

  if (method === "POST" && path === "/api/auth/password-reset/complete") {
    assertSameOrigin(request);
    rateLimit(request, "administrator-password-reset-complete", 10, 15 * 60 * 1000);
    const body = await readJson(request);
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 200) {
      throw new HttpError(400, "This password reset link is invalid or has expired.");
    }
    const password = body.password;
    if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      throw new HttpError(400, "Choose a password with at least 12 characters and no more than 72 UTF-8 bytes.");
    }
    if (password !== body.confirmPassword) throw new HttpError(400, "The passwords do not match.");
    const tokenHash = hashEmailToken(body.token);
    const token = database.prepare(`
      SELECT administrator_id AS administratorId, expires_at AS expiresAt
      FROM administrator_email_tokens WHERE token_hash = ? AND purpose = 'password_reset'
    `).get(tokenHash);
    if (!token || Date.parse(token.expiresAt) <= Date.now()) {
      database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(tokenHash);
      throw new HttpError(400, "This password reset link is invalid or has expired.");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    transaction(() => {
      const update = database.prepare("UPDATE administrators SET password_hash = ? WHERE id = ? AND email_verified = 1 AND suspended = 0")
        .run(passwordHash, token.administratorId);
      if (Number(update.changes) !== 1) throw new HttpError(409, "This account cannot be reset. Contact a Super Administrator.");
      database.prepare("DELETE FROM administrator_email_tokens WHERE administrator_id = ?").run(token.administratorId);
      logActivity(token.administratorId, "Administrator password reset", "Password reset using a one-time email link");
    });
    invalidateAdministratorSessions(token.administratorId);
    return jsonResponse(response, 200, { reset: true });
  }

  if (method === "POST" && path === "/api/admin/login") {
    assertSameOrigin(request);
    rateLimit(request, "admin-login", 8, 15 * 60 * 1000);
    const body = await readJson(request);
    const username = requireText(body.username, "Username", 80);
    if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 200) {
      throw new HttpError(400, "Enter your username and password.");
    }
    const administrator = database.prepare(`
      SELECT id, username, full_name AS fullName, email, password_hash AS passwordHash, role, suspended, email_verified AS emailVerified
      FROM administrators WHERE username = ? COLLATE NOCASE
    `).get(username);
    const storedHash = administrator ? administrator.passwordHash : await dummyBcryptHash;
    const valid = await verifyPassword(body.password, storedHash);
    if (!administrator || !valid || administrator.suspended) throw new HttpError(401, "Username or password is incorrect.");
    if (!administrator.emailVerified) throw new HttpError(403, "Verify your email address using the link we sent before signing in.");
    if (!administrator.passwordHash.startsWith("$2") && Buffer.byteLength(body.password, "utf8") <= 72) {
      const upgradedHash = await bcrypt.hash(body.password, 12);
      database.prepare("UPDATE administrators SET password_hash = ? WHERE id = ?").run(upgradedHash, administrator.id);
    }
    const session = startAdminSession(response, administrator);
    return jsonResponse(response, 200, {
      authenticated: true,
      username: session.username,
      fullName: session.fullName,
      role: session.role,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    });
  }

  if (method === "POST" && path === "/api/student/bookings") {
    assertSameOrigin(request);
    rateLimit(request, "student-booking", 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const fullName = requireText(body.fullName, "Full name", 120);
    const admissionNumber = requireText(body.admissionNumber, "Admission number", 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9/-]{2,39}$/.test(admissionNumber)) {
      throw new HttpError(400, "Enter a valid admission number using letters, numbers, hyphens, or slashes.");
    }
    if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]{1,119}$/u.test(fullName)) {
      throw new HttpError(400, "Enter your full official name.");
    }
    const hospitalId = Number(body.hospitalId);
    if (!Number.isSafeInteger(hospitalId) || hospitalId < 1) throw new HttpError(400, "Select a valid hospital.");
    const id = randomUUID();
    const cancelToken = randomBytes(32).toString("base64url");
    const cancelTokenHash = createHash("sha256").update(cancelToken).digest("hex");
    try {
      const record = transaction(() => {
        const hospital = database.prepare(`${hospitalSelect} WHERE h.id = ? GROUP BY h.id`).get(hospitalId);
        if (!hospital) throw new HttpError(404, "The selected hospital was not found.");
        if (hospital.manually_locked) throw new HttpError(409, "Bookings at this hospital are locked.");
        if (Number(hospital.booked) >= Number(hospital.capacity)) throw new HttpError(409, "This hospital is full. Choose another hospital.");
        database.prepare(`
          INSERT INTO student_bookings
            (id, hospital_id, full_name, admission_number, course, campus, year_of_study, cancel_token_hash, status, created_at)
          VALUES (?, ?, ?, ?, 'OCCUPATIONAL THERAPY', 'KMTC NAIROBI CAMPUS', '3.2', ?, 'Booked', ?)
        `).run(id, hospitalId, fullName, admissionNumber, cancelTokenHash, new Date().toISOString());
        const record = database.prepare(`
          SELECT b.id, b.full_name AS fullName, b.admission_number AS admissionNumber,
            b.course, b.campus, b.year_of_study AS yearOfStudy, b.status,
            b.hospital_id AS hospitalId, h.name AS hospital
          FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id WHERE b.id = ?
        `).get(id);
        logActivity(null, "Student booking", `New booking at ${record.hospital}`);
        const booked = Number(database.prepare("SELECT COUNT(*) AS count FROM student_bookings WHERE hospital_id = ?").get(hospitalId).count);
        if (booked >= Number(hospital.capacity)) logActivity(null, "Hospital full", `${record.hospital} reached its booking capacity`);
        return record;
      });
      const hospital = listHospitals().find(item => item.id === record.hospitalId);
      return jsonResponse(response, 201, { booking: record, hospital, cancelToken });
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR" || String(error.message).includes("UNIQUE constraint failed")) {
        if (String(error.message).includes("admission_number")) {
          logActivity(null, "Duplicate admission attempt", "A duplicate admission number was rejected.");
          throw new HttpError(409, "This admission number already has a booking.");
        }
        if (String(error.message).includes("hospital_full")) throw new HttpError(409, "This hospital is full. Choose another hospital.");
      }
      if (error.message === "hospital_locked") throw new HttpError(409, "Bookings at this hospital are locked.");
      if (error.message === "hospital_full") throw new HttpError(409, "This hospital is full. Choose another hospital.");
      throw error;
    }
  }

  const studentCancelMatch = path.match(/^\/api\/student\/bookings\/([a-f0-9-]+)$/i);
  if (method === "DELETE" && studentCancelMatch) {
    assertSameOrigin(request);
    rateLimit(request, "student-cancel", 10, 15 * 60 * 1000);
    const body = await readJson(request);
    if (typeof body.cancelToken !== "string" || body.cancelToken.length < 32 || body.cancelToken.length > 100) {
      throw new HttpError(403, "This booking cannot be cancelled from this browser. Contact the administrator.");
    }
    const booking = database.prepare(`
      SELECT b.id, b.full_name AS fullName, b.admission_number AS admissionNumber,
        b.hospital_id AS hospitalId, b.cancel_token_hash AS cancelTokenHash,
        b.created_at AS createdAt, h.name AS hospital
      FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id WHERE b.id = ?
    `).get(studentCancelMatch[1]);
    if (!booking) throw new HttpError(404, "Booking not found.");
    const submittedHash = createHash("sha256").update(body.cancelToken).digest();
    const storedHash = Buffer.from(booking.cancelTokenHash, "hex");
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      throw new HttpError(403, "This booking cannot be cancelled from this browser. Contact the administrator.");
    }
    transaction(() => {
      archiveBooking(booking, null, "Cancelled by student");
      database.prepare("DELETE FROM student_bookings WHERE id = ?").run(booking.id);
      logActivity(null, "Student booking cancelled", `Booking cancelled at ${booking.hospital}`);
    });
    return jsonResponse(response, 200, { success: true, hospital: listHospitals().find(hospital => hospital.id === booking.hospitalId) });
  }

  if (method === "POST" && path === "/api/student/lookup") {
    assertSameOrigin(request);
    rateLimit(request, "student-lookup", 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const admissionNumber = requireText(body.admissionNumber, "Admission number", 40).toUpperCase();
    const booking = database.prepare(`
      SELECT b.id, b.status, h.name AS hospital
      FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id
      WHERE b.admission_number = ? COLLATE NOCASE
    `).get(admissionNumber);
    return jsonResponse(response, 200, { found: Boolean(booking), booking: booking || null });
  }

  if (method === "GET" && path === "/api/hospitals") {
    return jsonResponse(response, 200, { hospitals: listHospitals() });
  }

  if (path.startsWith("/api/admin/")) {
    if (path === "/api/admin/login") throw new HttpError(405, "Method not allowed.");
    if (method === "POST" && path === "/api/admin/logout") {
      const session = requireAdmin(request);
      const id = cookieMap(request).af_session;
      sessions.delete(id);
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return jsonResponse(response, 200, { success: true }, { "Set-Cookie": `af_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
    }
    const session = requireAdmin(request, method !== "GET", method !== "GET");
    if (method === "GET" && path === "/api/admin/overview") {
      const hospitals = listHospitals();
      const bookings = listBookings({});
      const cancellationCount = Number(database.prepare("SELECT COUNT(*) AS count FROM booking_history").get().count);
      return jsonResponse(response, 200, {
        totalBookings: bookings.length,
        totalHospitals: hospitals.length,
        totalStudents: Number(database.prepare("SELECT COUNT(DISTINCT admission_number) AS count FROM student_bookings").get().count),
        availableSlots: hospitals.reduce((sum, hospital) => sum + hospital.availableSlots, 0),
        fullHospitals: hospitals.filter(hospital => hospital.full).length,
        availableHospitals: hospitals.filter(hospital => !hospital.full && !hospital.manuallyLocked).length,
        lockedHospitals: hospitals.filter(hospital => hospital.manuallyLocked).length,
        cancelledBookings: cancellationCount,
        bookingsByHospital: hospitals.map(hospital => ({
          id: hospital.id,
          name: hospital.name,
          county: hospital.county,
          bookings: hospital.booked,
          capacity: hospital.capacity,
          availableSlots: hospital.availableSlots,
          occupancyRate: hospital.capacity ? Math.round(hospital.booked / hospital.capacity * 100) : 0,
          full: hospital.full,
          locked: hospital.locked
        }))
      });
    }
    if (method === "GET" && path === "/api/admin/hospitals") return jsonResponse(response, 200, { hospitals: listHospitals() });
    if (method === "GET" && path === "/api/admin/bookings") return jsonResponse(response, 200, { bookings: listBookings({
      query: (url.searchParams.get("q") || "").trim().slice(0, 100),
      hospitalId: url.searchParams.get("hospitalId") || "",
      course: url.searchParams.get("course") || "",
      campus: url.searchParams.get("campus") || "",
      yearOfStudy: url.searchParams.get("yearOfStudy") || ""
    }) });
    if (method === "GET" && path === "/api/admin/booking-history") return jsonResponse(response, 200, {
      bookings: listCancelledBookings({
        query: (url.searchParams.get("q") || "").trim().slice(0, 100),
        hospitalId: url.searchParams.get("hospitalId") || ""
      })
    });
    if (method === "GET" && path === "/api/admin/logs") {
      const logs = database.prepare(`
        SELECT l.id, a.username AS administrator, l.action, l.details, l.created_at AS createdAt
        FROM activity_logs l LEFT JOIN administrators a ON a.id = l.administrator_id
        ORDER BY l.id DESC LIMIT 200
      `).all();
      return jsonResponse(response, 200, { logs });
    }
    if (method === "GET" && path === "/api/admin/notifications") {
      const notifications = database.prepare(`
        SELECT l.id, l.action, l.details, l.created_at AS createdAt, a.username AS administrator
        FROM activity_logs l LEFT JOIN administrators a ON a.id = l.administrator_id
        WHERE l.action IN (
          'Student booking', 'Hospital full', 'Hospital capacity changed',
          'Student booking cancelled', 'Hospital locked', 'Hospital unlocked',
          'Duplicate admission attempt', 'Hospital capacity increased', 'Hospital capacity decreased'
        )
        ORDER BY l.id DESC LIMIT 50
      `).all();
      return jsonResponse(response, 200, { notifications });
    }
    if (method === "GET" && path === "/api/admin/administrators") {
      requireSuperAdministrator(session);
      const administrators = database.prepare(`
        SELECT id, full_name AS fullName, username, email, role, suspended,
          email_verified AS emailVerified, created_at AS createdAt,
          CASE WHEN suspended = 1 THEN 'Suspended'
            WHEN email_verified = 0 THEN 'Pending email verification'
            ELSE 'Active' END AS accountStatus
        FROM administrators ORDER BY created_at, id
      `).all();
      return jsonResponse(response, 200, { administrators });
    }
    if (method === "POST" && path === "/api/admin/administrators") {
      requireSuperAdministrator(session);
      const body = await readJson(request);
      const fullName = requireText(body.fullName, "Full name", 120);
      const username = requireText(body.username, "Username", 80);
      const email = requireText(body.email, "Email", 254).toLowerCase();
      const role = body.role;
      if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) throw new HttpError(400, "Username must contain 3-80 letters, numbers, dots, underscores or hyphens.");
      if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid administrator email address.");
      if (!["super_admin", "admin", "read_only_admin"].includes(role)) throw new HttpError(400, "Select a valid administrator role.");
      const tokenValue = createEmailToken();
      const tokenHash = hashEmailToken(tokenValue);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      transaction(() => {
        if (database.prepare("SELECT 1 FROM administrators WHERE username = ? COLLATE NOCASE").get(username)) {
          throw new HttpError(409, "That username is already in use.");
        }
        if (database.prepare("SELECT 1 FROM administrators WHERE email = ? COLLATE NOCASE").get(email)) {
          throw new HttpError(409, "That email address is already registered.");
        }
        if (database.prepare("SELECT 1 FROM administrator_email_tokens WHERE purpose = 'invite' AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND expires_at > ?").get(username, email, now)) {
          throw new HttpError(409, "An active invitation already uses that username or email address.");
        }
        database.prepare(`
          INSERT INTO administrator_email_tokens
            (token_hash, purpose, full_name, username, email, role, invited_by, expires_at, created_at)
          VALUES (?, 'invite', ?, ?, ?, ?, ?, ?, ?)
        `).run(tokenHash, fullName, username, email, role, session.administratorId, expiresAt, now);
      });
      try {
        await sendAdminActionEmail(
          email,
          "Administrator account invitation",
          `A Super Administrator invited you to create an AttachFlow account with the ${role.replaceAll("_", " ")} role. This invitation expires in 48 hours.`,
          actionLink(request, "adminInvite", tokenValue),
          "Accept invitation"
        );
      } catch {
        database.prepare("DELETE FROM administrator_email_tokens WHERE token_hash = ?").run(tokenHash);
        console.error("Administrator invitation email could not be sent.");
        throw new HttpError(503, "Unable to send the administrator invitation right now. Please try again later.");
      }
      logActivity(session.administratorId, "Administrator invitation sent", `${username} invited with ${role} role`);
      return jsonResponse(response, 201, { invited: true, email, expiresAt });
    }
    const administratorMatch = path.match(/^\/api\/admin\/administrators\/(\d+)\/suspension$/);
    if (method === "PUT" && administratorMatch) {
      requireSuperAdministrator(session);
      const administratorId = Number(administratorMatch[1]);
      if (administratorId === session.administratorId) throw new HttpError(409, "You cannot suspend your own active administrator account.");
      const body = await readJson(request);
      if (typeof body.suspended !== "boolean") throw new HttpError(400, "Choose whether the administrator account should be suspended.");
      const target = database.prepare("SELECT id, username, role, suspended FROM administrators WHERE id = ?").get(administratorId);
      if (!target) throw new HttpError(404, "Administrator not found.");
      if (body.suspended && target.role === "super_admin" && !target.suspended) {
        const activeSuperAdmins = Number(database.prepare("SELECT COUNT(*) AS count FROM administrators WHERE role = 'super_admin' AND suspended = 0").get().count);
        if (activeSuperAdmins <= 1) throw new HttpError(409, "At least one active Super Administrator must remain.");
      }
      database.prepare("UPDATE administrators SET suspended = ? WHERE id = ?").run(body.suspended ? 1 : 0, administratorId);
      if (body.suspended) {
        for (const [id, activeSession] of sessions) {
          if (activeSession.administratorId === administratorId) sessions.delete(id);
        }
      }
      logActivity(session.administratorId, body.suspended ? "Administrator suspended" : "Administrator reactivated", target.username);
      return jsonResponse(response, 200, { success: true, suspended: body.suspended });
    }
    if (method === "PUT" && path === "/api/admin/profile") {
      const body = await readJson(request);
      const fullName = requireText(body.fullName, "Full name", 120);
      const email = requireText(body.email, "Email", 254).toLowerCase();
      const username = requireText(body.username, "Username", 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
      if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) throw new HttpError(400, "Username must contain 3-80 letters, numbers, dots, underscores or hyphens.");
      const current = database.prepare("SELECT username, email FROM administrators WHERE id = ?").get(session.administratorId);
      const usernameChanged = username !== current.username;
      const emailChanged = email !== current.email.toLowerCase();
      if (usernameChanged) requireSuperAdministrator(session);
      if (database.prepare("SELECT 1 FROM administrators WHERE lower(username) = lower(?) AND id != ?").get(username, session.administratorId)) {
        throw new HttpError(409, "That username is already in use.");
      }
      if (emailChanged && database.prepare("SELECT 1 FROM administrators WHERE email = ? COLLATE NOCASE AND id != ?").get(email, session.administratorId)) {
        throw new HttpError(409, "That email address is already registered.");
      }
      if (emailChanged) {
        const verificationToken = createEmailToken();
        const tokenHash = hashEmailToken(verificationToken);
        const now = new Date().toISOString();
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("DELETE FROM administrator_email_tokens WHERE administrator_id = ? AND purpose = 'verify_email'").run(session.administratorId);
          database.prepare(`
            UPDATE administrators SET full_name = ?, email = ?, username = ?, email_verified = 0, email_verified_at = NULL
            WHERE id = ?
          `).run(fullName, email, username, session.administratorId);
          database.prepare(`
            INSERT INTO administrator_email_tokens (token_hash, purpose, administrator_id, email, expires_at, created_at)
            VALUES (?, 'verify_email', ?, ?, ?, ?)
          `).run(tokenHash, session.administratorId, email, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), now);
          try {
            await sendAdminActionEmail(
              email,
              "Verify updated administrator email",
              "Verify this email address to reactivate access to your AttachFlow administrator account. The link expires in 24 hours.",
              actionLink(request, "adminVerify", verificationToken),
              "Verify email"
            );
          } catch {
            console.error("Administrator email verification message could not be sent.");
            throw new HttpError(503, "Unable to send an email verification link right now. Your profile was not changed.");
          }
          logActivity(session.administratorId, "Administrator email changed", `${session.username} must verify the new email address`);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } else {
        database.prepare("UPDATE administrators SET full_name = ?, username = ? WHERE id = ?").run(fullName, username, session.administratorId);
        logActivity(session.administratorId, "Administrator profile updated", usernameChanged ? "Name and username updated" : "Name updated");
      }
      session.fullName = fullName;
      session.username = username;
      if (usernameChanged || emailChanged) {
        invalidateAdministratorSessions(session.administratorId);
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        return jsonResponse(response, 200, { fullName, username, email, credentialsChanged: true, emailVerificationRequired: emailChanged }, {
          "Set-Cookie": `af_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
        });
      }
      return jsonResponse(response, 200, { fullName, username, email, credentialsChanged: false });
    }
    if (method === "PUT" && path === "/api/admin/password") {
      const body = await readJson(request);
      if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || typeof body.confirmPassword !== "string") {
        throw new HttpError(400, "Enter your current password, new password, and password confirmation.");
      }
      if (body.newPassword.length < 12 || Buffer.byteLength(body.newPassword, "utf8") > 72) {
        throw new HttpError(400, "Choose a password with at least 12 characters and no more than 72 UTF-8 bytes.");
      }
      if (body.newPassword !== body.confirmPassword) throw new HttpError(400, "The new passwords do not match.");
      const administrator = database.prepare("SELECT password_hash AS passwordHash FROM administrators WHERE id = ?").get(session.administratorId);
      if (!await verifyPassword(body.currentPassword, administrator.passwordHash)) throw new HttpError(403, "The current password is incorrect.");
      const passwordHash = await bcrypt.hash(body.newPassword, 12);
      database.prepare("UPDATE administrators SET password_hash = ? WHERE id = ?").run(passwordHash, session.administratorId);
      for (const [id, activeSession] of sessions) {
        if (activeSession.administratorId === session.administratorId) sessions.delete(id);
      }
      logActivity(session.administratorId, "Administrator password changed", "Password changed by account owner");
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return jsonResponse(response, 200, { success: true }, {
        "Set-Cookie": `af_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
      });
    }
    if (method === "POST" && path === "/api/admin/backup") {
      requireSuperAdministrator(session);
      const directory = mkdtempSync(resolve(tmpdir(), "attachflow-backup-"));
      const backupPath = resolve(directory, "attachflow.sqlite");
      try {
        database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        logActivity(session.administratorId, "Database backup created", "SQLite backup downloaded by Super Administrator");
        response.writeHead(200, {
          "Content-Type": "application/vnd.sqlite3",
          "Content-Disposition": `attachment; filename="attachflow-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.on("close", () => rmSync(directory, { recursive: true, force: true }));
        createReadStream(backupPath).pipe(response);
        return;
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    }
    if (method === "GET" && path === "/api/admin/settings") {
      return jsonResponse(response, 200, {
        profile: database.prepare("SELECT full_name AS fullName, username, email, role FROM administrators WHERE id = ?").get(session.administratorId),
        course: "OCCUPATIONAL THERAPY",
        campus: "KMTC NAIROBI CAMPUS",
        yearOfStudy: "3.2",
        uniqueAdmissionNumbers: true,
        sessionLifetimeHours: sessionLifetimeMs / (60 * 60 * 1000),
        database: "SQLite"
      });
    }
    if (method === "GET" && path === "/api/admin/export") return sendExport(request, response, url.searchParams.get("format") || "");
    if (method === "POST" && path === "/api/admin/hospitals") {
      const body = await readJson(request);
      const name = requireText(body.name, "Hospital name", 160);
      const county = requireText(body.county, "County", 100);
      const department = body.department === undefined ? "Occupational Therapy" : requireText(body.department, "Department", 120);
      const capacity = Number(body.capacity);
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new HttpError(400, "Capacity must be a whole number between 1 and 100000.");
      const result = database.prepare("INSERT INTO hospitals (name, county, department, capacity) VALUES (?, ?, ?, ?)").run(name, county, department, capacity);
      logActivity(session.administratorId, "Hospital added", `${name} (${capacity} slots)`);
      return jsonResponse(response, 201, { hospital: listHospitals().find(hospital => hospital.id === Number(result.lastInsertRowid)) });
    }
    const hospitalMatch = path.match(/^\/api\/admin\/hospitals\/(\d+)(?:\/lock)?$/);
    if (hospitalMatch) {
      const id = Number(hospitalMatch[1]);
      const hospital = database.prepare("SELECT * FROM hospitals WHERE id = ?").get(id);
      if (!hospital) throw new HttpError(404, "Hospital not found.");
      if (path.endsWith("/lock") && method === "PUT") {
        const body = await readJson(request);
        if (typeof body.locked !== "boolean") throw new HttpError(400, "Choose whether bookings should be locked.");
        database.prepare("UPDATE hospitals SET manually_locked = ? WHERE id = ?").run(body.locked ? 1 : 0, id);
        logActivity(session.administratorId, body.locked ? "Hospital locked" : "Hospital unlocked", hospital.name);
        return jsonResponse(response, 200, { hospital: listHospitals().find(item => item.id === id) });
      }
      if (method === "PUT" && !path.endsWith("/lock")) {
        const body = await readJson(request);
        const name = requireText(body.name, "Hospital name", 160);
        const county = requireText(body.county, "County", 100);
        const department = requireText(body.department, "Department", 120);
        const capacity = Number(body.capacity);
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new HttpError(400, "Capacity must be a whole number between 1 and 100000.");
        const booked = Number(database.prepare("SELECT COUNT(*) AS count FROM student_bookings WHERE hospital_id = ?").get(id).count);
        if (capacity < booked) throw new HttpError(409, `Capacity cannot be below the ${booked} current booking${booked === 1 ? "" : "s"}.`);
        transaction(() => {
          database.prepare("UPDATE hospitals SET name = ?, county = ?, department = ?, capacity = ? WHERE id = ?").run(name, county, department, capacity, id);
          if (capacity !== hospital.capacity) {
            const increased = capacity > hospital.capacity;
            logActivity(session.administratorId, increased ? "Hospital capacity increased" : "Hospital capacity decreased", `${hospital.name}: ${hospital.capacity} to ${capacity} slots`);
            logActivity(session.administratorId, "Hospital capacity changed", `${hospital.name}: ${hospital.capacity} to ${capacity} slots`);
          }
          if (name !== hospital.name || county !== hospital.county || department !== hospital.department) {
            logActivity(session.administratorId, "Hospital updated", `${hospital.name}: details changed`);
          }
        });
        return jsonResponse(response, 200, { hospital: listHospitals().find(item => item.id === id) });
      }
      if (method === "DELETE" && !path.endsWith("/lock")) {
        const removedBookings = transaction(() => {
          const bookings = database.prepare(`
            SELECT b.id, b.full_name AS fullName, b.admission_number AS admissionNumber,
              b.hospital_id AS hospitalId, b.created_at AS createdAt, h.name AS hospital
            FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id
            WHERE b.hospital_id = ?
          `).all(id);
          for (const booking of bookings) archiveBooking(booking, session.administratorId, "Hospital deleted");
          const count = bookings.length;
          database.prepare("DELETE FROM hospitals WHERE id = ?").run(id);
          logActivity(session.administratorId, "Hospital deleted", `${hospital.name}; ${count} active booking${count === 1 ? "" : "s"} archived`);
          return count;
        });
        return jsonResponse(response, 200, { success: true, removedBookings });
      }
    }
    const bookingMatch = path.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)$/i);
    if (method === "DELETE" && bookingMatch) {
      const booking = database.prepare(`
        SELECT b.id, b.full_name AS fullName, b.admission_number AS admissionNumber,
          b.hospital_id AS hospitalId, b.created_at AS createdAt, h.name AS hospital
        FROM student_bookings b JOIN hospitals h ON h.id = b.hospital_id WHERE b.id = ?
      `).get(bookingMatch[1]);
      if (!booking) throw new HttpError(404, "Booking not found.");
      transaction(() => {
        archiveBooking(booking, session.administratorId, "Removed by administrator");
        database.prepare("DELETE FROM student_bookings WHERE id = ?").run(booking.id);
        logActivity(session.administratorId, "Booking removed", `${booking.fullName} booking removed from ${booking.hospital}`);
      });
      return jsonResponse(response, 200, { success: true });
    }
    throw new HttpError(404, "Admin API endpoint not found.");
  }

  throw new HttpError(404, "API endpoint not found.");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", requestOrigin(request));
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    if (["/admin/setup", "/setup", "/setup.html", "/setup.js", "/create-admin.js"].includes(url.pathname)) {
      throw new HttpError(404, "Create the first administrator from the VS Code terminal.");
    }
    if (url.pathname === "/admin") {
      if (!getSession(request)) {
        response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      serveStatic("/", response);
      return;
    }
    serveStatic(url.pathname, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof HttpError ? error.status : String(error.message).includes("UNIQUE constraint failed") ? 409 : 500;
    if (status >= 500) console.error("AttachFlow request failed:", error);
    const message = status === 409 && String(error.message).includes("UNIQUE constraint failed")
      ? "A hospital with that name or admission number already exists."
      : error instanceof HttpError ? error.message : "The request could not be completed.";
    jsonResponse(response, status, { error: message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`AttachFlow running at http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
  if (Number(database.prepare("SELECT COUNT(*) AS count FROM administrators").get().count) === 0) {
    console.log('Create the first Super Administrator from the VS Code terminal with "npm run admin:create".');
  }
});
