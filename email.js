// Email notifications via Gmail SMTP (nodemailer) — currently just used
// for "a bot found a new proposal" alerts (see luno-bot.js). Optional:
// silently no-ops if EMAIL_FROM/EMAIL_APP_PASSWORD aren't set, same
// pattern as this app's other optional integrations (Finnhub, Google
// sign-in). EMAIL_APP_PASSWORD must be a Gmail *app password* (Google
// Account → Security → 2-Step Verification → App passwords), not the
// account's real password — Gmail rejects real-password SMTP logins from
// apps outright.
const nodemailer = require("nodemailer");

function isConfigured() {
  return Boolean(process.env.EMAIL_FROM && process.env.EMAIL_APP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

// Resolves false (not sent) rather than throwing when email isn't
// configured or `to` is missing, so callers can fire-and-forget without
// needing to check isConfigured() themselves first.
async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t || !to) return false;
  await t.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
  return true;
}

module.exports = { isConfigured, sendMail };
