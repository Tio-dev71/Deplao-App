const nodemailer = require('nodemailer');

// SMTP configuration (Default to Resend)
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.resend.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) === 465 : true,
    auth: {
      user: process.env.SMTP_USER || 'resend',
      pass: process.env.SMTP_PASS, // API Key from Resend or App Password
    },
  });
};

/**
 * Send an email with the verification code.
 * @param {string} toEmail 
 * @param {string} code 
 */
async function sendPasswordResetEmail(toEmail, code) {
  const transporter = createTransporter();

  const mailOptions = {
    from: `"9Meta Admin" <${process.env.SMTP_FROM || 'support@tiodev.io.vn'}>`,
    to: toEmail,
    subject: 'Mã xác nhận khôi phục mật khẩu 9Meta',
    html: `
      <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #333; text-align: center;">Khôi phục mật khẩu</h2>
        <p>Chào bạn,</p>
        <p>Bạn đã yêu cầu đặt lại mật khẩu cho tài khoản <strong>${toEmail}</strong> trên hệ thống 9Meta.</p>
        <p>Mã xác nhận của bạn là:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #6366f1; background: #f3f4f6; padding: 10px 20px; border-radius: 8px;">
            ${code}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">Mã này sẽ hết hạn sau 15 phút. Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #999; font-size: 12px; text-align: center;">© 9Meta. All rights reserved.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
}

module.exports = {
  sendPasswordResetEmail,
};
