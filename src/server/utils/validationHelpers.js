// Validation helper utilities to eliminate duplicate validation patterns
// This eliminates 36+ duplicate existence check patterns across controllers

const AppError = require('./appError');

/**
 * Validate that an entity exists in the database
 * @param {Object} Model - Mongoose model
 * @param {String} id - Entity ID
 * @param {String} entityName - Name of entity for error message
 * @param {String|Object} selectFields - Optional: fields to select
 * @returns {Promise<Object>} The found entity
 * @throws {AppError} If entity not found
 */
const validateEntityExists = async (Model, id, entityName, selectFields = null) => {
  if (!id) {
    throw new AppError(`${entityName} ID is required`, 400);
  }

  let query = Model.findById(id);
  if (selectFields) {
    query = query.select(selectFields);
  }

  const entity = await query;
  if (!entity) {
    throw new AppError(`No ${entityName.toLowerCase()} found with that ID`, 404);
  }

  return entity;
};

/**
 * Validate multiple entities exist in the database
 * @param {Array} validations - Array of validation configs
 *   Each config: { Model, id, name, key, select }
 * @returns {Promise<Object>} Object with all validated entities
 * @throws {AppError} If any entity not found
 */
const validateMultipleEntities = async (validations) => {
  const results = {};

  for (const { Model, id, name, key, select } of validations) {
    results[key] = await validateEntityExists(Model, id, name, select);
  }

  return results;
};

/**
 * Validate property belongs to customer
 * @param {Object} property - Property document
 * @param {Object} customer - Customer document
 * @throws {AppError} If property doesn't belong to customer
 */
const validatePropertyOwnership = (property, customer) => {
  if (property.customer.toString() !== customer._id.toString()) {
    throw new AppError('The property does not belong to this customer', 400);
  }
};

module.exports = {
  validateEntityExists,
  validateMultipleEntities,
  validatePropertyOwnership
};
