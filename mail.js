import nodemailer from "nodemailer";

export function emailTransportFromEnvironment() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error("Gmail SMTP is not configured. Set SMTP_USER and SMTP_PASS in the local environment.");
  }
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a valid port number.");
  return {
    transporter: nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: { user, pass }
    }),
    from: process.env.SMTP_FROM || user
  };
}

export async function sendAdministratorEmail({ to, subject, text, html }) {
  const { transporter, from } = emailTransportFromEnvironment();
  await transporter.sendMail({ from, to, subject, text, html });
}

export function applicationOrigin(request) {
  const configuredOrigin = process.env.ATTACHFLOW_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  if (configuredOrigin) return configuredOrigin.replace(/\/+$/, "");
  const host = request.headers.host || "127.0.0.1:3000";
  return `${request.socket.encrypted ? "https" : "http"}://${host}`;
}

export function actionLink(request, key, token) {
  const link = new URL("/", applicationOrigin(request));
  link.searchParams.set(key, token);
  return link.toString();
}
