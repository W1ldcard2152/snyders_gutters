const mongoose = require('mongoose');
const WorkOrder = require('../models/WorkOrder');
const Property = require('../models/Property');
const Customer = require('../models/Customer');
const Appointment = require('../models/Appointment');
const WorkOrderNote = require('../models/WorkOrderNote');
const InventoryItem = require('../models/InventoryItem');
const ServicePackage = require('../models/ServicePackage');
const Settings = require('../models/Settings');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { parseLocalDate, buildDateRangeQuery, todayInTz, startOfTodayInTz, getDayBoundaries } = require('../utils/dateUtils');
const { applyPopulation } = require('../utils/populationHelpers');
const { validateEntityExists } = require('../utils/validationHelpers');
const { calculateWorkOrderTotal, getWorkOrderCostBreakdown } = require('../utils/calculationHelpers');
const twilioService = require('../services/twilioService');
const emailService = require('../services/emailService');
const cacheService = require('../services/cacheService');
const { formatDate, TIMEZONE } = require('../config/timezone');

// Get all work orders
exports.getAllWorkOrders = catchAsync(async (req, res, next) => {
  const { status, customer, property, startDate, endDate, excludeStatuses } = req.query;

  // Generate cache key from query parameters
  const cacheKey = `workorders:all:${JSON.stringify({ status, customer, property, startDate, endDate, excludeStatuses })}`;

  // Check cache first
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  // Build query based on filters
  const query = {};

  if (status && excludeStatuses) {
    const statusesToExclude = excludeStatuses.split(',').map(s => s.trim());
    const allowedStatuses = [status].filter(s => !statusesToExclude.includes(s));
    query.status = { $in: allowedStatuses };
  } else if (status) {
    query.status = status;
  } else if (excludeStatuses) {
    const statusesToExclude = excludeStatuses.split(',').map(s => s.trim());
    query.status = { $nin: statusesToExclude };
  }

  // Always exclude "Quote" status from general work order queries
  // unless the caller explicitly requested status=Quote
  if (!status || status !== 'Quote') {
    if (query.status && query.status.$nin) {
      if (!query.status.$nin.includes('Quote')) {
        query.status.$nin.push('Quote');
      }
    } else if (query.status && query.status.$in) {
      query.status.$in = query.status.$in.filter(s => s !== 'Quote');
    } else if (!query.status) {
      query.status = { $nin: ['Quote'] };
    }
  }

  if (customer) query.customer = customer;
  if (property) query.property = property;
  Object.assign(query, buildDateRangeQuery(startDate, endDate, 'date'));

  const workOrders = await applyPopulation(
    WorkOrder.find(query).sort({ date: -1 }),
    'workOrder',
    'standard'
  );

  const responseData = {
    status: 'success',
    results: workOrders.length,
    data: { workOrders }
  };

  // Cache the response for 5 minutes
  cacheService.set(cacheKey, responseData, 300);

  res.status(200).json(responseData);
});

// Get a single work order
exports.getWorkOrder = catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('Invalid work order ID format', 400));
  }

  // Check cache first
  const cached = cacheService.getWorkOrderById(req.params.id);
  if (cached) {
    return res.status(200).json(cached);
  }

  const workOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  if (!workOrder) {
    return next(new AppError('No work order found with that ID', 404));
  }

  const responseData = {
    status: 'success',
    data: { workOrder }
  };

  // Cache the response for 5 minutes
  cacheService.setWorkOrderById(req.params.id, responseData);

  res.status(200).json(responseData);
});

// Create a new work order
exports.createWorkOrder = catchAsync(async (req, res, next) => {
  // Prevent creating a quote through the work order endpoint
  if (req.body.status === 'Quote') {
    return next(new AppError('Use POST /api/workorders/quotes to create quotes', 400));
  }

  // Validate customer exists
  const customer = await validateEntityExists(Customer, req.body.customer, 'Customer');

  // Validate property exists and belongs to customer if provided
  if (req.body.property) {
    const property = await Property.findById(req.body.property);
    if (!property) {
      return next(new AppError('Property not found', 404));
    }
    if (property.customer && property.customer.toString() !== customer._id.toString()) {
      return next(new AppError('Property does not belong to this customer', 400));
    }
  }

  let workOrderData = { ...req.body };
  workOrderData.createdBy = req.user._id;

  // Handle services array if provided
  if (!workOrderData.services || workOrderData.services.length === 0) {
    workOrderData.services = [];
  } else if (typeof workOrderData.services === 'string') {
    try {
      workOrderData.services = JSON.parse(workOrderData.services);
    } catch (e) {
      workOrderData.services = [{ description: workOrderData.services }];
    }
  }

  // Always set status to 'Work Order Created'
  workOrderData.status = 'Work Order Created';

  // Calculate total estimate if materials and labor are provided
  if (!workOrderData.totalEstimate) {
    workOrderData.totalEstimate = calculateWorkOrderTotal(
      workOrderData.materials,
      workOrderData.labor,
      workOrderData.servicePackages
    );
  }

  const newWorkOrder = await WorkOrder.create(workOrderData);

  // Add the work order to the property's service history
  if (workOrderData.property) {
    const property = await Property.findById(workOrderData.property);
    if (property) {
      property.serviceHistory.push(newWorkOrder._id);
      await property.save({ validateBeforeSave: false });
    }
  }

  // Invalidate caches since new work order was created
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  res.status(201).json({
    status: 'success',
    data: {
      workOrder: newWorkOrder
    }
  });
});

// Update a work order
exports.updateWorkOrder = catchAsync(async (req, res, next) => {
  let workOrderData = { ...req.body };

  // Process services array
  if (workOrderData.services) {
    if (typeof workOrderData.services === 'string') {
      try {
        workOrderData.services = JSON.parse(workOrderData.services);
      } catch (e) {
        workOrderData.services = [{ description: workOrderData.services }];
      }
    }
  }

  // Recalculate total estimate/actual if materials or labor changed
  if (workOrderData.materials || workOrderData.labor) {
    const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');

    const materials = workOrderData.materials || workOrder.materials;
    const labor = workOrderData.labor || workOrder.labor;
    const servicePackages = workOrderData.servicePackages || workOrder.servicePackages;
    workOrderData.totalEstimate = calculateWorkOrderTotal(materials, labor, servicePackages);
  }

  // If status is being updated, check for notification
  if (workOrderData.status) {
    const oldWorkOrder = await WorkOrder.findById(req.params.id)
      .populate('customer')
      .populate('property');

    if (oldWorkOrder && oldWorkOrder.status !== workOrderData.status) {
      const notifiableStatuses = ['In Progress', 'Complete', 'Invoiced'];

      if (notifiableStatuses.includes(workOrderData.status) &&
          oldWorkOrder.customer &&
          oldWorkOrder.property) {

        // Send SMS notification if customer prefers SMS
        if (oldWorkOrder.customer.communicationPreference === 'SMS' &&
            oldWorkOrder.customer.phone) {
          try {
            await twilioService.sendStatusUpdate(
              { status: workOrderData.status },
              oldWorkOrder.customer,
              oldWorkOrder.property
            );
          } catch (err) {
            console.error('Failed to send SMS notification:', err);
          }
        }

        // Send email notification if customer prefers Email
        if (oldWorkOrder.customer.communicationPreference === 'Email' &&
            oldWorkOrder.customer.email) {
          try {
            // await emailService.sendStatusUpdate(...);
          } catch (err) {
            console.error('Failed to send email notification:', err);
          }
        }
      }
    }
  }

  const oldWorkOrder = await WorkOrder.findById(req.params.id);

  const updatedWorkOrderPopulated = await applyPopulation(
    WorkOrder.findByIdAndUpdate(req.params.id, workOrderData, {
      new: true,
      runValidators: true
    }),
    'workOrder',
    'detailed'
  );

  if (!updatedWorkOrderPopulated) {
    return next(new AppError('No work order found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      workOrder: updatedWorkOrderPopulated
    }
  });

  // Invalidate caches since work order was updated
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  // Invalidate appointment cache if work order status changed
  if (workOrderData.status && oldWorkOrder && oldWorkOrder.status !== workOrderData.status) {
    cacheService.invalidateAllAppointments();
  }
});

// Delete a work order
exports.deleteWorkOrder = catchAsync(async (req, res, next) => {
  const workOrder = await WorkOrder.findById(req.params.id);

  if (!workOrder) {
    return next(new AppError('No work order found with that ID', 404));
  }

  // Delete any appointments associated with this work order
  try {
    const deletedAppointments = await Appointment.deleteMany({ workOrder: req.params.id });
    if (deletedAppointments.deletedCount > 0) {
      console.log(`Deleted ${deletedAppointments.deletedCount} appointment(s) associated with work order ${req.params.id}`);
    }
  } catch (appointmentError) {
    console.error('Error deleting associated appointments:', appointmentError);
  }

  // Remove from property's service history
  await Property.findByIdAndUpdate(
    workOrder.property,
    { $pull: { serviceHistory: req.params.id } }
  );

  await WorkOrder.findByIdAndDelete(req.params.id);

  // Invalidate caches since work order was deleted
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();
  cacheService.invalidateAllAppointments();

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Update work order status
exports.updateStatus = catchAsync(async (req, res, next) => {
  const { status, holdReason, holdReasonOther } = req.body;

  if (!status) {
    return next(new AppError('Please provide a status', 400));
  }

  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');

  // Handle On Hold reason codes
  if (status === 'On Hold') {
    if (!holdReason) {
      return next(new AppError('A hold reason is required when placing a work order on hold', 400));
    }
    if (holdReason === 'other' && !holdReasonOther) {
      return next(new AppError('Please provide a reason when selecting "Other"', 400));
    }
    workOrder.holdReason = holdReason;
    workOrder.holdReasonOther = holdReason === 'other' ? holdReasonOther : undefined;
  } else {
    // Clear hold reason when leaving On Hold status
    if (workOrder.status === 'On Hold') {
      workOrder.holdReason = undefined;
      workOrder.holdReasonOther = undefined;
    }
  }

  workOrder.status = status;

  // If the status is "Invoiced", set the totalActual
  if (status === 'Invoiced') {
    workOrder.totalActual = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  }

  await workOrder.save({ validateBeforeSave: false });

  // Get populated work order
  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  // Send notification if customer has communication preference set
  const notifiableStatuses = ['In Progress', 'Complete', 'Invoiced'];
  if (populatedWorkOrder.customer &&
      populatedWorkOrder.customer.communicationPreference !== 'None' &&
      notifiableStatuses.includes(status)) {

    // For SMS notification
    if (populatedWorkOrder.customer.communicationPreference === 'SMS' &&
        populatedWorkOrder.customer.phone) {
      try {
        await twilioService.sendStatusUpdate(
          populatedWorkOrder,
          populatedWorkOrder.customer,
          populatedWorkOrder.property
        );
      } catch (err) {
        console.error('Failed to send SMS notification:', err);
      }
    }

    // For Email notification
    // This would require implementing a specific email template for status updates
  }

  // Invalidate caches since work order status was updated
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();
  cacheService.invalidateAllAppointments();

  res.status(200).json({
    status: 'success',
    data: {
      workOrder: populatedWorkOrder
    }
  });
});

// Add material to work order
exports.addMaterial = catchAsync(async (req, res, next) => {
  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');

  workOrder.materials.push(req.body);
  workOrder.totalEstimate = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  await workOrder.save();

  const populatedWorkOrderAfterAdd = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  // Invalidate caches since materials were added to work order
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  res.status(200).json({
    status: 'success',
    data: { workOrder: populatedWorkOrderAfterAdd }
  });
});

// Add material from inventory to work order (deducts inventory QOH)
exports.addMaterialFromInventory = catchAsync(async (req, res, next) => {
  const { inventoryItemId, quantity } = req.body;
  if (!inventoryItemId || !quantity || quantity < 1) {
    return next(new AppError('inventoryItemId and quantity (>= 1) are required', 400));
  }

  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');
  const item = await InventoryItem.findById(inventoryItemId);
  if (!item || !item.isActive) {
    return next(new AppError('Inventory item not found or inactive', 404));
  }

  if (item.quantityOnHand < quantity) {
    return next(new AppError(`Insufficient stock: ${item.quantityOnHand} ${item.unit} available, ${quantity} requested`, 400));
  }

  const settings = await Settings.getSettings();
  const markup = settings.supplyMarkupPercentage || 20;
  const price = parseFloat((item.cost * (1 + markup / 100)).toFixed(2));

  // Deduct inventory atomically
  const previousQty = item.quantityOnHand;
  const newQty = previousQty - quantity;
  const updated = await InventoryItem.findOneAndUpdate(
    { _id: inventoryItemId, quantityOnHand: { $gte: quantity } },
    {
      $set: { quantityOnHand: newQty },
      $push: {
        adjustmentLog: {
          adjustedBy: req.user._id,
          previousQty,
          newQty,
          reason: `Used on WO #${workOrder._id}`
        }
      }
    },
    { new: true }
  );
  if (!updated) {
    return next(new AppError('Insufficient stock (concurrent update)', 409));
  }

  // Add material line to work order
  workOrder.materials.push({
    name: item.name,
    partNumber: item.partNumber || '',
    quantity,
    price,
    cost: item.cost,
    vendor: item.vendor || '',
    warranty: item.warranty || '',
    url: item.url || '',
    category: item.category || '',
    inventoryItemId: item._id
  });
  workOrder.totalEstimate = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  await workOrder.save();

  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  const response = {
    status: 'success',
    data: { workOrder: populatedWorkOrder }
  };

  if (newQty <= updated.reorderPoint) {
    response.lowStockWarning = {
      itemName: updated.name,
      currentQoh: newQty,
      unit: updated.unit,
      reorderPoint: updated.reorderPoint
    };
  }

  res.status(200).json(response);
});

// Add service package as draft (no inventory deduction yet)
exports.addServicePackage = catchAsync(async (req, res, next) => {
  const { servicePackageId, selections } = req.body;
  if (!servicePackageId) {
    return next(new AppError('servicePackageId is required', 400));
  }

  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');
  const pkg = await ServicePackage.findById(servicePackageId);
  if (!pkg || !pkg.isActive) {
    return next(new AppError('Service package not found or inactive', 404));
  }

  // selections = [{ includedItemId, inventoryItemId }]
  const selectionMap = {};
  if (selections && Array.isArray(selections)) {
    for (const sel of selections) {
      selectionMap[sel.includedItemId] = sel.inventoryItemId;
    }
  }

  // Validate selected items exist and match tags (but don't check QOH yet)
  const packageIncludedItems = [];
  for (const included of pkg.includedItems) {
    const inventoryItemId = selectionMap[included._id.toString()];
    if (inventoryItemId) {
      const inv = await InventoryItem.findById(inventoryItemId);
      if (!inv || !inv.isActive) {
        return next(new AppError(`Inventory item for "${included.label}" is not found or inactive`, 400));
      }
      if (inv.packageTag !== included.packageTag) {
        return next(new AppError(`Selected item "${inv.name}" does not match required tag "${included.packageTag}"`, 400));
      }
      packageIncludedItems.push({
        inventoryItemId: inv._id,
        name: inv.name,
        partNumber: inv.partNumber || '',
        quantity: included.quantity,
        cost: inv.cost,
        unit: inv.unit || ''
      });
    } else {
      packageIncludedItems.push({
        name: `${included.label} (${included.packageTag})`,
        quantity: included.quantity,
        cost: 0
      });
    }
  }

  // Add as uncommitted draft — no inventory deducted
  workOrder.servicePackages.push({
    servicePackageId: pkg._id,
    name: pkg.name,
    price: pkg.price,
    committed: false,
    includedItems: packageIncludedItems
  });

  workOrder.totalEstimate = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  await workOrder.save();

  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  res.status(200).json({
    status: 'success',
    data: { workOrder: populatedWorkOrder }
  });
});

// Commit a service package — deduct inventory
exports.commitServicePackage = catchAsync(async (req, res, next) => {
  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');
  const { packageIndex } = req.body;

  if (packageIndex === undefined || packageIndex < 0 || packageIndex >= (workOrder.servicePackages || []).length) {
    return next(new AppError('Invalid package index', 400));
  }

  const pkg = workOrder.servicePackages[packageIndex];
  if (pkg.committed) {
    return next(new AppError('This service package is already committed', 400));
  }

  // Pre-validate all inventory items have sufficient QOH
  for (const item of pkg.includedItems) {
    if (item.inventoryItemId) {
      const inv = await InventoryItem.findById(item.inventoryItemId);
      if (!inv || !inv.isActive) {
        return next(new AppError(`Inventory item "${item.name}" is not found or inactive`, 400));
      }
      if (inv.quantityOnHand < item.quantity) {
        return next(new AppError(`Insufficient stock for "${item.name}": ${inv.quantityOnHand} ${inv.unit} available, ${item.quantity} needed`, 400));
      }
    }
  }

  // Deduct inventory
  const lowStockWarnings = [];
  for (const item of pkg.includedItems) {
    if (item.inventoryItemId) {
      const inv = await InventoryItem.findById(item.inventoryItemId);
      const previousQty = inv.quantityOnHand;
      const newQty = previousQty - item.quantity;

      const updated = await InventoryItem.findOneAndUpdate(
        { _id: inv._id, quantityOnHand: { $gte: item.quantity } },
        {
          $set: { quantityOnHand: newQty },
          $push: {
            adjustmentLog: {
              adjustedBy: req.user._id,
              previousQty,
              newQty,
              reason: `Service "${pkg.name}" on WO #${workOrder._id}`
            }
          }
        },
        { new: true }
      );

      if (!updated) {
        return next(new AppError(`Failed to deduct inventory for "${item.name}" (concurrent update)`, 409));
      }

      if (newQty <= updated.reorderPoint) {
        lowStockWarnings.push({
          itemName: updated.name,
          currentQoh: newQty,
          unit: updated.unit,
          reorderPoint: updated.reorderPoint
        });
      }
    }
  }

  workOrder.servicePackages[packageIndex].committed = true;
  workOrder.markModified('servicePackages');
  await workOrder.save();

  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  const response = {
    status: 'success',
    data: { workOrder: populatedWorkOrder }
  };

  if (lowStockWarnings.length > 0) {
    response.lowStockWarnings = lowStockWarnings;
  }

  res.status(200).json(response);
});

// Remove a service package from work order (does NOT return inventory by default)
exports.removeServicePackage = catchAsync(async (req, res, next) => {
  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');
  const { packageIndex, returnToInventory } = req.body;

  if (packageIndex === undefined || packageIndex < 0 || packageIndex >= (workOrder.servicePackages || []).length) {
    return next(new AppError('Invalid package index', 400));
  }

  const removedPkg = workOrder.servicePackages[packageIndex];

  // Return items to inventory if requested
  if (returnToInventory && removedPkg.includedItems) {
    for (const item of removedPkg.includedItems) {
      if (item.inventoryItemId) {
        const inv = await InventoryItem.findById(item.inventoryItemId);
        if (inv) {
          const previousQty = inv.quantityOnHand;
          const newQty = previousQty + item.quantity;
          await InventoryItem.findByIdAndUpdate(item.inventoryItemId, {
            $set: { quantityOnHand: newQty },
            $push: {
              adjustmentLog: {
                adjustedBy: req.user._id,
                previousQty,
                newQty,
                reason: `Returned from removed service "${removedPkg.name}" on WO #${workOrder._id}`
              }
            }
          });
        }
      }
    }
  }

  workOrder.servicePackages.splice(packageIndex, 1);
  workOrder.totalEstimate = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  await workOrder.save();

  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  res.status(200).json({
    status: 'success',
    data: { workOrder: populatedWorkOrder }
  });
});

// Add labor to work order
exports.addLabor = catchAsync(async (req, res, next) => {
  const workOrder = await validateEntityExists(WorkOrder, req.params.id, 'Work order');

  workOrder.labor.push(req.body);
  workOrder.totalEstimate = calculateWorkOrderTotal(workOrder.materials, workOrder.labor, workOrder.servicePackages);
  await workOrder.save();

  const populatedWorkOrderAfterAddLabor = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  // Invalidate caches since labor was added to work order
  cacheService.invalidateAllWorkOrders();
  cacheService.invalidateServiceWritersCorner();

  res.status(200).json({
    status: 'success',
    data: { workOrder: populatedWorkOrderAfterAddLabor }
  });
});

// Get work orders by status
exports.getWorkOrdersByStatus = catchAsync(async (req, res, next) => {
  const { status } = req.params;

  // Check cache first
  const cached = cacheService.getWorkOrdersByStatus(status);
  if (cached) {
    return res.status(200).json({
      status: 'success',
      results: cached.length,
      data: { workOrders: cached }
    });
  }

  const workOrders = await applyPopulation(
    WorkOrder.find({ status }).sort({ date: -1 }),
    'workOrder',
    'standard'
  );

  // Cache the work orders for 5 minutes
  cacheService.setWorkOrdersByStatus(status, workOrders);

  res.status(200).json({
    status: 'success',
    results: workOrders.length,
    data: { workOrders }
  });
});

// Generate invoice
exports.generateInvoice = catchAsync(async (req, res, next) => {
  const workOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'invoice'
  );

  if (!workOrder) {
    return next(new AppError('No work order found with that ID', 404));
  }

  const { materialsCost, laborCost, total: totalCost } = getWorkOrderCostBreakdown(workOrder);

  res.status(200).json({
    status: 'success',
    data: {
      invoice: {
        workOrderId: workOrder._id,
        customer: workOrder.customer,
        property: workOrder.property,
        assignedTechnician: workOrder.assignedTechnician,
        date: workOrder.date,
        materials: workOrder.materials,
        labor: workOrder.labor,
        materialsCost,
        laborCost,
        totalCost,
        status: workOrder.status
      }
    }
  });
});

// Search work orders
exports.searchWorkOrders = catchAsync(async (req, res, next) => {
  const { query } = req.query;

  if (!query) {
    return next(new AppError('Please provide a search query', 400));
  }

  const workOrders = await applyPopulation(
    WorkOrder.find({
      status: { $ne: 'Quote' },
      $or: [
        { serviceNotes: { $regex: query, $options: 'i' } },
        { 'services.description': { $regex: query, $options: 'i' } },
        { status: { $regex: query, $options: 'i' } },
        { 'materials.name': { $regex: query, $options: 'i' } },
        { 'materials.partNumber': { $regex: query, $options: 'i' } }
      ]
    }),
    'workOrder',
    'standard'
  );

  res.status(200).json({
    status: 'success',
    results: workOrders.length,
    data: { workOrders }
  });
});

// Get work orders awaiting scheduling ('Work Order Created' status with no future appointments)
exports.getWorkOrdersAwaitingScheduling = catchAsync(async (req, res, next) => {
  // Get all work orders with 'Work Order Created' status
  const workOrderCreatedWorkOrders = await applyPopulation(
    WorkOrder.find({ status: 'Work Order Created' }),
    'workOrder',
    'standard'
  );

  // Get all future appointments (starting from now)
  const now = new Date();
  const futureAppointments = await Appointment.find({
    startTime: { $gte: now },
    workOrder: { $exists: true },
    status: { $nin: ['Cancelled', 'No-Show'] }
  }).select('workOrder');

  // Create a Set of work order IDs that have future appointments
  const scheduledWorkOrderIds = new Set(
    futureAppointments.map(apt => apt.workOrder.toString())
  );

  // Filter out work orders that have future appointments
  const unscheduledWorkOrders = workOrderCreatedWorkOrders.filter(
    wo => !scheduledWorkOrderIds.has(wo._id.toString())
  );

  res.status(200).json({
    status: 'success',
    results: unscheduledWorkOrders.length,
    data: {
      workOrders: unscheduledWorkOrders
    }
  });
});

// Get all work orders that need scheduling (for appointments page)
exports.getWorkOrdersNeedingScheduling = catchAsync(async (req, res, next) => {
  const needsSchedulingStatuses = ['Work Order Created'];
  const workOrders = await applyPopulation(
    WorkOrder.find({ status: { $in: needsSchedulingStatuses } }),
    'workOrder',
    'standard'
  );

  // Get all future appointments (starting from now)
  const now = new Date();
  const futureAppointments = await Appointment.find({
    startTime: { $gte: now },
    workOrder: { $exists: true },
    status: { $nin: ['Cancelled', 'No-Show'] }
  }).select('workOrder');

  // Create a Set of work order IDs that have future appointments
  const scheduledWorkOrderIds = new Set(
    futureAppointments.map(apt => apt.workOrder.toString())
  );

  // Filter out work orders that have future appointments
  const unscheduledWorkOrders = workOrders.filter(
    wo => !scheduledWorkOrderIds.has(wo._id.toString())
  );

  res.status(200).json({
    status: 'success',
    results: unscheduledWorkOrders.length,
    data: {
      workOrders: unscheduledWorkOrders
    }
  });
});

// Split work order
exports.splitWorkOrder = catchAsync(async (req, res, next) => {
  const originalWorkOrder = await WorkOrder.findById(req.params.id)
    .populate('customer')
    .populate('property')
    .populate('assignedTechnician');

  if (!originalWorkOrder) {
    return next(new AppError('No work order found with that ID', 404));
  }

  // Extract the materials and labor to move to new work order
  const { materialsToMove, laborToMove, newWorkOrderTitle } = req.body;

  if (!materialsToMove && !laborToMove) {
    return next(new AppError('Must specify materials or labor to move to new work order', 400));
  }

  const materialsToMoveIds = materialsToMove || [];
  const laborToMoveIds = laborToMove || [];

  // Find the actual materials and labor items to move
  const materialsToMoveItems = originalWorkOrder.materials.filter(material =>
    materialsToMoveIds.includes(material._id.toString())
  );
  const laborToMoveItems = originalWorkOrder.labor.filter(labor =>
    laborToMoveIds.includes(labor._id.toString())
  );

  if (materialsToMoveItems.length !== materialsToMoveIds.length ||
      laborToMoveItems.length !== laborToMoveIds.length) {
    return next(new AppError('Some specified materials or labor items not found', 400));
  }

  // Create new work order with moved items
  const newWorkOrder = new WorkOrder({
    customer: originalWorkOrder.customer._id,
    property: originalWorkOrder.property?._id,
    assignedTechnician: originalWorkOrder.assignedTechnician ? originalWorkOrder.assignedTechnician._id : null,
    date: todayInTz(),
    priority: originalWorkOrder.priority,
    status: 'Work Order Created',
    serviceNotes: newWorkOrderTitle || `Split from WO ${originalWorkOrder._id.toString().slice(-6)}`,
    materials: materialsToMoveItems.map(material => {
      const { _id, ...materialData } = material.toObject ? material.toObject() : material;
      return materialData;
    }),
    labor: laborToMoveItems.map(labor => ({
      description: labor.description,
      billingType: labor.billingType || 'hourly',
      quantity: labor.quantity || labor.hours,
      rate: labor.rate
    }))
  });

  // Calculate totals for new work order
  newWorkOrder.totalEstimate = calculateWorkOrderTotal(newWorkOrder.materials, newWorkOrder.labor, newWorkOrder.servicePackages);

  // Remove moved items from original work order
  originalWorkOrder.materials = originalWorkOrder.materials.filter(material =>
    !materialsToMoveIds.includes(material._id.toString())
  );
  originalWorkOrder.labor = originalWorkOrder.labor.filter(labor =>
    !laborToMoveIds.includes(labor._id.toString())
  );

  // Update totals for original work order
  originalWorkOrder.totalEstimate = calculateWorkOrderTotal(originalWorkOrder.materials, originalWorkOrder.labor, originalWorkOrder.servicePackages);

  // Add note to original work order about the split
  if (!originalWorkOrder.serviceNotes) {
    originalWorkOrder.serviceNotes = '';
  }
  originalWorkOrder.serviceNotes += `\n\nWork order split on ${formatDate(todayInTz())}. Moved items to new work order.`;

  // Save both work orders
  await Promise.all([
    originalWorkOrder.save(),
    newWorkOrder.save()
  ]);

  // Populate the new work order for response
  await newWorkOrder.populate([
    { path: 'customer', select: 'name phone email' },
    { path: 'property', select: 'address type' },
    { path: 'assignedTechnician', select: 'name specialization' }
  ]);

  res.status(201).json({
    status: 'success',
    data: {
      originalWorkOrder,
      newWorkOrder
    }
  });
});

// Get Service Writer's Corner data - all work orders requiring service writer action
exports.getServiceWritersCorner = catchAsync(async (req, res, next) => {
  // Check cache first
  const cached = cacheService.getServiceWritersCorner();
  if (cached) {
    return res.status(200).json(cached);
  }

  // Service writer action statuses
  const swcStatuses = [
    'Work Order Created',
    'Complete',
    'On Hold',
    'No-Show'
  ];

  // Get only today and future appointments (not past)
  const startOfToday = startOfTodayInTz();

  const appointments = await Appointment.find({
    workOrder: { $exists: true },
    startTime: { $gte: startOfToday },
    status: { $nin: ['Cancelled', 'No-Show'] }
  }).select('workOrder startTime status');

  // Create a map of work order IDs to their future appointments
  const workOrderAppointments = new Map();
  appointments.forEach(apt => {
    const woId = apt.workOrder.toString();
    if (!workOrderAppointments.has(woId)) {
      workOrderAppointments.set(woId, []);
    }
    workOrderAppointments.get(woId).push(apt);
  });

  // Helper function to add appointment info to work orders
  const addAppointmentInfo = (workOrders) => {
    return workOrders.map(wo => {
      const woAppointments = workOrderAppointments.get(wo._id.toString()) || [];
      const nextAppointment = woAppointments.sort((a, b) =>
        new Date(a.startTime) - new Date(b.startTime)
      )[0];

      return {
        ...wo.toObject(),
        appointmentId: nextAppointment?._id || null,
        hasAppointment: !!nextAppointment
      };
    });
  };

  // Query all SWC statuses in one shot
  const allWorkOrdersRaw = await applyPopulation(
    WorkOrder.find({ status: { $in: swcStatuses } }),
    'workOrder',
    'standard'
  );

  const workOrders = addAppointmentInfo(allWorkOrdersRaw);

  const responseData = {
    status: 'success',
    data: {
      workOrders,
      count: workOrders.length
    }
  };

  // Cache the response for 3 minutes (shorter TTL for high-priority data)
  cacheService.setServiceWritersCorner(responseData);

  res.status(200).json(responseData);
});

// Get active work orders by multiple statuses in a single call
exports.getActiveWorkOrdersByStatuses = catchAsync(async (req, res, next) => {
  const { statuses } = req.query;

  if (!statuses) {
    return next(new AppError('Please provide statuses parameter', 400));
  }

  // Parse statuses (comma-separated)
  const statusList = statuses.split(',').map(s => s.trim());

  // Check cache first
  const cacheKey = `workorders:active:${statusList.sort().join(',')}`;
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  // Build query with $in for multiple statuses
  const query = { status: { $in: statusList } };

  const workOrders = await applyPopulation(
    WorkOrder.find(query).sort({ date: -1 }),
    'workOrder',
    'standard'
  );

  // Group work orders by status for easier consumption
  const groupedByStatus = {};
  statusList.forEach(status => {
    groupedByStatus[status] = workOrders.filter(wo => wo.status === status);
  });

  const responseData = {
    status: 'success',
    results: workOrders.length,
    data: {
      workOrders,
      groupedByStatus
    }
  };

  // Cache for 5 minutes
  cacheService.set(cacheKey, responseData, 300);

  res.status(200).json(responseData);
});

// Get work orders for Technician Portal (filtered at API level)
exports.getTechnicianWorkOrders = catchAsync(async (req, res, next) => {
  const { technicianId } = req.query;

  // Technician-relevant statuses
  const technicianStatuses = [
    'Appointment Scheduled',
    'In Progress'
  ];

  // Check cache first
  const cacheKey = technicianId
    ? `workorders:technician:${technicianId}`
    : 'workorders:technician:all';
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  // Build query
  const query = { status: { $in: technicianStatuses } };
  if (technicianId) {
    query.assignedTechnician = technicianId;
  }

  const workOrders = await applyPopulation(
    WorkOrder.find(query).sort({ date: -1 }),
    'workOrder',
    'standard'
  );

  const responseData = {
    status: 'success',
    results: workOrders.length,
    data: { workOrders }
  };

  // Cache for 3 minutes (shorter for frequently changing data)
  cacheService.set(cacheKey, responseData, 180);

  res.status(200).json(responseData);
});

// Get technician dashboard data (work orders + today's schedule + stats)
exports.getTechnicianDashboard = catchAsync(async (req, res, next) => {
  const technicianId = req.user.technician;
  if (!technicianId) {
    return next(new AppError('No technician profile linked to this account', 400));
  }

  const cacheKey = `workorders:tech-dashboard:${technicianId}`;
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const technicianStatuses = [
    'Appointment Scheduled',
    'In Progress'
  ];

  const workOrders = await applyPopulation(
    WorkOrder.find({
      assignedTechnician: technicianId,
      status: { $in: technicianStatuses }
    }).sort({ date: -1 }),
    'workOrder',
    'techDashboard'
  );

  // Extract today's appointments from populated work orders
  const { startOfDay, endOfDay } = getDayBoundaries(new Date());
  const todaysSchedule = [];

  for (const wo of workOrders) {
    const allAppointments = wo.appointments || [];
    // Deduplicate by _id
    const seen = new Set();
    for (const appt of allAppointments) {
      if (!appt || !appt.startTime || seen.has(String(appt._id))) continue;
      seen.add(String(appt._id));
      if (appt.startTime >= startOfDay && appt.startTime <= endOfDay &&
          appt.status !== 'Cancelled' && appt.status !== 'No-Show') {
        todaysSchedule.push({
          appointmentId: appt._id,
          workOrderId: wo._id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          serviceType: appt.serviceType,
          property: wo.property,
          customer: wo.customer,
          workOrderStatus: wo.status,
          priority: wo.priority,
          services: wo.services
        });
      }
    }
  }

  todaysSchedule.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const stats = {
    total: workOrders.length,
    inProgress: workOrders.filter(wo => wo.status === 'In Progress').length,
    todayCount: todaysSchedule.length,
    awaitingAction: workOrders.filter(wo =>
      ['Appointment Scheduled'].includes(wo.status)
    ).length
  };

  const activeJob = workOrders.find(wo => wo.status === 'In Progress') || null;

  const responseData = {
    status: 'success',
    data: {
      workOrders,
      todaysSchedule,
      stats,
      activeJob: activeJob ? activeJob._id : null
    }
  };

  cacheService.set(cacheKey, responseData, 120);
  res.status(200).json(responseData);
});

// ==================== QUOTE ENDPOINTS ====================

// Get all quotes
exports.getAllQuotes = catchAsync(async (req, res, next) => {
  const { customer, property, startDate, endDate, includeArchived } = req.query;

  const cacheKey = `quotes:all:${JSON.stringify({ customer, property, startDate, endDate, includeArchived })}`;
  const cached = cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const query = includeArchived === 'true'
    ? { status: { $in: ['Quote', 'Quote - Archived'] } }
    : { status: 'Quote' };
  if (customer) query.customer = customer;
  if (property) query.property = property;
  Object.assign(query, buildDateRangeQuery(startDate, endDate, 'date'));

  const quotes = await applyPopulation(
    WorkOrder.find(query).sort({ date: -1 }),
    'workOrder',
    'standard'
  );

  const responseData = {
    status: 'success',
    results: quotes.length,
    data: { quotes }
  };

  cacheService.set(cacheKey, responseData, 300);
  res.status(200).json(responseData);
});

// Create a new quote
exports.createQuote = catchAsync(async (req, res, next) => {
  const customer = await validateEntityExists(Customer, req.body.customer, 'Customer');

  // Validate property exists and belongs to customer if provided
  if (req.body.property) {
    const property = await Property.findById(req.body.property);
    if (!property) {
      return next(new AppError('Property not found', 404));
    }
    if (property.customer && property.customer.toString() !== customer._id.toString()) {
      return next(new AppError('Property does not belong to this customer', 400));
    }
  }

  let quoteData = { ...req.body };
  quoteData.createdBy = req.user._id;

  // Handle services array if provided
  if (!quoteData.services || quoteData.services.length === 0) {
    quoteData.services = [];
  } else if (typeof quoteData.services === 'string') {
    try {
      quoteData.services = JSON.parse(quoteData.services);
    } catch (e) {
      quoteData.services = [{ description: quoteData.services }];
    }
  }

  // Force status to Quote
  quoteData.status = 'Quote';

  // Calculate total estimate
  if (!quoteData.totalEstimate) {
    quoteData.totalEstimate = calculateWorkOrderTotal(quoteData.materials, quoteData.labor, quoteData.servicePackages);
  }

  const newQuote = await WorkOrder.create(quoteData);

  // Add to property service history
  if (quoteData.property) {
    const property = await Property.findById(quoteData.property);
    if (property) {
      property.serviceHistory.push(newQuote._id);
      await property.save({ validateBeforeSave: false });
    }
  }

  cacheService.invalidateAllWorkOrders();

  res.status(201).json({
    status: 'success',
    data: { quote: newQuote }
  });
});

// Convert a quote to a work order (full or partial)
exports.convertQuoteToWorkOrder = catchAsync(async (req, res, next) => {
  const quote = await WorkOrder.findById(req.params.id)
    .populate('customer')
    .populate('property');

  if (!quote) {
    return next(new AppError('No quote found with that ID', 404));
  }

  if (quote.status !== 'Quote') {
    return next(new AppError('This record is not a quote', 400));
  }

  const { materialsToConvert, laborToConvert } = req.body;
  const isPartialConversion = materialsToConvert || laborToConvert;

  if (isPartialConversion) {
    const materialsToConvertIds = materialsToConvert || [];
    const laborToConvertIds = laborToConvert || [];

    const materialsToMove = quote.materials.filter(material =>
      materialsToConvertIds.includes(material._id.toString())
    );
    const laborToMove = quote.labor.filter(labor =>
      laborToConvertIds.includes(labor._id.toString())
    );

    if (materialsToMove.length === 0 && laborToMove.length === 0) {
      return next(new AppError('Must select at least one material or labor item to convert', 400));
    }

    // Check if converting everything
    const allMaterialsSelected = materialsToConvertIds.length === quote.materials.length;
    const allLaborSelected = laborToConvertIds.length === quote.labor.length;
    const convertingAll = allMaterialsSelected && allLaborSelected;

    if (convertingAll) {
      // Full conversion on same document
      quote.status = 'Work Order Created';
      await quote.save();

      const populatedWorkOrder = await applyPopulation(
        WorkOrder.findById(req.params.id),
        'workOrder',
        'detailed'
      );

      cacheService.invalidateAllWorkOrders();

      return res.status(200).json({
        status: 'success',
        message: 'Quote fully converted to work order',
        data: { workOrder: populatedWorkOrder }
      });
    }

    // Create new work order with selected items
    const newWorkOrder = new WorkOrder({
      customer: quote.customer._id,
      property: quote.property ? quote.property._id : null,
      date: todayInTz(),
      priority: quote.priority,
      status: 'Work Order Created',
      services: quote.services.map(s => ({ description: s.description })),
      serviceNotes: `Converted from Quote #${quote._id.toString().slice(-8).toUpperCase()}`,
      materials: materialsToMove.map(material => {
        const { _id, ...materialData } = material.toObject ? material.toObject() : material;
        return materialData;
      }),
      labor: laborToMove.map(labor => ({
        description: labor.description,
        billingType: labor.billingType || 'hourly',
        quantity: labor.quantity || labor.hours,
        rate: labor.rate
      }))
    });

    newWorkOrder.totalEstimate = calculateWorkOrderTotal(newWorkOrder.materials, newWorkOrder.labor, newWorkOrder.servicePackages);
    await newWorkOrder.save();

    // Remove converted items from quote
    quote.materials = quote.materials.filter(material =>
      !materialsToConvertIds.includes(material._id.toString())
    );
    quote.labor = quote.labor.filter(labor =>
      !laborToConvertIds.includes(labor._id.toString())
    );
    quote.totalEstimate = calculateWorkOrderTotal(quote.materials, quote.labor, quote.servicePackages);

    // Archive quote if nothing remains
    if (quote.materials.length === 0 && quote.labor.length === 0) {
      quote.status = 'Quote - Archived';
    }

    await quote.save();

    const populatedNewWO = await applyPopulation(
      WorkOrder.findById(newWorkOrder._id),
      'workOrder',
      'detailed'
    );

    const populatedQuote = await applyPopulation(
      WorkOrder.findById(req.params.id),
      'workOrder',
      'detailed'
    );

    cacheService.invalidateAllWorkOrders();

    return res.status(200).json({
      status: 'success',
      message: 'Partial quote conversion successful',
      data: {
        workOrder: populatedNewWO,
        quote: populatedQuote,
        quoteArchived: quote.status === 'Quote - Archived'
      }
    });
  }

  // Full conversion (original behavior): change status on same document
  quote.status = 'Work Order Created';
  await quote.save();

  const populatedWorkOrder = await applyPopulation(
    WorkOrder.findById(req.params.id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();

  res.status(200).json({
    status: 'success',
    message: 'Quote converted to work order successfully',
    data: { workOrder: populatedWorkOrder }
  });
});

// Generate a quote from an existing work order
exports.generateQuoteFromWorkOrder = catchAsync(async (req, res, next) => {
  const workOrder = await WorkOrder.findById(req.params.id)
    .populate('customer')
    .populate('property');

  if (!workOrder) {
    return next(new AppError('No work order found with that ID', 404));
  }

  // Determine which materials/labor to copy
  const { materialsToInclude, laborToInclude } = req.body;
  const materialsSource = materialsToInclude
    ? workOrder.materials.filter(m => materialsToInclude.includes(m._id.toString()))
    : workOrder.materials;
  const laborSource = laborToInclude
    ? workOrder.labor.filter(l => laborToInclude.includes(l._id.toString()))
    : workOrder.labor;

  const newQuote = new WorkOrder({
    customer: workOrder.customer._id,
    property: workOrder.property ? workOrder.property._id : null,
    date: todayInTz(),
    priority: workOrder.priority,
    status: 'Quote',
    services: workOrder.services.map(s => ({ description: s.description })),
    serviceNotes: `Generated from Work Order #${workOrder._id.toString().slice(-8).toUpperCase()}`,
    materials: materialsSource.map(material => {
      const { _id, ...materialData } = material.toObject ? material.toObject() : material;
      return materialData;
    }),
    labor: laborSource.map(labor => ({
      description: labor.description,
      billingType: labor.billingType || 'hourly',
      quantity: labor.quantity || labor.hours,
      rate: labor.rate
    }))
  });

  newQuote.totalEstimate = calculateWorkOrderTotal(newQuote.materials, newQuote.labor, newQuote.servicePackages);
  await newQuote.save();

  const populatedQuote = await applyPopulation(
    WorkOrder.findById(newQuote._id),
    'workOrder',
    'detailed'
  );

  cacheService.invalidateAllWorkOrders();

  res.status(201).json({
    status: 'success',
    message: 'Quote generated from work order successfully',
    data: { quote: populatedQuote }
  });
});

// Archive a quote
exports.archiveQuote = catchAsync(async (req, res, next) => {
  const quote = await validateEntityExists(WorkOrder, req.params.id, 'Quote');

  if (quote.status !== 'Quote') {
    return next(new AppError('Only active quotes can be archived', 400));
  }

  quote.status = 'Quote - Archived';
  await quote.save();

  cacheService.invalidateAllWorkOrders();

  res.status(200).json({
    status: 'success',
    message: 'Quote archived successfully'
  });
});

// Unarchive a quote
exports.unarchiveQuote = catchAsync(async (req, res, next) => {
  const quote = await validateEntityExists(WorkOrder, req.params.id, 'Quote');

  if (quote.status !== 'Quote - Archived') {
    return next(new AppError('Only archived quotes can be unarchived', 400));
  }

  quote.status = 'Quote';
  await quote.save();

  cacheService.invalidateAllWorkOrders();

  res.status(200).json({
    status: 'success',
    message: 'Quote unarchived successfully'
  });
});
