import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { createPaymentApp } from '../index.js';
import { EmailOtpService, isDeliverableEmail } from '../services/email-otp.service.js';
import { Database } from '@youpi/db';
import { authFetch } from '../../../../scripts/test-support.js';

/** WhatsApp stand-in so this suite never opens a real WhatsApp connection. */
const stubBerry = {
  sendOtp: async () => ({ success: true, delivered: false, simulated: true }),
  disconnect: async () => {}
};

function startApp(t, port, emailOtpService, otpCooldownMs = 0) {
  const app = createPaymentApp(new Database({ inMemory: true }), {
    otpCooldownMs,
    whatsappBerryService: stubBerry,
    emailOtpService
  });
  return new Promise(resolve => {
    const server = app.rawServer.listen(port, () => {
      t.after(() => { app.destroy(); server.close(); });
      resolve(`http://localhost:${port}`);
    });
  });
}

function post(base, path, body) {
  return authFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('isDeliverableEmail rejects the generated placeholder address', () => {
  assert.equal(isDeliverableEmail('rohan@example.com'), true);
  assert.equal(isDeliverableEmail('9123456789@customer.youpi.local'), false);
  assert.equal(isDeliverableEmail(''), false);
  assert.equal(isDeliverableEmail(null), false);
});

test('EmailOtpService is disabled until SMTP is configured', () => {
  assert.equal(new EmailOtpService({ env: {} }).isConfigured(), false);
  assert.equal(new EmailOtpService({
    env: { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'shop@gmail.com', SMTP_PASS: 'app-password' }
  }).isConfigured(), true);
});

test('send-otp with channel=email', async (t) => {
  const sent = [];
  let failNext = false;
  const transport = {
    sendMail: async (mail) => {
      if (failNext) { failNext = false; throw new Error('SMTP down'); }
      sent.push(mail);
      return { messageId: `m${sent.length}` };
    }
  };
  const base = await startApp(t, 6291, new EmailOtpService({ env: {}, transport }));

  await t.test('new signup gets the code at the email they registered with', async () => {
    const res = await post(base, '/api/v1/customer/send-otp', {
      mobileNumber: '9123400001', name: 'Rohan', email: 'rohan@example.com', isNewUser: true, channel: 'email'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.channel, 'email');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'rohan@example.com');
    assert.ok(sent[0].text.includes(data.devOtp));

    const verify = await post(base, '/api/v1/customer/verify-otp', { mobileNumber: '9123400001', otp: data.devOtp });
    assert.equal(verify.status, 200);
  });

  await t.test('existing customer: code goes to the email on file, never to one in the request', async () => {
    const res = await post(base, '/api/v1/customer/send-otp', {
      mobileNumber: '9123400001', email: 'attacker@evil.example', isNewUser: true, channel: 'email'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(sent.at(-1).to, 'rohan@example.com');
    assert.ok(!data.message.includes('attacker'));
  });

  await t.test('customer without a real email on file is told to use WhatsApp', async () => {
    const otpRes = await post(base, '/api/v1/customer/send-otp', { mobileNumber: '9123400002' });
    const { devOtp } = await otpRes.json();
    const verify = await post(base, '/api/v1/customer/verify-otp', { mobileNumber: '9123400002', otp: devOtp });
    assert.equal(verify.status, 200);

    const before = sent.length;
    const res = await post(base, '/api/v1/customer/send-otp', {
      mobileNumber: '9123400002', email: 'someone@example.com', channel: 'email'
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'NO_EMAIL_ON_FILE');
    assert.equal(sent.length, before);
  });

  await t.test('SMTP failure returns 502 instead of claiming the code was sent', async () => {
    failNext = true;
    const res = await post(base, '/api/v1/customer/send-otp', { mobileNumber: '9123400001', channel: 'email' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'EMAIL_OTP_FAILED');
  });
});

test('email has its own resend window, separate from WhatsApp', async (t) => {
  let failNext = false;
  const transport = {
    sendMail: async () => {
      if (failNext) { failNext = false; throw new Error('SMTP down'); }
      return { messageId: 'm' };
    }
  };
  const base = await startApp(t, 6293, new EmailOtpService({ env: {}, transport }), 30000);
  const signup = { mobileNumber: '9123400004', name: 'Meera', email: 'meera@example.com', isNewUser: true };

  assert.equal((await post(base, '/api/v1/customer/send-otp', signup)).status, 200);
  // WhatsApp just went out; switching to email works immediately...
  assert.equal((await post(base, '/api/v1/customer/send-otp', { ...signup, channel: 'email' })).status, 200);
  // ...but a second email inside the window is throttled.
  assert.equal((await post(base, '/api/v1/customer/send-otp', { ...signup, channel: 'email' })).status, 429);
  // And so is a second WhatsApp code.
  assert.equal((await post(base, '/api/v1/customer/send-otp', signup)).status, 429);

  // A failed email send does not lock the customer out of retrying.
  const other = { mobileNumber: '9123400005', name: 'Dev', email: 'dev@example.com', isNewUser: true, channel: 'email' };
  failNext = true;
  assert.equal((await post(base, '/api/v1/customer/send-otp', other)).status, 502);
  assert.equal((await post(base, '/api/v1/customer/send-otp', other)).status, 200);
});

test('send-otp with channel=email when SMTP is not configured', async (t) => {
  const base = await startApp(t, 6292, new EmailOtpService({ env: {} }));
  const res = await post(base, '/api/v1/customer/send-otp', {
    mobileNumber: '9123400003', name: 'Asha', email: 'asha@example.com', isNewUser: true, channel: 'email'
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'EMAIL_OTP_UNAVAILABLE');

  // WhatsApp (default channel) keeps working.
  const wa = await post(base, '/api/v1/customer/send-otp', {
    mobileNumber: '9123400003', name: 'Asha', email: 'asha@example.com', isNewUser: true
  });
  assert.equal(wa.status, 200);
  assert.equal((await wa.json()).channel, 'whatsapp');
});
