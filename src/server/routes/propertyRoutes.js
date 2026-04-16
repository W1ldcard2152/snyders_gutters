const express = require('express');
const propertyController = require('../controllers/propertyController');
const authController = require('../controllers/authController');
const router = express.Router();

// Protect all routes - require authentication
router.use(authController.protect);

// All property routes require office staff
router.use(authController.restrictTo('admin', 'management', 'service-writer'));

// Search properties
router.get('/search', propertyController.searchProperties);

// Get property service history
router.get('/:id/service-history', propertyController.getPropertyServiceHistory);

// Basic CRUD routes
router
  .route('/')
  .get(propertyController.getAllProperties)
  .post(propertyController.createProperty);

router
  .route('/:id')
  .get(propertyController.getProperty)
  .patch(propertyController.updateProperty)
  .delete(
    authController.restrictTo('admin', 'management'),
    propertyController.deleteProperty
  );

module.exports = router;
