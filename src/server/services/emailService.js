const sgMail = require('@sendgrid/mail');
const AppError = require('../utils/appError');
const { formatDate, formatTime } = require('../config/timezone');

// Initialize SendGrid only when credentials are present
const sendgridEnabled = !!process.env.SENDGRID_API_KEY;

if (sendgridEnabled) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const fromEmail = process.env.EMAIL_FROM;

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {String} options.to - Recipient email
 * @param {String} options.subject - Email subject
 * @param {String} options.text - Plain text content
 * @param {String} options.html - HTML content
 * @returns {Promise} Send result
 */
exports.sendEmail = async (options) => {
  if (!sendgridEnabled) {
    console.log(`[SendGrid disabled] Email to ${options.to}: ${options.subject}`);
    return { disabled: true };
  }
  const msg = {
    to: options.to,
    from: fromEmail,
    subject: options.subject,
    text: options.text,
    html: options.html || options.text
  };

  try {
    return await sgMail.send(msg);
  } catch (error) {
    throw new AppError(`Failed to send email: ${error.message}`, 500);
  }
};

/**
 * Send appointment confirmation email
 * @param {Object} appointment - Appointment object
 * @param {Object} customer - Customer object
 * @param {Object} property - Property object
 * @returns {Promise} Send result
 */
exports.sendAppointmentConfirmation = async (appointment, customer, property) => {
  const date = formatDate(appointment.startTime);
  const startTime = formatTime(appointment.startTime);
  const endTime = formatTime(appointment.endTime);
  const address = property?.address
    ? [property.address.street, property.address.city, property.address.state].filter(Boolean).join(', ')
    : 'your property';

  const subject = `Appointment Confirmation - ${date} at ${startTime}`;

  const html = `
    <h2>Appointment Confirmation</h2>
    <p>Hello ${customer.name},</p>
    <p>This email confirms your appointment details:</p>
    <ul>
      <li><strong>Date:</strong> ${date}</li>
      <li><strong>Time:</strong> ${startTime} - ${endTime}</li>
      <li><strong>Property:</strong> ${address}</li>
      <li><strong>Service:</strong> ${appointment.serviceType}</li>
    </ul>
    <p>If you need to reschedule or have any questions, please call us.</p>
    <p>Thank you for your business!</p>
  `;

  return exports.sendEmail({
    to: customer.email,
    subject,
    html
  });
};

/**
 * Send work order invoice
 * @param {Object} workOrder - Work order object
 * @param {Object} customer - Customer object
 * @param {Object} property - Property object
 * @param {String} invoiceUrl - URL to the invoice PDF
 * @returns {Promise} Send result
 */
exports.sendInvoice = async (workOrder, customer, property, invoiceUrl) => {
  const address = property?.address
    ? [property.address.street, property.address.city].filter(Boolean).join(', ')
    : 'your property';

  const subject = `Invoice for ${address}`;

  const materialsCost = (workOrder.materials || []).reduce((total, material) => {
    return total + (material.price * material.quantity);
  }, 0);

  const laborCost = (workOrder.labor || []).reduce((total, labor) => {
    const qty = labor.quantity || labor.hours || 0;
    return total + (qty * labor.rate);
  }, 0);

  const serviceDesc = workOrder.serviceNotes ||
    (workOrder.services && workOrder.services[0]?.description) || 'Service performed';

  const html = `
    <h2>Invoice</h2>
    <p>Hello ${customer.name},</p>
    <p>Here is your invoice for the recent service at ${address}:</p>
    <h3>Service Details</h3>
    <p><strong>Service Performed:</strong> ${serviceDesc}</p>
    <h3>Summary</h3>
    <ul>
      <li><strong>Materials:</strong> $${materialsCost.toFixed(2)}</li>
      <li><strong>Labor:</strong> $${laborCost.toFixed(2)}</li>
      <li><strong>Total:</strong> $${workOrder.totalActual.toFixed(2)}</li>
    </ul>
    <p>For a detailed breakdown, please see the attached invoice or visit our customer portal.</p>
    <p>Thank you for your business!</p>
  `;

  return exports.sendEmail({
    to: customer.email,
    subject,
    html,
    attachments: [
      {
        content: invoiceUrl,
        filename: `Invoice_${workOrder._id}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment'
      }
    ]
  });
};

/**
 * Send media sharing email
 * @param {Object} media - Media object
 * @param {Object} customer - Customer object
 * @param {String} sharingLink - Temporary sharing link
 * @returns {Promise} Send result
 */
exports.shareMedia = async (media, customer, sharingLink) => {
  const subject = `Media Shared - Snyder's Gutters & Pressure Washing`;

  const html = `
    <h2>Media Shared</h2>
    <p>Hello ${customer.name},</p>
    <p>We've shared some media from your recent service.</p>
    <p><strong>Description:</strong> ${media.type} - ${media.notes || 'No additional notes'}</p>
    <p>You can view this media by clicking the link below:</p>
    <p><a href="${sharingLink.url}">View Media</a></p>
    <p><strong>Note:</strong> This link will expire in 24 hours.</p>
    <p>If you have any questions, please don't hesitate to contact us.</p>
  `;

  return exports.sendEmail({
    to: customer.email,
    subject,
    html
  });
};
