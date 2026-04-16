const Invoice = require('../models/Invoice');
const WorkOrder = require('../models/WorkOrder');
const Customer = require('../models/Customer');
const Property = require('../models/Property');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { parseLocalDate, todayInTz } = require('../utils/dateUtils');
const { calculateMaterialsCost, calculateLaborCost, calculateServicePackagesCost } = require('../utils/calculationHelpers');
const emailService = require('../services/emailService');

// Get all invoices
exports.getAllInvoices = catchAsync(async (req, res, next) => {
  const { customer, property, workOrder, status, startDate, endDate } = req.query;

  const query = {};

  if (customer) query.customer = customer;
  if (property) query.property = property;
  if (workOrder) query.workOrder = workOrder;
  if (status) query.status = status;

  if (startDate || endDate) {
    query.invoiceDate = {};
    if (startDate) query.invoiceDate.$gte = parseLocalDate(startDate);
    if (endDate) query.invoiceDate.$lte = parseLocalDate(endDate);
  }

  const invoices = await Invoice.find(query)
    .populate('customer', 'name phone email')
    .populate('property', 'address propertyType')
    .populate({ path: 'workOrder', populate: [{ path: 'assignedTechnician', select: 'name displayName' }, { path: 'createdBy', select: 'name displayName' }] })
    .sort({ invoiceDate: -1 });

  res.status(200).json({
    status: 'success',
    results: invoices.length,
    data: {
      invoices
    }
  });
});

// Get a single invoice
exports.getInvoice = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate('customer', 'name phone email address')
    .populate('property', 'address propertyType')
    .populate({ path: 'workOrder', populate: [{ path: 'assignedTechnician', select: 'name displayName' }, { path: 'createdBy', select: 'name displayName' }] });

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      invoice
    }
  });
});

// Get invoice count (for generating invoice numbers)
exports.getInvoicesCount = catchAsync(async (req, res, next) => {
  const count = await Invoice.countDocuments();

  res.status(200).json({
    status: 'success',
    count
  });
});

// Create a new invoice
exports.createInvoice = catchAsync(async (req, res, next) => {
  const {
    invoiceNumber,
    customerId,
    propertyId,
    workOrderId,
    invoiceDate,
    invoiceDueDate,
    paymentTerms,
    materials,
    labor,
    servicePackages,
    subtotal,
    taxRate,
    taxAmount,
    total,
    customerNotes,
    terms
  } = req.body;

  const customer = await Customer.findById(customerId);

  if (!customer) {
    return next(new AppError('No customer found with that ID', 404));
  }

  const property = await Property.findById(propertyId);

  if (!property) {
    return next(new AppError('No property found with that ID', 404));
  }

  // Verify that the property belongs to the customer
  if (property.customer.toString() !== customer._id.toString()) {
    return next(
      new AppError('The property does not belong to this customer', 400)
    );
  }

  // If a work order is referenced, verify it exists and doesn't already have an invoice
  let workOrderToUpdate = null;
  if (workOrderId) {
    workOrderToUpdate = await WorkOrder.findById(workOrderId);

    if (!workOrderToUpdate) {
      return next(new AppError('No work order found with that ID', 404));
    }

    if (workOrderToUpdate.invoice) {
      const existingInvoice = await Invoice.findById(workOrderToUpdate.invoice);
      if (existingInvoice) {
        return next(new AppError(
          `This work order already has an invoice (#${existingInvoice.invoiceNumber || existingInvoice._id.toString().slice(-6)}). Only one invoice per work order is allowed.`,
          400
        ));
      }
    }

    workOrderToUpdate.totalActual = calculateMaterialsCost(workOrderToUpdate.materials) + calculateLaborCost(workOrderToUpdate.labor) + calculateServicePackagesCost(workOrderToUpdate.servicePackages);
    workOrderToUpdate.status = 'Invoiced';
  }

  // Combine materials and labor into invoice items
  const items = [
    ...(materials || []).map(material => ({
      type: 'Supply',
      description: material.name || material.description,
      partNumber: material.partNumber,
      quantity: material.quantity,
      unitPrice: material.price,
      total: material.total || (material.quantity * material.price),
      taxable: true,
      warranty: material.warranty || ''
    })),
    ...(labor || []).map(laborItem => {
      const qty = laborItem.quantity || laborItem.hours || 0;
      return {
        type: 'Labor',
        description: laborItem.description,
        quantity: qty,
        unitPrice: laborItem.rate,
        total: laborItem.total || (qty * laborItem.rate),
        taxable: true,
        billingType: laborItem.billingType || 'hourly'
      };
    }),
    ...(servicePackages || []).map(pkg => ({
      type: 'Service',
      description: pkg.name,
      quantity: 1,
      unitPrice: pkg.price,
      total: pkg.price,
      taxable: true,
      billingType: 'fixed'
    }))
  ];

  let dueDate = invoiceDueDate ? parseLocalDate(invoiceDueDate) : parseLocalDate(invoiceDate) || todayInTz();

  if (!invoiceDueDate) {
    switch (paymentTerms) {
      case 'Net 15':
        dueDate.setDate(dueDate.getDate() + 15);
        break;
      case 'Net 30':
        dueDate.setDate(dueDate.getDate() + 30);
        break;
      case 'Net 60':
        dueDate.setDate(dueDate.getDate() + 60);
        break;
    }
  }

  const invoiceData = {
    invoiceNumber,
    customer: customerId,
    property: propertyId,
    workOrder: workOrderId,
    invoiceDate: invoiceDate ? parseLocalDate(invoiceDate) : todayInTz(),
    dueDate,
    items,
    subtotal,
    taxRate: taxRate || 0,
    taxAmount: taxAmount || 0,
    total,
    status: 'Issued',
    paymentTerms: paymentTerms || 'Due on Receipt',
    notes: customerNotes,
    terms,
    createdBy: req.user ? req.user.name : 'System'
  };

  const newInvoice = await Invoice.create(invoiceData);

  if (workOrderToUpdate) {
    workOrderToUpdate.invoice = newInvoice._id;
    await workOrderToUpdate.save();
  }

  res.status(201).json({
    status: 'success',
    data: {
      invoice: newInvoice
    }
  });
});

// Update an invoice
exports.updateInvoice = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  if (invoice.status === 'Paid' &&
      (req.body.items || req.body.subtotal || req.body.total || req.body.taxRate)) {
    return next(
      new AppError('Cannot modify financial details of a paid invoice', 400)
    );
  }

  if (req.user) {
    req.body.updatedBy = req.user.name;
  }

  const updatedInvoice = await Invoice.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    status: 'success',
    data: {
      invoice: updatedInvoice
    }
  });
});

// Delete an invoice
exports.deleteInvoice = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  if (invoice.status === 'Paid') {
    return next(
      new AppError('Cannot delete a paid invoice', 400)
    );
  }

  if (invoice.workOrder) {
    const workOrder = await WorkOrder.findById(invoice.workOrder);

    if (workOrder) {
      workOrder.invoice = null;

      if (workOrder.status === 'Invoiced') {
        workOrder.status = 'Complete';
      }

      await workOrder.save();
    }
  }

  await Invoice.findByIdAndDelete(req.params.id);

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Add a payment to an invoice
exports.addPayment = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  const { amount, method, reference, notes } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Please provide a valid payment amount', 400));
  }

  await invoice.addPayment({
    date: Date.now(),
    amount,
    method: method || 'Cash',
    reference,
    notes
  });

  const updatedInvoice = await Invoice.findById(req.params.id)
    .populate('customer', 'name phone email')
    .populate('property', 'address propertyType');

  res.status(200).json({
    status: 'success',
    data: {
      invoice: updatedInvoice
    }
  });
});

// Generate PDF (stub implementation)
exports.generatePDF = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate('customer', 'name phone email address')
    .populate('property', 'address propertyType')
    .populate({ path: 'workOrder', populate: [{ path: 'assignedTechnician', select: 'name displayName' }, { path: 'createdBy', select: 'name displayName' }] });

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    message: 'PDF generation would happen here in production',
    data: {
      invoice
    }
  });
});

// Send invoice via email
exports.sendInvoiceViaEmail = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate('customer', 'name phone email')
    .populate('property', 'address propertyType');

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  const { email } = req.body;

  const recipientEmail = email || invoice.customer.email;

  if (!recipientEmail) {
    return next(new AppError('Please provide an email address', 400));
  }

  res.status(200).json({
    status: 'success',
    message: `Invoice would be sent to ${recipientEmail} in production`,
    data: {
      invoice
    }
  });
});

// Update invoice status
exports.updateInvoiceStatus = catchAsync(async (req, res, next) => {
  const { status } = req.body;
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  const allowedStatuses = ['', 'Draft', 'Issued', 'Paid', 'Partial', 'Overdue', 'Cancelled', 'Refunded'];
  if (!allowedStatuses.includes(status)) {
    return next(new AppError(`Invalid status: ${status}`, 400));
  }

  invoice.status = status;
  if (req.user) {
    invoice.updatedBy = req.user.name;
    invoice.updatedAt = Date.now();
  }
  await invoice.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      invoice,
    },
  });
});

// Mark invoice as paid
exports.markAsPaid = catchAsync(async (req, res, next) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }

  const { amount, method, reference, notes } = req.body;

  const paymentAmount = amount || invoice.total;

  await invoice.addPayment({
    date: Date.now(),
    amount: paymentAmount,
    method: method || 'Cash',
    reference,
    notes
  });

  const updatedInvoice = await Invoice.findById(req.params.id)
    .populate('customer', 'name phone email')
    .populate('property', 'address propertyType');

  res.status(200).json({
    status: 'success',
    data: {
      invoice: updatedInvoice
    }
  });
});
