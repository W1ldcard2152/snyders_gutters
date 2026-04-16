const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Material Schema (replaces PartSchema — auto-specific fields removed)
const MaterialSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  partNumber: { // Supplier SKU
    type: String,
    trim: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  price: {
    type: Number,
    min: 0,
    default: 0
  },
  cost: { // Actual cost paid (before markup)
    type: Number,
    min: 0,
    default: 0
  },
  vendor: {
    type: String,
    trim: true
  },
  notes: { // Internal notes — NOT shown on invoice
    type: String,
    trim: true
  },
  warranty: { // Customer-facing warranty info
    type: String,
    trim: true
  },
  category: {
    type: String,
    trim: true,
    default: ''
  },
  inventoryItemId: { // Link to inventory item this material was pulled from
    type: Schema.Types.ObjectId,
    ref: 'InventoryItem'
  }
});

const LaborSchema = new Schema({
  description: {
    type: String,
    required: true,
    trim: true
  },
  billingType: {
    type: String,
    enum: ['hourly', 'fixed'],
    default: 'hourly'
  },
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  rate: {
    type: Number,
    required: true,
    min: 0
  },
  // Legacy field — kept for backward compatibility, maps to quantity for hourly items
  hours: {
    type: Number,
    min: 0
  },
  servicePackageId: { // Link to service package this labor line came from
    type: Schema.Types.ObjectId,
    ref: 'ServicePackage'
  }
});

const ServicePackageItemSchema = new Schema({
  inventoryItemId: { type: Schema.Types.ObjectId, ref: 'InventoryItem' },
  name: { type: String, required: true, trim: true },
  partNumber: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  cost: { type: Number, default: 0, min: 0 },
  unit: { type: String, trim: true }
});

const ServicePackageLineSchema = new Schema({
  servicePackageId: { type: Schema.Types.ObjectId, ref: 'ServicePackage' },
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  committed: { type: Boolean, default: false },
  includedItems: [ServicePackageItemSchema]
});

const MediaSchema = new Schema({
  type: {
    type: String,
    enum: ['Pre-Service', 'In-Progress', 'Post-Service', 'Other'],
    required: true
  },
  fileUrl: {
    type: String,
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    trim: true
  }
});

// Service Schema — describes work requested
const ServiceSchema = new Schema({
  description: {
    type: String,
    required: true,
    trim: true
  }
});

// Main WorkOrder Schema
const WorkOrderSchema = new Schema(
  {
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: false
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true
    },
    date: {
      type: Date,
      default: Date.now
    },
    priority: {
      type: String,
      enum: ['Low', 'Normal', 'High', 'Urgent'],
      default: 'Normal'
    },
    status: {
      type: String,
      enum: [
        'Quote',
        'Work Order Created',
        'Appointment Scheduled',
        'In Progress',
        'Complete',
        'Invoiced',
        'On Hold',
        'No-Show',
        'Cancelled',
        'Quote - Archived'
      ],
      default: 'Work Order Created'
    },
    statusChangedAt: {
      type: Date,
      default: Date.now
    },
    holdReason: {
      type: String,
      enum: [
        'weather-delay',
        'customer-request',
        'access-issue',
        'equipment-issue',
        'other'
      ]
    },
    holdReasonOther: {
      type: String,
      trim: true
    },
    services: [ServiceSchema],
    serviceNotes: {
      type: String,
      trim: true
    },
    completionNotes: {
      type: String,
      trim: true
    },
    materials: [MaterialSchema],
    labor: [LaborSchema],
    servicePackages: [ServicePackageLineSchema],
    media: [MediaSchema],
    totalEstimate: {
      type: Number,
      min: 0,
      default: 0
    },
    totalActual: {
      type: Number,
      min: 0,
      default: 0
    },
    appointments: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment'
    }],
    assignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Technician'
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice'
    }
  },
  {
    timestamps: true
  }
);

// Indexes for faster queries
WorkOrderSchema.index({ property: 1 });
WorkOrderSchema.index({ customer: 1 });
WorkOrderSchema.index({ status: 1 });
WorkOrderSchema.index({ date: 1 });

// Virtual for materials cost calculation
WorkOrderSchema.virtual('materialsCost').get(function() {
  return this.materials.reduce((total, material) => {
    return total + (material.price * material.quantity);
  }, 0);
});

// Virtual for labor cost calculation
WorkOrderSchema.virtual('laborCost').get(function() {
  return this.labor.reduce((total, labor) => {
    const qty = labor.quantity || labor.hours || 0;
    return total + (qty * labor.rate);
  }, 0);
});

// Virtual for service packages cost calculation
WorkOrderSchema.virtual('servicePackagesCost').get(function() {
  return (this.servicePackages || []).reduce((total, pkg) => total + pkg.price, 0);
});

// Virtual for total cost calculation
WorkOrderSchema.virtual('totalCost').get(function() {
  return this.materialsCost + this.laborCost + this.servicePackagesCost;
});

// Pre-validate hook: migrate legacy labor data before validation runs
WorkOrderSchema.pre('validate', function(next) {
  if (this.labor && this.labor.length > 0) {
    this.labor.forEach(item => {
      if (item.quantity == null && item.hours != null) {
        item.quantity = item.hours;
      }
    });
  }
  next();
});

// Pre-save: track status change timestamp
WorkOrderSchema.pre('save', function(next) {
  if (this.isModified('status')) {
    this.statusChangedAt = new Date();
  }
  next();
});

// Method to update status
WorkOrderSchema.methods.updateStatus = function(newStatus, notes = '') {
  this.status = newStatus;
  return this.save();
};

const WorkOrder = mongoose.model('WorkOrder', WorkOrderSchema);

module.exports = WorkOrder;
