const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const User = require('../models/User');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await User.findOne({ email: 'admin@snyderscrm.com' }).setOptions({ includeInactive: true });
  if (existing) {
    console.log('User already exists:', existing.email);
    process.exit(0);
  }

  const user = await User.create({
    name: 'Admin',
    email: 'admin@snyderscrm.com',
    password: 'admin12345',
    passwordConfirm: 'admin12345',
    role: 'admin',
    status: 'active'
  });

  console.log('Admin user created:', user.email, '| role:', user.role);
  process.exit(0);
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});
