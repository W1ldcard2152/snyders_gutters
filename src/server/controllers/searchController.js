const Customer = require('../models/Customer');
const Property = require('../models/Property');
const WorkOrder = require('../models/WorkOrder');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { formatDate, TIMEZONE } = require('../config/timezone');
const { getDayBoundaries } = require('../utils/dateUtils');

/**
 * Escape special regex characters to prevent ReDoS and NoSQL injection attacks
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string safe for use in regex
 */
const escapeRegex = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const globalSearch = catchAsync(async (req, res, next) => {
  const { q: searchQuery } = req.query;

  if (!searchQuery || searchQuery.trim().length < 1) {
    return res.status(200).json({
      status: 'success',
      data: {
        results: []
      }
    });
  }

  // Limit query length to prevent ReDoS attacks
  const rawQuery = searchQuery.trim().slice(0, 100);
  // Escape regex special characters to prevent injection
  const query = escapeRegex(rawQuery);
  const results = [];

  try {
    // Search customers
    const customers = await Customer.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { phone: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } },
        { 'address.street': { $regex: query, $options: 'i' } },
        { 'address.city': { $regex: query, $options: 'i' } },
        { 'address.state': { $regex: query, $options: 'i' } },
        { 'address.zip': { $regex: query, $options: 'i' } },
        { notes: { $regex: query, $options: 'i' } }
      ]
    }).limit(10);

    customers.forEach(customer => {
      results.push({
        type: 'customer',
        id: customer._id,
        title: customer.name,
        subtitle: customer.phone,
        description: customer.email || customer.fullAddress || 'No additional info'
      });
    });

    // Search properties
    const properties = await Property.find({
      $or: [
        { 'address.street': { $regex: query, $options: 'i' } },
        { 'address.city': { $regex: query, $options: 'i' } },
        { 'address.state': { $regex: query, $options: 'i' } },
        { 'address.zip': { $regex: query, $options: 'i' } },
        { notes: { $regex: query, $options: 'i' } }
      ]
    })
    .populate('customer', 'name phone')
    .limit(10);

    properties.forEach(property => {
      const addressStr = property.address
        ? [property.address.street, property.address.city, property.address.state].filter(Boolean).join(', ')
        : 'No address';
      results.push({
        type: 'property',
        id: property._id,
        title: addressStr,
        subtitle: property.customer ? `Owner: ${property.customer.name}` : 'Unknown Owner',
        description: `${property.propertyType || 'residential'} — ${property.address?.zip || ''}`
      });
    });

    // Search work orders
    const workOrders = await WorkOrder.find({
      $or: [
        { serviceNotes: { $regex: query, $options: 'i' } },
        { completionNotes: { $regex: query, $options: 'i' } },
        { status: { $regex: query, $options: 'i' } },
        { 'services.description': { $regex: query, $options: 'i' } },
        { 'materials.name': { $regex: query, $options: 'i' } },
        { 'materials.partNumber': { $regex: query, $options: 'i' } },
        { 'labor.description': { $regex: query, $options: 'i' } }
      ]
    })
    .populate('customer', 'name phone')
    .populate('property', 'address propertyType')
    .sort({ createdAt: -1 })
    .limit(10);

    workOrders.forEach(workOrder => {
      const propertyInfo = workOrder.property && workOrder.property.address
        ? [workOrder.property.address.street, workOrder.property.address.city].filter(Boolean).join(', ')
        : 'No property';

      results.push({
        type: 'workorder',
        id: workOrder._id,
        title: `Work Order - ${workOrder.customer ? workOrder.customer.name : 'Unknown Customer'}`,
        subtitle: propertyInfo,
        description: workOrder.serviceNotes || (workOrder.services && workOrder.services[0]?.description) || 'No service description'
      });
    });

    // Advanced search: If query looks like a date, search by date
    const dateQuery = new Date(query);
    if (!isNaN(dateQuery.getTime()) && query.length > 5) {
      const { startOfDay, endOfDay } = getDayBoundaries(query);

      const workOrdersByDate = await WorkOrder.find({
        createdAt: {
          $gte: startOfDay,
          $lte: endOfDay
        }
      })
      .populate('customer', 'name phone')
      .populate('property', 'address propertyType')
      .limit(5);

      workOrdersByDate.forEach(workOrder => {
        if (!results.some(r => r.type === 'workorder' && r.id === workOrder._id.toString())) {
          const propertyInfo = workOrder.property && workOrder.property.address
            ? [workOrder.property.address.street, workOrder.property.address.city].filter(Boolean).join(', ')
            : 'No property';

          results.push({
            type: 'workorder',
            id: workOrder._id,
            title: `Work Order - ${workOrder.customer ? workOrder.customer.name : 'Unknown Customer'}`,
            subtitle: propertyInfo,
            description: `Created: ${formatDate(workOrder.createdAt)}`
          });
        }
      });
    }

    // If query looks like a phone number, prioritize phone matches
    const phoneRegex = /[\d\-\(\)\s\+]+/;
    if (phoneRegex.test(rawQuery) && rawQuery.length > 6) {
      const phoneDigits = rawQuery.replace(/\D/g, '');
      const phoneMatches = await Customer.find({
        phone: { $regex: phoneDigits, $options: 'i' }
      }).limit(5);

      phoneMatches.forEach(customer => {
        const existingIndex = results.findIndex(r => r.type === 'customer' && r.id === customer._id.toString());
        if (existingIndex !== -1) {
          const match = results.splice(existingIndex, 1)[0];
          results.unshift(match);
        }
      });
    }

    // Sort results: customers first, then properties, then work orders
    results.sort((a, b) => {
      const typeOrder = { customer: 1, property: 2, workorder: 3 };
      if (typeOrder[a.type] !== typeOrder[b.type]) {
        return typeOrder[a.type] - typeOrder[b.type];
      }

      const aExact = a.title.toLowerCase().includes(rawQuery.toLowerCase()) ? 1 : 0;
      const bExact = b.title.toLowerCase().includes(rawQuery.toLowerCase()) ? 1 : 0;
      return bExact - aExact;
    });

    res.status(200).json({
      status: 'success',
      results: results.length,
      data: {
        results: results.slice(0, 20)
      }
    });

  } catch (error) {
    console.error('Global search error:', error);
    return next(new AppError('Search failed. Please try again.', 500));
  }
});

module.exports = {
  globalSearch
};
