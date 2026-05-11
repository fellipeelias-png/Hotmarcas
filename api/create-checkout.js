const Stripe = require('stripe');

const TIER_PRICES = {
  essencial:    process.env.STRIPE_PRICE_ESSENCIAL    || 'price_1TRwmgLH6uUPSAvWFvLlXWye',
  profissional: process.env.STRIPE_PRICE_PROFISSIONAL || 'price_1TRwn9LH6uUPSAvWeBIWbEJ9',
  premium:      process.env.STRIPE_PRICE_PREMIUM      || 'price_1TRwnQLH6uUPSAvWUXzSVh6l',
};

const TIER_NAMES = {
  essencial:    'Essencial',
  profissional: 'Profissional',
  premium:      'Premium',
};

const ALLOWED_AUDIENCES = [
  'home',
  'criadores',
  'criadores-espirituais',
  'ecommerce',
  'saas',
  'mei',
];

const ALLOWED_UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tier, audience, utms } = req.body || {};

  if (!tier || !TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Plano inválido' });
  }

  const priceId = TIER_PRICES[tier];
  if (!priceId) {
    return res.status(500).json({ error: 'Plano não configurado' });
  }

  const safeAudience = ALLOWED_AUDIENCES.includes(audience) ? audience : 'home';

  const utmMetadata = {};
  if (utms && typeof utms === 'object') {
    for (const key of ALLOWED_UTM_KEYS) {
      const v = utms[key];
      if (typeof v === 'string' && v.length > 0 && v.length <= 200) {
        utmMetadata[key] = v;
      }
    }
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.SITE_URL || 'https://hotmarcas.com.br';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    locale: 'pt-BR',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      tier,
      tierName: TIER_NAMES[tier],
      audience: safeAudience,
      ...utmMetadata,
    },
    success_url: `${siteUrl}/sucesso?session_id={CHECKOUT_SESSION_ID}&audience=${safeAudience}`,
    cancel_url: `${siteUrl}/#preco`,
    customer_email: undefined,
    billing_address_collection: 'auto',
  });

  res.status(200).json({ url: session.url });
};
