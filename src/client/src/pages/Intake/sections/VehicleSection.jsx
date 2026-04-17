import React, { useState, useEffect } from 'react';
import { Formik, Form } from 'formik';
import * as Yup from 'yup';
import CustomerService from '../../../services/customerService';
import VehicleService from '../../../services/vehicleService';
import Button from '../../../components/common/Button';
import Input from '../../../components/common/Input';
import SelectInput from '../../../components/common/SelectInput';
import TextArea from '../../../components/common/TextArea';

const PropertySchema = Yup.object().shape({
  street: Yup.string().required('Street address is required'),
  city: Yup.string(),
  state: Yup.string(),
  zip: Yup.string(),
  propertyType: Yup.string(),
  notes: Yup.string(),
});

const propertyTypeOptions = [
  { value: '', label: 'Select type (optional)' },
  { value: 'residential', label: 'Residential' },
  { value: 'commercial', label: 'Commercial' },
];

const getDisplayAddress = (property) => {
  if (property.address?.street) {
    const parts = [property.address.street, property.address.city, property.address.state].filter(Boolean);
    return parts.join(', ');
  }
  // Backward-compat: flat address string from old Vehicle model
  if (typeof property.address === 'string' && property.address) return property.address;
  return `${property.year || ''} ${property.make || ''} ${property.model || ''}`.trim() || 'Unknown Property';
};

const VehicleSection = ({ customer, onSaved, onError }) => {
  const [properties, setProperties] = useState([]);
  const [isCreating, setIsCreating] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchProperties = async () => {
      if (!customer?._id) {
        setInitialLoading(false);
        return;
      }

      try {
        const response = await CustomerService.getCustomerVehicles(customer._id);
        setProperties(response.data.properties || response.data.vehicles || []);
      } catch (err) {
        console.error('Error fetching properties:', err);
        onError('Failed to load customer properties. Please try again.');
      } finally {
        setInitialLoading(false);
      }
    };

    fetchProperties();
  }, [customer?._id]);

  const handleCreateProperty = async (values, { setSubmitting }) => {
    try {
      setSaving(true);

      const propertyData = {
        customer: customer._id,
        address: {
          street: values.street,
          city: values.city,
          state: values.state,
          zip: values.zip,
        },
        propertyType: values.propertyType || 'residential',
        notes: values.notes,
      };

      const response = await VehicleService.createVehicle(propertyData);
      const saved = response.data.property || response.data.vehicle;
      onSaved(saved);
    } catch (err) {
      console.error('Error creating property:', err);
      onError('Failed to create property. Please try again.');
      setSubmitting(false);
    } finally {
      setSaving(false);
    }
  };

  if (isCreating) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium text-gray-900">Add New Property</h4>
            <p className="text-sm text-gray-600">
              For: <span className="font-medium">{customer?.name}</span>
            </p>
          </div>
          <Button onClick={() => setIsCreating(false)} variant="outline" size="sm">
            <i className="fas fa-arrow-left mr-2"></i>Back
          </Button>
        </div>

        <Formik
          initialValues={{ street: '', city: '', state: '', zip: '', propertyType: 'residential', notes: '' }}
          validationSchema={PropertySchema}
          onSubmit={handleCreateProperty}
        >
          {({ values, errors, touched, handleChange, handleBlur, isSubmitting }) => (
            <Form className="space-y-4">
              <Input
                label="Street Address"
                name="street"
                value={values.street}
                onChange={handleChange}
                onBlur={handleBlur}
                error={errors.street}
                touched={touched.street}
                required
                placeholder="123 Main St"
              />

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="col-span-2 md:col-span-1">
                  <Input
                    label="City"
                    name="city"
                    value={values.city}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    placeholder="City"
                  />
                </div>
                <Input
                  label="State"
                  name="state"
                  value={values.state}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  placeholder="OH"
                />
                <Input
                  label="Zip"
                  name="zip"
                  value={values.zip}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  placeholder="45701"
                />
              </div>

              <SelectInput
                label="Property Type"
                name="propertyType"
                options={propertyTypeOptions}
                value={values.propertyType}
                onChange={handleChange}
                onBlur={handleBlur}
              />

              <TextArea
                label="Notes"
                name="notes"
                value={values.notes}
                onChange={handleChange}
                onBlur={handleBlur}
                rows="2"
                placeholder="Any additional details about the property..."
              />

              <div className="flex justify-end pt-2">
                <Button type="submit" variant="primary" disabled={isSubmitting || saving}>
                  {isSubmitting || saving ? (
                    <><i className="fas fa-spinner fa-spin mr-2"></i>Creating Property...</>
                  ) : (
                    <><i className="fas fa-home mr-2"></i>Add Property & Continue</>
                  )}
                </Button>
              </div>
            </Form>
          )}
        </Formik>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-500">
          Properties for {customer?.name} ({properties.length})
        </h4>
        <Button onClick={() => setIsCreating(true)} variant="primary" size="sm">
          <i className="fas fa-plus mr-2"></i>New Property
        </Button>
      </div>

      {initialLoading ? (
        <div className="text-center py-6">
          <i className="fas fa-spinner fa-spin text-xl text-primary-600 mb-2"></i>
          <p className="text-gray-600 text-sm">Loading properties...</p>
        </div>
      ) : properties.length === 0 ? (
        <div className="text-center py-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
          <i className="fas fa-home text-2xl text-gray-400 mb-2"></i>
          <p className="text-gray-600 text-sm">No properties found for this customer.</p>
          <p className="text-xs text-gray-500">Click "New Property" to add one.</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {properties.map((property) => (
            <div
              key={property._id}
              onClick={() => onSaved(property)}
              className="bg-white p-3 rounded-lg border border-gray-200 hover:border-primary-300 hover:shadow-sm cursor-pointer transition-all duration-150 group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900 group-hover:text-primary-700">
                    {getDisplayAddress(property)}
                  </span>
                  {property.propertyType && (
                    <div className="text-sm text-gray-500 capitalize">
                      <i className="fas fa-home mr-1"></i>{property.propertyType}
                    </div>
                  )}
                </div>
                <i className="fas fa-arrow-right text-primary-600 opacity-0 group-hover:opacity-100 transition-opacity"></i>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default VehicleSection;
