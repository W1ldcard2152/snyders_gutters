const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SettingsSchema = new Schema(
  {
    supplyMarkupPercentage: {
      type: Number,
      default: 20,
      min: 0
    },
    customVendors: {
      type: [String],
      default: [
        'Home Depot', 'Menards', "Lowe's", 'Grainger',
        'Amazon', 'SiteOne', 'Regional Gutter Supply'
      ]
    },
    customCategories: {
      type: [String],
      default: [
        'Gutter Cleaning', 'Pressure Washing', 'Gutter Guard Install',
        'Repair', 'Maintenance'
      ]
    },
    taskCategories: {
      type: [String],
      default: [
        'Equipment Maintenance', 'Drive Time', 'Material Pickup',
        'Training', 'Admin', 'Meeting'
      ]
    },
    inventoryCategories: {
      type: [String],
      default: [
        'Gutter Guards', 'Downspout Hardware', 'Fasteners & Sealants',
        'Cleaning Supplies', 'Pressure Wash Equipment', 'Miscellaneous'
      ]
    },
    packageTags: {
      type: [String],
      default: [
        'Cleaning Solution', 'Micro Guard', 'Gutter Spike',
        'Downspout Extension', 'Splash Block', 'End Cap'
      ]
    },
    showServiceAdvisorOnInvoice: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Singleton pattern — always returns the single settings document
SettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  } else {
    // Backfill defaults for fields added after initial document creation
    let needsSave = false;
    if (!settings.customVendors || settings.customVendors.length === 0) {
      settings.customVendors = [
        'Home Depot', 'Menards', "Lowe's", 'Grainger',
        'Amazon', 'SiteOne', 'Regional Gutter Supply'
      ];
      needsSave = true;
    }
    if (!settings.customCategories || settings.customCategories.length === 0) {
      settings.customCategories = [
        'Gutter Cleaning', 'Pressure Washing', 'Gutter Guard Install',
        'Repair', 'Maintenance'
      ];
      needsSave = true;
    }
    if (!settings.taskCategories || settings.taskCategories.length === 0) {
      settings.taskCategories = [
        'Equipment Maintenance', 'Drive Time', 'Material Pickup',
        'Training', 'Admin', 'Meeting'
      ];
      needsSave = true;
    }
    if (!settings.inventoryCategories || settings.inventoryCategories.length === 0) {
      settings.inventoryCategories = [
        'Gutter Guards', 'Downspout Hardware', 'Fasteners & Sealants',
        'Cleaning Supplies', 'Pressure Wash Equipment', 'Miscellaneous'
      ];
      needsSave = true;
    }
    if (!settings.packageTags || settings.packageTags.length === 0) {
      settings.packageTags = [
        'Cleaning Solution', 'Micro Guard', 'Gutter Spike',
        'Downspout Extension', 'Splash Block', 'End Cap'
      ];
      needsSave = true;
    }
    if (needsSave) await settings.save();
  }
  return settings;
};

const Settings = mongoose.model('Settings', SettingsSchema);

module.exports = Settings;
