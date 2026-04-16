/**
 * Database Index Migration Script
 *
 * This script adds indexes to frequently queried fields to improve
 * query performance and reduce MongoDB Atlas rate limiting issues.
 *
 * Run with: node src/server/utils/addDatabaseIndexes.js
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const addIndexes = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;

    // Work Orders Collection Indexes
    console.log('\n=== Adding Work Orders indexes ===');
    const workOrdersCollection = db.collection('workorders');

    await workOrdersCollection.createIndex({ status: 1 });
    console.log('✓ Created index on workorders.status');

    await workOrdersCollection.createIndex({ customer: 1 });
    console.log('✓ Created index on workorders.customer');

    await workOrdersCollection.createIndex({ property: 1 });
    console.log('✓ Created index on workorders.property');

    await workOrdersCollection.createIndex({ date: -1 });
    console.log('✓ Created index on workorders.date (descending)');

    await workOrdersCollection.createIndex({ assignedTechnician: 1 });
    console.log('✓ Created index on workorders.assignedTechnician');

    // Compound index for common query patterns
    await workOrdersCollection.createIndex({ status: 1, date: -1 });
    console.log('✓ Created compound index on workorders.status + date');

    // Text index for search
    await workOrdersCollection.createIndex({
      serviceNotes: 'text',
      completionNotes: 'text',
      'services.description': 'text'
    });
    console.log('✓ Created text index on workorders for full-text search');

    // Appointments Collection Indexes
    console.log('\n=== Adding Appointments indexes ===');
    const appointmentsCollection = db.collection('appointments');

    await appointmentsCollection.createIndex({ startTime: 1 });
    console.log('✓ Created index on appointments.startTime');

    await appointmentsCollection.createIndex({ endTime: 1 });
    console.log('✓ Created index on appointments.endTime');

    await appointmentsCollection.createIndex({ workOrder: 1 });
    console.log('✓ Created index on appointments.workOrder');

    await appointmentsCollection.createIndex({ technician: 1 });
    console.log('✓ Created index on appointments.technician');

    await appointmentsCollection.createIndex({ status: 1 });
    console.log('✓ Created index on appointments.status');

    // Compound index for date range queries
    await appointmentsCollection.createIndex({ startTime: 1, endTime: 1 });
    console.log('✓ Created compound index on appointments.startTime + endTime');

    // Compound index for work order scheduling queries
    await appointmentsCollection.createIndex({ workOrder: 1, startTime: 1, status: 1 });
    console.log('✓ Created compound index on appointments.workOrder + startTime + status');

    // Customers Collection Indexes
    console.log('\n=== Adding Customers indexes ===');
    const customersCollection = db.collection('customers');

    await customersCollection.createIndex({ email: 1 });
    console.log('✓ Created index on customers.email');

    await customersCollection.createIndex({ phone: 1 });
    console.log('✓ Created index on customers.phone');

    await customersCollection.createIndex({ name: 1 });
    console.log('✓ Created index on customers.name');

    // Text index for customer search
    await customersCollection.createIndex({
      name: 'text',
      email: 'text',
      phone: 'text'
    });
    console.log('✓ Created text index on customers for full-text search');

    // Properties Collection Indexes
    console.log('\n=== Adding Properties indexes ===');
    const propertiesCollection = db.collection('properties');

    await propertiesCollection.createIndex({ customer: 1 });
    console.log('✓ Created index on properties.customer');

    await propertiesCollection.createIndex({ 'address.zip': 1 });
    console.log('✓ Created index on properties.address.zip');

    await propertiesCollection.createIndex({ 'address.city': 1 });
    console.log('✓ Created index on properties.address.city');

    // Text index for property search
    await propertiesCollection.createIndex({
      'address.street': 'text',
      'address.city': 'text',
      'address.zip': 'text'
    });
    console.log('✓ Created text index on properties for full-text search');

    // Users Collection Indexes
    console.log('\n=== Adding Users indexes ===');
    const usersCollection = db.collection('users');

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    console.log('✓ Created unique index on users.email');

    await usersCollection.createIndex({ role: 1 });
    console.log('✓ Created index on users.role');

    // Work Order Notes Collection Indexes
    console.log('\n=== Adding Work Order Notes indexes ===');
    const workOrderNotesCollection = db.collection('workordernotes');

    await workOrderNotesCollection.createIndex({ workOrder: 1 });
    console.log('✓ Created index on workordernotes.workOrder');

    await workOrderNotesCollection.createIndex({ createdAt: -1 });
    console.log('✓ Created index on workordernotes.createdAt (descending)');

    await workOrderNotesCollection.createIndex({ workOrder: 1, createdAt: -1 });
    console.log('✓ Created compound index on workordernotes.workOrder + createdAt');

    // Media Collection Indexes
    console.log('\n=== Adding Media indexes ===');
    const mediaCollection = db.collection('media');

    await mediaCollection.createIndex({ workOrder: 1 });
    console.log('✓ Created index on media.workOrder');

    await mediaCollection.createIndex({ property: 1 });
    console.log('✓ Created index on media.property');

    await mediaCollection.createIndex({ customer: 1 });
    console.log('✓ Created index on media.customer');

    await mediaCollection.createIndex({ type: 1 });
    console.log('✓ Created index on media.type');

    // Customer Interactions Collection Indexes
    console.log('\n=== Adding Customer Interactions indexes ===');
    const customerInteractionsCollection = db.collection('customerinteractions');

    await customerInteractionsCollection.createIndex({ workOrder: 1 });
    console.log('✓ Created index on customerinteractions.workOrder');

    await customerInteractionsCollection.createIndex({ customer: 1 });
    console.log('✓ Created index on customerinteractions.customer');

    await customerInteractionsCollection.createIndex({ createdAt: -1 });
    console.log('✓ Created index on customerinteractions.createdAt (descending)');

    await customerInteractionsCollection.createIndex({ followUpRequired: 1, completedAt: 1 });
    console.log('✓ Created compound index on customerinteractions.followUpRequired + completedAt');

    await customerInteractionsCollection.createIndex({ workOrder: 1, createdAt: -1 });
    console.log('✓ Created compound index on customerinteractions.workOrder + createdAt');

    console.log('\n✅ All indexes created successfully!');
    console.log('\n💡 Recommendations:');
    console.log('1. Monitor MongoDB Atlas Performance tab to verify index usage');
    console.log('2. Check slow query logs to identify any remaining bottlenecks');
    console.log('3. Consider upgrading MongoDB tier if still hitting rate limits');

  } catch (error) {
    console.error('Error creating indexes:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
  }
};

// Run the migration
addIndexes();
