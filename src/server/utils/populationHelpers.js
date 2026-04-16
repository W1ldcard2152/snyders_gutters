// Population helper utilities to centralize and standardize .populate() calls
// This eliminates 100+ duplicate populate patterns across controllers

const populationConfigs = {
  workOrder: {
    standard: [
      { path: 'customer', select: 'name phone email' },
      { path: 'property', select: 'address propertyType' },
      { path: 'assignedTechnician', select: 'name displayName specialization' },
      { path: 'createdBy', select: 'name displayName' }
    ],
    detailed: [
      { path: 'customer', select: 'name phone email' },
      { path: 'property', select: 'address propertyType' },
      { path: 'assignedTechnician', select: '_id name displayName specialization' },
      { path: 'createdBy', select: 'name displayName' },
      {
        path: 'appointments',
        select: '_id technician startTime endTime status serviceType',
        populate: {
          path: 'technician',
          select: '_id name displayName specialization'
        }
      }
    ],
    invoice: [
      { path: 'customer', select: 'name email phone address' },
      { path: 'property', select: 'address propertyType' },
      { path: 'assignedTechnician', select: 'name displayName specialization' },
      { path: 'createdBy', select: 'name displayName' }
    ],
    techDashboard: [
      { path: 'customer', select: 'name phone' },
      { path: 'property', select: 'address propertyType' },
      { path: 'assignedTechnician', select: 'name displayName specialization' },
      {
        path: 'appointments',
        select: 'startTime endTime status serviceType',
        options: { sort: { startTime: -1 } }
      }
    ]
  },
  appointment: {
    standard: [
      { path: 'customer', select: 'name phone email' },
      { path: 'property', select: 'address propertyType' },
      { path: 'technician', select: 'name displayName specialization' },
      { path: 'workOrder', select: 'status' }
    ],
    detailed: [
      { path: 'customer', select: 'name phone email' },
      { path: 'property', select: 'address propertyType' },
      { path: 'technician', select: 'name displayName specialization' },
      {
        path: 'workOrder',
        populate: [
          { path: 'assignedTechnician', select: 'name displayName specialization' },
          { path: 'createdBy', select: 'name displayName' },
          { path: 'customer', select: 'name' },
          { path: 'property', select: 'address propertyType' }
        ]
      }
    ],
    withCommunication: [
      { path: 'customer', select: 'name phone email communicationPreference' },
      { path: 'property', select: 'address propertyType' },
      { path: 'technician', select: 'name displayName specialization' }
    ]
  },
  invoice: {
    standard: [
      { path: 'customer', select: 'name phone email' },
      { path: 'property', select: 'address propertyType' },
      {
        path: 'workOrder',
        populate: [
          { path: 'assignedTechnician', select: 'name displayName' },
          { path: 'createdBy', select: 'name displayName' }
        ]
      }
    ]
  },
  interaction: {
    standard: [
      { path: 'customer', select: 'name phone email' },
      { path: 'createdBy', select: 'name displayName' },
      { path: 'completedBy', select: 'name displayName' }
    ]
  },
  property: {
    standard: [
      { path: 'customer', select: 'name phone email' }
    ]
  },
  workOrderNote: {
    standard: [
      { path: 'createdBy', select: 'name displayName email' }
    ]
  }
};

/**
 * Apply population configuration to a query
 * @param {Object} query - Mongoose query object
 * @param {String} modelType - Type of model (workOrder, appointment, etc.)
 * @param {String} variant - Variant of population (standard, detailed, etc.)
 * @returns {Object} Query with populations applied
 */
const applyPopulation = (query, modelType, variant = 'standard') => {
  const config = populationConfigs[modelType]?.[variant];
  if (!config) {
    console.warn(`Population config not found for ${modelType}.${variant}`);
    return query;
  }

  config.forEach(pop => query.populate(pop));
  return query;
};

module.exports = {
  applyPopulation,
  populationConfigs
};
