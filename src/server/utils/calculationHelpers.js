// Calculation helper utilities to eliminate duplicate calculation patterns
// This eliminates 16+ duplicate cost calculation patterns across controllers

/**
 * Calculate total cost of materials
 * @param {Array} materials - Array of material objects with price and quantity
 * @returns {Number} Total materials cost
 */
const calculateMaterialsCost = (materials = []) => {
  return materials.reduce((total, material) => {
    return total + (material.price * material.quantity);
  }, 0);
};

/**
 * Calculate total cost of labor
 * @param {Array} labor - Array of labor objects with quantity/hours and rate
 * @returns {Number} Total labor cost
 */
const calculateLaborCost = (labor = []) => {
  return labor.reduce((total, item) => {
    // Support both new quantity field and legacy hours field
    const qty = item.quantity || item.hours || 0;
    return total + (qty * item.rate);
  }, 0);
};

/**
 * Calculate total cost of service packages
 * @param {Array} servicePackages - Array of service package line objects with price
 * @returns {Number} Total service packages cost
 */
const calculateServicePackagesCost = (servicePackages = []) => {
  return servicePackages.reduce((total, pkg) => total + (pkg.price || 0), 0);
};

/**
 * Calculate total work order cost (materials + labor + service packages)
 * @param {Array} materials - Array of material objects
 * @param {Array} labor - Array of labor objects
 * @param {Array} servicePackages - Array of service package objects
 * @returns {Number} Total cost
 */
const calculateWorkOrderTotal = (materials = [], labor = [], servicePackages = []) => {
  return calculateMaterialsCost(materials) + calculateLaborCost(labor) + calculateServicePackagesCost(servicePackages);
};

/**
 * Calculate and return breakdown of work order costs
 * @param {Object} workOrder - Work order object with materials, labor, and servicePackages
 * @returns {Object} Object with materialsCost, laborCost, servicePackagesCost, and total
 */
const getWorkOrderCostBreakdown = (workOrder) => {
  const materialsCost = calculateMaterialsCost(workOrder.materials);
  const laborCost = calculateLaborCost(workOrder.labor);
  const servicePackagesCost = calculateServicePackagesCost(workOrder.servicePackages);
  const total = materialsCost + laborCost + servicePackagesCost;

  return { materialsCost, laborCost, servicePackagesCost, total };
};

module.exports = {
  calculateMaterialsCost,
  calculateLaborCost,
  calculateServicePackagesCost,
  calculateWorkOrderTotal,
  getWorkOrderCostBreakdown
};
