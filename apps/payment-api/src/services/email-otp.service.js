import nodemailer from 'nodemailer';

/** Placeholder domain given to customers who registered without an email address. */
const PLACEHOLDER_EMAIL_DOMAIN = '@customer.youpi.local';

/**
 * Whether an address can actually receive mail (rejects the generated placeholder).
 * @param {string | null | undefined} email
 */
export function isDeliverableEmail(email) {
  return typeof email === 'string' && email.includes('@') && !email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_DOMAIN);
}

/**
 * Sends customer login OTPs by email over SMTP (e.g. Gmail with an App Password).
 *
 * Configured from SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true' for port 465),
 * SMTP_USER, SMTP_PASS and SMTP_FROM (defaults to SMTP_USER). Unconfigured = disabled.
 */
export class EmailOtpService {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, transport?: { sendMail: Function } }} [options]
   *   `transport` replaces the SMTP connection (used by tests).
   */
  constructor(options = {}) {
    const env = options.env || process.env;
    this.host = (env.SMTP_HOST || '').trim();
    this.port = Number(env.SMTP_PORT || 587);
    this.secure = String(env.SMTP_SECURE || '').toLowerCase() === 'true' || this.port === 465;
    this.user = (env.SMTP_USER || '').trim();
    this.pass = env.SMTP_PASS || '';
    this.from = (env.SMTP_FROM || this.user).trim();
    this.appName = (env.DEFAULT_APP_NAME || 'YOUPI PG').replace(/^["']|["']$/g, '');
    this.transport = options.transport || null;
  }

  /** True when an SMTP server (or injected transport) and sender address are set. */
  isConfigured() {
    return Boolean(this.transport || (this.host && this.user && this.pass && this.from));
  }

  getTransport() {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth: { user: this.user, pass: this.pass }
      });
    }
    return this.transport;
  }

  /**
   * @param {string} to recipient address (must be deliverable)
   * @param {string} otpCode 6-digit code
   * @param {string} [customerName]
   * @returns {Promise<{ success: boolean, delivered: boolean, channel: 'email', id?: string }>}
   */
  async sendOtp(to, otpCode, customerName = '') {
    if (!this.isConfigured()) throw new Error('Email OTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS).');
    if (!isDeliverableEmail(to)) throw new Error('No deliverable email address for this customer.');

    const greeting = customerName ? `Hello ${customerName},` : 'Hello,';
    const info = await this.getTransport().sendMail({
      from: this.from,
      to,
      subject: `${otpCode} is your ${this.appName} verification code`,
      text:
        `${greeting}\n\n` +
        `Your one-time login code is: ${otpCode}\n\n` +
        `It is valid for 5 minutes. Do not share this code with anyone.\n\n` +
        `— ${this.appName}`
    });
    return { success: true, delivered: true, channel: 'email', id: info?.messageId };
  }
}
