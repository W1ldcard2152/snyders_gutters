const Appointment = require('../models/Appointment');
const Customer = require('../models/Customer');
const Property = require('../models/Property');
const WorkOrder = require('../models/WorkOrder');
const moment = require('moment-timezone');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { applyPopulation } = require('../utils/populationHelpers');
const { validateEntityExists, validatePropertyOwnership } = require('../utils/validationHelpers');
const twilioService = require('../services/twilioService');
const emailService = require('../services/emailService');
const cacheService = require('../services/cacheService');
const { TIMEZONE } = require('../config/timezone');
const ScheduleBlock = require('../models/ScheduleBlock');

// Get all appointments
exports.getAllAppointments = catchAsync(async (req, res, next) => {
  // Allow filtering by date range, status, technician
  const { startDate, endDate, status, technician } = req.query;

  // Generate cache key from query parameters
  const cacheKey = `appointments:all:${JSON.stringify({ startDate, endDate, status, technician })}`;

  // Check cache first
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  // Build query based on filters
  const query = {};

  if (status) query.status = status;
  if (technician) query.technician = technician;

  // Date range filter
  if (startDate || endDate) {
    query.startTime = {};
    if (startDate) {
      query.startTime.$gte = moment.tz(startDate, TIMEZONE).startOf('day').utc().toDate();
    }
    if (endDate) {
      query.startTime.$lte = moment.tz(endDate, TIMEZONE).endOf('day').utc().toDate();
    }
  }

  const appointments = await applyPopulation(
    Appointment.find(query).sort({ startTime: 1 }),
    'appointment',
    'standard'
  );

  const responseData = {
    status: 'success',
    results: appointments.length,
    data: {
      appointments
    }
  };

  // Cache the response for 5 minutes
  cacheService.set(cacheKey, responseData, 300);

  res.status(200).json(responseData);
});

// Get a single appointment
exports.getAppointment = catchAsync(async (req, res, next) => {
  const appointment = await applyPopulation(
    Appointment.findById(req.params.id),
    'appointment',
    'detailed'
  );

  if (!appointment) {
    return next(new AppError('No appointment found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { appointment }
  });
});

// Create a new appointment
exports.createAppointment = catchAsync(async (req, res, next) => {
  const customer = await validateEntityExists(Customer, req.body.customer, 'Customer');

  let property = null;
  if (req.body.property && req.body.property !== '') {
    property = await validateEntityExists(Property, req.body.property, 'Property');
    validatePropertyOwnership(property, customer);
  }

  // Check for scheduling conflicts (startTime/endTime already converted to UTC by convertDates middleware)
  if (req.body.technician) {
    await Appointment.checkConflicts(
      req.body.startTime,
      req.body.endTime,
      req.body.technician
    );
    // TODO: Frontend should be updated to warn about conflicts.
    // For now, backend will allow scheduling despite conflicts.
  }

  const appointmentData = { ...req.body };

  // If property is null or empty string, ensure it's not passed to Mongoose as an empty string
  if (!req.body.property || req.body.property === '') {
    delete appointmentData.property;
  }

  // If workOrder is null or empty string, ensure it's not passed to Mongoose as an empty string
  if (!req.body.workOrder || req.body.workOrder === '') {
    delete appointmentData.workOrder;
  }

  // If linking to an existing workOrderId, ensure createWorkOrder is not also true.
  if (appointmentData.workOrder && appointmentData.createWorkOrder) {
    delete appointmentData.createWorkOrder;
  }

  const newAppointment = await Appointment.create(appointmentData);

  // Handle work order association
  if (newAppointment.workOrder) {
    const workOrderToUpdate = await WorkOrder.findById(newAppointment.workOrder);
    if (workOrderToUpdate) {
      let woNeedsSave = false;
      // Add to appointments array if not already present
      if (!workOrderToUpdate.appointments) {
        workOrderToUpdate.appointments = [];
      }
      if (!workOrderToUpdate.appointments.some(apptId => apptId.toString() === newAppointment._id.toString())) {
        workOrderToUpdate.appointments.push(newAppointment._id);
        woNeedsSave = true;
      }
      if (newAppointment.technician && workOrderToUpdate.assignedTechnician?.toString() !== newAppointment.technician.toString()) {
        workOrderToUpdate.assignedTechnician = newAppointment.technician;
        woNeedsSave = true;
      }
      // Set WO to 'Appointment Scheduled' unless it's already at a more advanced status
      if (workOrderToUpdate.status !== 'Appointment Scheduled' && workOrderToUpdate.status !== 'In Progress') {
        workOrderToUpdate.status = 'Appointment Scheduled';
        woNeedsSave = true;
      }
      if (woNeedsSave) {
        await workOrderToUpdate.save();
      }
    }
  } else if (appointmentData.createWorkOrder === true || appointmentData.createWorkOrder === 'true') {
    await newAppointment.createWorkOrder();
  }

  // Send confirmation based on customer preferences
  const populatedCustomerForNotif = await Customer.findById(newAppointment.customer);

  if (populatedCustomerForNotif && populatedCustomerForNotif.communicationPreference === 'SMS' && populatedCustomerForNotif.phone) {
    try {
      await twilioService.sendAppointmentReminder(
        newAppointment,
        populatedCustomerForNotif,
        property
      );
    } catch (err) {
      console.error('Failed to send SMS confirmation:', err);
    }
  } else if (populatedCustomerForNotif && populatedCustomerForNotif.communicationPreference === 'Email' && populatedCustomerForNotif.email) {
    try {
      await emailService.sendAppointmentConfirmation(
        newAppointment,
        populatedCustomerForNotif,
        property
      );
    } catch (err) {
      console.error('Failed to send email confirmation:', err);
    }
  }

  // Repopulate newAppointment fully before sending the response
  const fullyPopulatedAppointment = await applyPopulation(
    Appointment.findById(newAppointment._id),
    'appointment',
    'detailed'
  );

  // Invalidate appointment cache after creating new appointment
  cacheService.invalidateAllAppointments();

  // Also invalidate work order caches if a work order was linked
  if (newAppointment.workOrder) {
    cacheService.invalidateAllWorkOrders();
    cacheService.invalidateServiceWritersCorner();
  }

  res.status(201).json({
    status: 'success',
    data: {
      appointment: fullyPopulatedAppointment
    }
  });
});

// Update an appointment
exports.updateAppointment = catchAsync(async (req, res, next) => {
  const appointment = await Appointment.findById(req.params.id);

  if (!appointment) {
    return next(new AppError('No appointment found with that ID', 404));
  }

  // Check for scheduling conflicts if time or technician is changing
  if ((req.body.startTime || req.body.endTime || req.body.technician) &&
      appointment.status !== 'Cancelled' &&
      appointment.status !== 'Completed') {

    const startTime = req.body.startTime || appointment.startTime;
    const endTime = req.body.endTime || appointment.endTime;
    const technician = req.body.technician || appointment.technician;

    await Appointment.checkConflicts(
      startTime,
      endTime,
      technician,
      req.params.id
    );
    // TODO: Frontend should be updated to warn about conflicts.
  }

  // If status is changing to 'Completed', check/update related work order
  if (req.body.status === 'Completed' && appointment.status !== 'Completed') {
    if (appointment.workOrder) {
      await WorkOrder.findByIdAndUpdate(
        appointment.workOrder,
        { status: 'Complete' },
        { new: true, runValidators: true }
      );
    }
  }

  // If status is changing to 'Cancelled', check/update related work order
  if (req.body.status === 'Cancelled' && appointment.status !== 'Cancelled') {
    if (appointment.workOrder) {
      await WorkOrder.findByIdAndUpdate(
        appointment.workOrder,
        { status: 'Cancelled' },
        { new: true, runValidators: true }
      );
    }
  }

  // If appointment status is 'Scheduled' or 'Confirmed', ensure linked WorkOrder is 'Appointment Scheduled'
  if (
    (req.body.status === 'Scheduled' || req.body.status === 'Confirmed') &&
    appointment.workOrder
  ) {
    const workOrder = await WorkOrder.findById(appointment.workOrder);
    if (workOrder && workOrder.status !== 'Appointment Scheduled' && workOrder.status !== 'In Progress') {
      await WorkOrder.findByIdAndUpdate(
        appointment.workOrder,
        { status: 'Appointment Scheduled' },
        { new: true, runValidators: true }
      );
    }
  }

  // If a completed/no-show appointment is rescheduled to a future time, reset statuses
  const completedStatuses = ['Completed', 'No-Show'];
  if (completedStatuses.includes(appointment.status) && req.body.startTime) {
    const now = new Date();
    if (req.body.startTime > now) {
      req.body.status = 'Scheduled';
      if (appointment.workOrder) {
        const workOrder = await WorkOrder.findById(appointment.workOrder);
        if (workOrder && workOrder.status === 'Complete') {
          await WorkOrder.findByIdAndUpdate(
            appointment.workOrder,
            { status: 'Appointment Scheduled' },
            { new: true, runValidators: true }
          );
        }
      }
    }
  }

  const updatedAppointment = await applyPopulation(
    Appointment.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    }),
    'appointment',
    'withCommunication'
  );

  // If technician was changed and there's an associated work order, update it
  if (req.body.technician && updatedAppointment.workOrder) {
    const oldTechnicianId = appointment.technician ? appointment.technician.toString() : null;
    const newTechnicianId = req.body.technician;

    if (oldTechnicianId !== newTechnicianId) {
      await WorkOrder.findByIdAndUpdate(
        updatedAppointment.workOrder,
        { assignedTechnician: newTechnicianId },
        { new: true, runValidators: true }
      );
    }
  }

  // Send notification if status changed and customer has communication preference
  if (req.body.status &&
      req.body.status !== appointment.status &&
      updatedAppointment.customer &&
      updatedAppointment.customer.communicationPreference !== 'None') {

    if (updatedAppointment.customer.communicationPreference === 'SMS' &&
        updatedAppointment.customer.phone) {
      try {
        // Status-specific SMS notification logic here
      } catch (err) {
        console.error('Failed to send SMS notification:', err);
      }
    } else if (updatedAppointment.customer.communicationPreference === 'Email' &&
               updatedAppointment.customer.email) {
      try {
        // Status-specific email notification logic here
      } catch (err) {
        console.error('Failed to send email notification:', err);
      }
    }
  }

  // Invalidate appointment cache after updating appointment
  cacheService.invalidateAllAppointments();

  if (req.body.status || updatedAppointment.workOrder) {
    cacheService.invalidateAllWorkOrders();
    cacheService.invalidateServiceWritersCorner();
  }

  res.status(200).json({
    status: 'success',
    data: {
      appointment: updatedAppointment
    }
  });
});

// Delete an appointment
exports.deleteAppointment = catchAsync(async (req, res, next) => {
  const appointment = await Appointment.findById(req.params.id);

  if (!appointment) {
    return next(new AppError('No appointment found with that ID', 404));
  }

  // Update related work order if it exists
  if (appointment.workOrder) {
    const workOrder = await WorkOrder.findById(appointment.workOrder);
    if (workOrder) {
      // Remove from appointments array
      if (workOrder.appointments && workOrder.appointments.length > 0) {
        workOrder.appointments = workOrder.appointments.filter(
          apptId => apptId.toString() !== appointment._id.toString()
        );
      }
      await workOrder.save();
    }
  }

  await Appointment.findByIdAndDelete(req.params.id);

  cacheService.invalidateAllAppointments();

  if (appointment.workOrder) {
    cacheService.invalidateAllWorkOrders();
    cacheService.invalidateServiceWritersCorner();
  }

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Create work order from appointment
exports.createWorkOrderFromAppointment = catchAsync(async (req, res, next) => {
  const appointment = await Appointment.findById(req.params.id)
    .populate('customer')
    .populate('property');

  if (!appointment) {
    return next(new AppError('No appointment found with that ID', 404));
  }

  if (appointment.workOrder) {
    return next(
      new AppError('A work order already exists for this appointment', 400)
    );
  }

  const result = await appointment.createWorkOrder();

  const workOrder = await WorkOrder.findById(appointment.workOrder);

  res.status(201).json({
    status: 'success',
    data: {
      appointment,
      workOrder
    }
  });
});

// Get appointments by date range
exports.getAppointmentsByDateRange = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.params;

  if (!startDate || !endDate) {
    return next(
      new AppError('Please provide both start date and end date', 400)
    );
  }

  const start = moment.tz(startDate, TIMEZONE).startOf('day').utc().toDate();
  const end = moment.tz(endDate, TIMEZONE).endOf('day').utc().toDate();

  if (!moment(start).isValid() || !moment(end).isValid()) {
    return next(
      new AppError('Please provide valid dates in ISO format (YYYY-MM-DD)', 400)
    );
  }

  let appointments = cacheService.getAppointmentsByDateRange(startDate, endDate);

  if (!appointments) {
    appointments = await applyPopulation(
      Appointment.find({ startTime: { $gte: start, $lte: end } }).sort({ startTime: 1 }),
      'appointment',
      'standard'
    );

    cacheService.setAppointmentsByDateRange(startDate, endDate, appointments);
  }

  res.status(200).json({
    status: 'success',
    results: appointments.length,
    data: {
      appointments
    }
  });
});

// Send appointment reminder
exports.sendAppointmentReminder = catchAsync(async (req, res, next) => {
  const appointment = await Appointment.findById(req.params.id)
    .populate('customer', 'name phone email communicationPreference')
    .populate('property', 'address propertyType');

  if (!appointment) {
    return next(new AppError('No appointment found with that ID', 404));
  }

  if (appointment.customer.communicationPreference === 'SMS' &&
      appointment.customer.phone) {
    await twilioService.sendAppointmentReminder(
      appointment,
      appointment.customer,
      appointment.property
    );

    appointment.reminder.sent = true;
    appointment.reminder.sentAt = new Date();
    await appointment.save({ validateBeforeSave: false });

  } else if (appointment.customer.communicationPreference === 'Email' &&
             appointment.customer.email) {
    await emailService.sendAppointmentConfirmation(
      appointment,
      appointment.customer,
      appointment.property
    );

    appointment.reminder.sent = true;
    appointment.reminder.sentAt = new Date();
    await appointment.save({ validateBeforeSave: false });
  } else {
    return next(
      new AppError('Customer has no valid communication preference set', 400)
    );
  }

  res.status(200).json({
    status: 'success',
    message: 'Appointment reminder sent successfully',
    data: {
      appointment
    }
  });
});

// Check for scheduling conflicts
exports.checkConflicts = catchAsync(async (req, res, next) => {
  const { startTime, endTime, technician } = req.body;

  if (!startTime || !endTime) {
    return next(
      new AppError('Please provide both start time and end time', 400)
    );
  }

  const start = startTime;
  const end = endTime;

  if (!moment(start).isValid() || !moment(end).isValid()) {
    return next(
      new AppError('Please provide valid dates in ISO format', 400)
    );
  }

  const { appointmentId } = req.body;

  const conflicts = await Appointment.checkConflicts(
    start,
    end,
    technician,
    appointmentId
  );

  let scheduleBlockConflicts = [];
  try {
    const expandedBlocks = await ScheduleBlock.expandForDateRange(start, end, technician || null);
    scheduleBlockConflicts = expandedBlocks.filter(block => {
      const blockStart = new Date(block.startTime);
      const blockEnd = new Date(block.endTime);
      return (
        (blockStart <= start && blockEnd > start) ||
        (blockStart < end && blockEnd >= end) ||
        (blockStart >= start && blockEnd <= end)
      );
    });
  } catch (err) {
    console.error('Error checking schedule block conflicts:', err);
  }

  const totalConflicts = conflicts.length + scheduleBlockConflicts.length;

  res.status(200).json({
    status: 'success',
    results: totalConflicts,
    data: {
      hasConflicts: totalConflicts > 0,
      conflicts,
      scheduleBlockConflicts
    }
  });
});

// Get today's appointments
exports.getTodayAppointments = catchAsync(async (req, res, next) => {
  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  const cacheKey = `appointments:today:${today}`;

  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const todayStart = moment.tz(TIMEZONE).startOf('day').utc().toDate();
  const tomorrowStart = moment.tz(TIMEZONE).add(1, 'day').startOf('day').utc().toDate();

  const appointments = await applyPopulation(
    Appointment.find({ startTime: { $gte: todayStart, $lt: tomorrowStart } }).sort({ startTime: 1 }),
    'appointment',
    'standard'
  );

  const responseData = {
    status: 'success',
    results: appointments.length,
    data: {
      appointments
    }
  };

  cacheService.set(cacheKey, responseData, 120);

  res.status(200).json(responseData);
});

// Get appointments by customer
exports.getCustomerAppointments = catchAsync(async (req, res, next) => {
  const { customerId } = req.params;

  const customer = await validateEntityExists(Customer, customerId, 'Customer');

  const appointments = await applyPopulation(
    Appointment.find({ customer: customerId }).sort({ startTime: -1 }),
    'appointment',
    'standard'
  );

  res.status(200).json({
    status: 'success',
    results: appointments.length,
    data: {
      customer,
      appointments
    }
  });
});

// Get appointments by property
exports.getPropertyAppointments = catchAsync(async (req, res, next) => {
  const { propertyId } = req.params;

  const property = await applyPopulation(
    Property.findById(propertyId),
    'property',
    'standard'
  );

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  const appointments = await applyPopulation(
    Appointment.find({ property: propertyId }).sort({ startTime: -1 }),
    'appointment',
    'standard'
  );

  res.status(200).json({
    status: 'success',
    results: appointments.length,
    data: {
      property,
      appointments
    }
  });
});
