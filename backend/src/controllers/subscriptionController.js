const { prisma } = require('../config/prisma');
const {
  getLatestSubscriptionByUserId,
  isSubscriptionActive,
  toFeatureFlags,
} = require('../services/subscriptionService');

async function getMySubscription(req, res) {
  const subscription = await getLatestSubscriptionByUserId(req.user.id);

  if (!subscription) {
    return res.json({
      id: null,
      plan: null,
      planCode: null,
      planName: null,
      status: 'none',
      cycle: null,
      currentPeriodStart: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      isActive: false,
      features: {
        maxAccountsPerApp: 0,
        unlimitedProxies: false,
      },
      upgradeUrl: `${process.env.APP_WEB_URL}/pricing`,
    });
  }

  return res.json({
    id: subscription.id,
    plan: subscription.planCode,
    planCode: subscription.planCode,
    planName: subscription.plan ? subscription.plan.name : subscription.planCode,
    status: subscription.status,
    cycle: subscription.cycle,
    currentPeriodStart: subscription.currentPeriodStart,
    trialEndsAt: subscription.trialEndsAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    isActive: isSubscriptionActive(subscription),
    features: toFeatureFlags(subscription),
    upgradeUrl: `${process.env.APP_WEB_URL}/pricing`,
  });
}

async function registerDevice(req, res) {
  const { deviceId, appVersion, os } = req.body;

  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  await prisma.appDevice.upsert({
    where: {
      userId_deviceId: {
        userId: req.user.id,
        deviceId,
      },
    },
    update: {
      appVersion,
      os,
      lastSeenAt: new Date(),
    },
    create: {
      userId: req.user.id,
      deviceId,
      appVersion,
      os,
      lastSeenAt: new Date(),
    },
  });

  return res.json({ ok: true });
}

module.exports = {
  getMySubscription,
  registerDevice,
};
