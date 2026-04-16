const twilio = require('twilio');
const AppError = require('../utils/appError');
const { formatDate, formatTime } = require('../config/timezone');

// Initialize Twilio client only when credentials are present
const twilioEnabled = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_ACCOUNT_SID.startsWith('AC') &&
  process.env.TWILIO_AUTH_TOKEN
);

const client = twilioEnabled
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const fromNumber = process.env.TWILIO_PHONE_NUMBER;

/**
 * Send an SMS message
 * @param {String} to - Recipient phone number
 * @param {String} body - Message content
 * @returns {Promise<Object>} Message details
 */
exports.sendSMS = async (to, body) => {
  if (!twilioEnabled) {
    console.log(`[Twilio disabled] SMS to ${to}: ${body}`);
    return { sid: null, status: 'disabled' };
  }
  try {
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to
    });

    return {
      sid: message.sid,
      status: message.status,
      dateCreated: message.dateCreated
    };
  } catch (error) {
    throw new AppError(`Failed to send SMS: ${error.message}`, 500);
  }
};

/**
 * Send an MMS message with media
 * @param {String} to - Recipient phone number
 * @param {String} body - Message content
 * @param {String} mediaUrl - URL to the media file
 * @returns {Promise<Object>} Message details
 */
exports.sendMMS = async (to, body, mediaUrl) => {
  if (!twilioEnabled) {
    console.log(`[Twilio disabled] MMS to ${to}: ${body}`);
    return { sid: null, status: 'disabled' };
  }
  try {
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to,
      mediaUrl: [mediaUrl]
    });

    return {
      sid: message.sid,
      status: message.status,
      dateCreated: message.dateCreated
    };
  } catch (error) {
    throw new AppError(`Failed to send MMS: ${error.message}`, 500);
  }
};

/**
 * Send appointment reminder
 * @param {Object} appointment - Appointment object
 * @param {Object} customer - Customer object
 * @param {Object} property - Property object
 * @returns {Promise<Object>} Message details
 */
exports.sendAppointmentReminder = async (appointment, customer, property) => {
  const date = formatDate(appointment.startTime);
  const time = formatTime(appointment.startTime);
  const address = property?.address?.street || 'your property';

  const body = `Hi ${customer.name}, this is a reminder about your ${appointment.serviceType} appointment at ${address} on ${date} at ${time}. Reply Y to confirm or call us to reschedule.`;

  return exports.sendSMS(customer.phone, body);
};

/**
 * Send work order status update
 * @param {Object} workOrder - Work order object
 * @param {Object} customer - Customer object
 * @param {Object} property - Property object
 * @returns {Promise<Object>} Message details
 */
exports.sendStatusUpdate = async (workOrder, customer, property) => {
  const address = property?.address?.street || 'your property';
  const body = `Hi ${customer.name}, the status of your work order at ${address} has been updated to: ${workOrder.status}. Call us for more details.`;

  return exports.sendSMS(customer.phone, body);
};

/**
 * Send completion notification with invoice
 * @param {Object} workOrder - Work order object
 * @param {Object} customer - Customer object
 * @param {Object} property - Property object
 * @param {String} invoiceUrl - URL to the invoice PDF
 * @returns {Promise<Object>} Message details
 */
exports.sendCompletionNotification = async (workOrder, customer, property, invoiceUrl) => {
  const address = property?.address?.street || 'your property';
  const body = `Hi ${customer.name}, the work at ${address} is complete! Total: $${workOrder.totalActual.toFixed(2)}. See attached invoice for details.`;

  return exports.sendMMS(customer.phone, body, invoiceUrl);
};
