const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PropertySchema = new Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer reference is required']
    },
    address: {
      street: {
        type: String,
        trim: true,
        required: [true, 'Street address is required']
      },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zip: { type: String, trim: true }
    },
    propertyType: {
      type: String,
      enum: ['residential', 'commercial'],
      default: 'residential'
    },
    stories: {
      type: Number,
      min: [1, 'Stories must be at least 1'],
      default: 1
    },
    estimatedGutterLinearFeet: {
      type: Number,
      min: [0, 'Estimated gutter linear feet cannot be negative']
    },
    roofType: {
      type: String,
      enum: ['asphalt', 'metal', 'tile', 'flat', 'other']
    },
    lotSize: {
      type: String,
      trim: true
    },
    notes: {
      type: String,
      trim: true
    },
    lastServiceDate: {
      type: Date
    },
    serviceHistory: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkOrder'
    }]
  },
  {
    timestamps: true
  }
);

// Indexes for faster queries
PropertySchema.index({ customer: 1 });
PropertySchema.index({ 'address.zip': 1 });
PropertySchema.index({ 'address.city': 1 });

// Virtual for formatted display address
PropertySchema.virtual('displayAddress').get(function() {
  const { street, city, state, zip } = this.address || {};
  return [street, city, state, zip].filter(Boolean).join(', ');
});

// Method to get most recent work order
PropertySchema.methods.getLatestWorkOrder = async function() {
  if (!this.serviceHistory.length) return null;

  return this.model('WorkOrder')
    .findOne({ _id: { $in: this.serviceHistory } })
    .sort({ createdAt: -1 });
};

const Property = mongoose.model('Property', PropertySchema);

module.exports = Property;
