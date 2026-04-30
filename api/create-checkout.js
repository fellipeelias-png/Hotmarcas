const Stripe = require('stripe');

const TIER_PRICES = {
  essencial:     process.env.STRIPE_PRICE_ESSENCIAL,
  profissional:  process.env.STRIPE_PRICE_PROFISSIONAL,
  premium:       process.env.STRIPE_PRICE_PREMIUM,
};

const TIER_NAMES = {
  essencial:    'Essencial',
  profissional: 'Profissional',
  premium:      'Premium',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tier } = req.body;

  if (!tier || !TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Plano inválido' });
  }

  const priceId = TIER_PRICES[tier];
  if (!priceId) {
    return res.status(500).json({ error: 'Plano não configurado' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.SITE_URL || 'https://hotmarcas.com.br';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    locale: 'pt-BR',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { tier, tierName: TIER_NAMES[tier] },
    success_url: `${siteUrl}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/#preco`,
    customer_email: undefined,
    billing_address_collection: 'auto',
  });

  res.status(200).json({ url: session.url });
};
