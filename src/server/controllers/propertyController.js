const Property = require('../models/Property');
const Customer = require('../models/Customer');
const WorkOrder = require('../models/WorkOrder');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cacheService = require('../services/cacheService');

// Get all properties
exports.getAllProperties = catchAsync(async (req, res, next) => {
  const { customer, city, propertyType } = req.query;

  const cacheKey = `properties:all:${JSON.stringify({ customer, city, propertyType })}`;

  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const query = {};

  if (customer) query.customer = customer;
  if (city) query['address.city'] = { $regex: city, $options: 'i' };
  if (propertyType) query.propertyType = propertyType;

  const properties = await Property.find(query)
    .populate('customer', 'name phone email')
    .sort({ updatedAt: -1 });

  const propertyIds = properties.map(p => p._id);
  const workOrderCounts = await WorkOrder.aggregate([
    { $match: { property: { $in: propertyIds } } },
    { $group: { _id: '$property', count: { $sum: 1 } } }
  ]);
  const countMap = {};
  workOrderCounts.forEach(({ _id, count }) => { countMap[_id.toString()] = count; });

  const propertiesWithCounts = properties.map(p => {
    const obj = p.toObject();
    obj.workOrderCount = countMap[p._id.toString()] || 0;
    return obj;
  });

  const responseData = {
    status: 'success',
    results: properties.length,
    data: {
      properties: propertiesWithCounts
    }
  };

  cacheService.set(cacheKey, responseData, 600);

  res.status(200).json(responseData);
});

// Get a single property
exports.getProperty = catchAsync(async (req, res, next) => {
  const cached = cacheService.getPropertyById(req.params.id);
  if (cached) {
    return res.status(200).json(cached);
  }

  const property = await Property.findById(req.params.id)
    .populate('customer', 'name phone email')
    .populate({
      path: 'serviceHistory',
      options: { sort: { date: -1 } },
      select: 'date status services totalEstimate totalActual'
    });

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  const responseData = {
    status: 'success',
    data: {
      property
    }
  };

  cacheService.setPropertyById(req.params.id, responseData);

  res.status(200).json(responseData);
});

// Create a new property
exports.createProperty = catchAsync(async (req, res, next) => {
  const customer = await Customer.findById(req.body.customer);

  if (!customer) {
    return next(new AppError('No customer found with that ID', 404));
  }

  const newProperty = await Property.create(req.body);

  // Add the property to the customer's properties array
  customer.properties.push(newProperty._id);
  await customer.save({ validateBeforeSave: false });

  cacheService.invalidateAllProperties();
  cacheService.invalidateAllCustomers();

  res.status(201).json({
    status: 'success',
    data: {
      property: newProperty
    }
  });
});

// Update a property
exports.updateProperty = catchAsync(async (req, res, next) => {
  const property = await Property.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  }).populate('customer', 'name');

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  cacheService.invalidateAllProperties();
  cacheService.invalidateAllCustomers();

  res.status(200).json({
    status: 'success',
    data: {
      property
    }
  });
});

// Delete a property
exports.deleteProperty = catchAsync(async (req, res, next) => {
  const property = await Property.findById(req.params.id);

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  const workOrderCount = await WorkOrder.countDocuments({ property: req.params.id });

  if (workOrderCount > 0) {
    return next(
      new AppError(
        `Cannot delete this property because it has ${workOrderCount} associated work order${workOrderCount === 1 ? '' : 's'}. You must delete or reassign all associated work orders before deleting this property.`,
        400
      )
    );
  }

  // Remove the property from the customer's properties array
  await Customer.findByIdAndUpdate(
    property.customer,
    { $pull: { properties: req.params.id } }
  );

  await Property.findByIdAndDelete(req.params.id);

  cacheService.invalidateAllProperties();
  cacheService.invalidateAllCustomers();

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Search properties
exports.searchProperties = catchAsync(async (req, res, next) => {
  const { query } = req.query;

  if (!query) {
    return next(new AppError('Please provide a search query', 400));
  }

  const properties = await Property.find({
    $or: [
      { 'address.street': { $regex: query, $options: 'i' } },
      { 'address.city': { $regex: query, $options: 'i' } },
      { 'address.state': { $regex: query, $options: 'i' } },
      { 'address.zip': { $regex: query, $options: 'i' } },
      { notes: { $regex: query, $options: 'i' } }
    ]
  }).populate('customer', 'name phone email');

  res.status(200).json({
    status: 'success',
    results: properties.length,
    data: {
      properties
    }
  });
});

// Get property service history
exports.getPropertyServiceHistory = catchAsync(async (req, res, next) => {
  const Appointment = require('../models/Appointment');

  const property = await Property.findById(req.params.id);

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  const workOrders = await WorkOrder.find({ property: req.params.id })
    .sort({ date: -1 });

  const workOrdersWithAppointmentDates = await Promise.all(
    workOrders.map(async (workOrder) => {
      const appointments = await Appointment.find({ workOrder: workOrder._id })
        .sort({ startTime: -1 })
        .limit(1);

      const workOrderObj = workOrder.toObject();

      if (appointments.length > 0) {
        workOrderObj.mostRecentAppointmentDate = appointments[0].startTime;
      }

      return workOrderObj;
    })
  );

  workOrdersWithAppointmentDates.sort((a, b) => {
    const dateA = a.mostRecentAppointmentDate || a.date;
    const dateB = b.mostRecentAppointmentDate || b.date;
    return new Date(dateB) - new Date(dateA);
  });

  res.status(200).json({
    status: 'success',
    results: workOrdersWithAppointmentDates.length,
    data: {
      property,
      serviceHistory: workOrdersWithAppointmentDates
    }
  });
});
